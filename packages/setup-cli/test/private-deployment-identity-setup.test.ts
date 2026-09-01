import { describe, expect, it, vi } from "vitest";

import type { CloudflareClient } from "../src/cloudflare/client";
import type { BrowserHandoffPrompt } from "../src/private-deployment/browser-handoff";
import { runPrivateIdentitySetup } from "../src/private-deployment/identity-setup";
import type { PrivateDeploymentState } from "../src/private-deployment/deployment-state";

const accountId = "a".repeat(32);
const now = new Date("2026-09-01T21:00:00.000Z");

const state = (mode: "email-code" | "company-login"): PrivateDeploymentState => ({
  schema_version: 1,
  deployment_id: "11111111-1111-4111-8111-111111111111",
  created_by_cli_version: "0.1.0-rc.12",
  last_written_by_cli_version: "0.1.0-rc.12",
  status: "incomplete",
  stage: "prerequisites-ready",
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
  registrar_authority_confirmed: true,
  sign_in_mode: mode,
  cloudflare: { account_id: accountId, account_name: "Example" },
  resources: { placement: "automatic" },
  checkpoints: {},
});

const promptWith = (answers: readonly string[]): { prompt: BrowserHandoffPrompt; output: string[] } => {
  const queue = [...answers];
  const output: string[] = [];
  return {
    prompt: { question: async () => queue.shift() ?? "3", write: (message) => output.push(message) },
    output,
  };
};

const clientWith = (providers: readonly unknown[]): CloudflareClient => ({
  request: vi.fn(async () => providers),
}) as unknown as CloudflareClient;

describe("private deployment identity setup", () => {
  it("plans OTP creation after approval and requires a bounded publisher audience", async () => {
    const result = await runPrivateIdentitySetup(state("email-code"), {
      client: clientWith([]),
      prompt: promptWith(["1", "example.com, engineering.example.com"]).prompt,
      openBrowser: vi.fn(),
      now: () => now,
    });
    expect(result.status).toBe("ready");
    expect(result.plan).toMatchObject({
      mode: "email-code",
      providerIds: [],
      providerAction: "create-after-approval",
      autoRedirectToIdentity: true,
      rules: [
        { kind: "domain", value: "example.com" },
        { kind: "domain", value: "engineering.example.com" },
      ],
    });
    expect(result.state.resources?.identity_provider_action).toBe("create-after-approval");
  });

  it("reuses OTP when present and stores no provider secret fields", async () => {
    const result = await runPrivateIdentitySetup(state("email-code"), {
      client: clientWith([{ id: "otp-one", name: "One-time PIN", type: "onetimepin", config: { secret: "hidden" } }]),
      prompt: promptWith(["2", "admin@example.com"]).prompt,
      openBrowser: vi.fn(),
      now: () => now,
    });
    expect(result.plan?.providerIds).toEqual(["otp-one"]);
    expect(JSON.stringify(result.state)).not.toContain("hidden");
  });

  it("selects one or several existing company providers by stable number", async () => {
    const result = await runPrivateIdentitySetup(state("company-login"), {
      client: clientWith([
        { id: "provider-z", name: "Okta", type: "okta" },
        { id: "provider-a", name: "Google Workspace", type: "google" },
      ]),
      prompt: promptWith(["1,2"]).prompt,
      openBrowser: vi.fn(),
      now: () => now,
    });
    expect(result.plan).toMatchObject({
      providerIds: ["provider-a", "provider-z"],
      autoRedirectToIdentity: false,
      rules: [{ kind: "authenticated", value: "selected-providers" }],
    });
  });

  it("hands missing company-provider setup to Cloudflare without collecting credentials", async () => {
    const interaction = promptWith(["3"]);
    const result = await runPrivateIdentitySetup(state("company-login"), {
      client: clientWith([]),
      prompt: interaction.prompt,
      openBrowser: vi.fn(),
      now: () => now,
    });
    expect(result.status).toBe("saved");
    expect(interaction.output.join("\n")).toContain("Provider credentials stay in Cloudflare");
  });
});
