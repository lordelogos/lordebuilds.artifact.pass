import { readFile } from "node:fs/promises";

import { DEFAULT_EXPIRY_POLICY } from "artifact-protocol";
import { describe, expect, it, vi } from "vitest";

import type { BrowserHandoffPrompt } from "../src/private-deployment/browser-handoff";
import type { PrivateDeploymentState } from "../src/private-deployment/deployment-state";
import {
  runPrivateRetentionSetup,
  storageLifecycleForMaximumExpiry,
  validatePrivateRetentionPresets,
} from "../src/private-deployment/retention";

const now = new Date("2026-09-01T22:00:00.000Z");
const state: PrivateDeploymentState = {
  schema_version: 1,
  deployment_id: "11111111-1111-4111-8111-111111111111",
  created_by_cli_version: "0.1.0-rc.12",
  last_written_by_cli_version: "0.1.0-rc.12",
  status: "incomplete",
  stage: "identity-ready",
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
  registrar_authority_confirmed: true,
  sign_in_mode: "company-login",
  checkpoints: {},
};

const promptWith = (answer: string): BrowserHandoffPrompt => ({
  question: async () => answer,
  write: () => undefined,
});

describe("private deployment retention", () => {
  it("records an ordered subset and derives lifecycle strictly after the maximum", async () => {
    const result = await runPrivateRetentionSetup(state, promptWith("1,3,4,5"), () => now);
    expect(result.state.retention_seconds).toEqual([900, 3600, 86_400, 604_800]);
    expect(result.state.stage).toBe("retention-ready");
    expect(result.maximumExpirySeconds).toBe(604_800);
    expect(result.lifecycle.rules).toEqual([expect.objectContaining({
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 691_200 } },
    })]);
  });

  it("maps structured retention selections to sorted expiry values", async () => {
    const question = vi.fn(async () => {
      throw new Error("plain text prompt should not be used");
    });
    const result = await runPrivateRetentionSetup(state, {
      question,
      write: vi.fn(),
      multiselect: vi.fn(async () => [4, 0, 2]),
    }, () => now);

    expect(result.state.retention_seconds).toEqual([900, 3600, 604_800]);
    expect(question).not.toHaveBeenCalled();
  });

  it("rejects empty, duplicate, unordered, unsupported, and over-seven-day values", () => {
    for (const values of [[], [900, 900], [3600, 900], [7200], [691_200]]) {
      expect(() => validatePrivateRetentionPresets(values)).toThrow("Private expiry presets");
    }
  });

  it("rounds the one-day safety margin upward to Cloudflare lifecycle units", () => {
    expect(storageLifecycleForMaximumExpiry(900).rules).toEqual([expect.objectContaining({
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 172_800 } },
    })]);
  });

  it("keeps the checked-in public lifecycle aligned with the public maximum", async () => {
    const lifecyclePath = new URL(
      "../../../apps/artifact-service/storage-lifecycle.json",
      import.meta.url,
    );
    const lifecycle = JSON.parse(await readFile(lifecyclePath, "utf8"));

    expect(lifecycle).toEqual(
      storageLifecycleForMaximumExpiry(DEFAULT_EXPIRY_POLICY.maximum_seconds),
    );
  });
});
