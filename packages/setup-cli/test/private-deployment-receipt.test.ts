import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPrivateDeploymentReceipt,
  validatePrivateDeploymentReceipt,
  writePrivateDeploymentReceipt,
} from "../src/private-deployment/deployment-receipt";
import type { PrivateDeploymentSpecification } from "../src/private-deployment/deployment-specification";

const specification = {
  version: 1,
  deployment_id: "11111111-1111-4111-8111-111111111111",
  account_id: "a".repeat(32),
  zone_id: "b".repeat(32),
  zone_name: "example.com",
  hostname: "artifacts.example.com",
  service_name: "artifactpass-11111111",
  placement: "automatic",
  workers_subdomain: "example-artifactpass",
  workers_subdomain_action: "reuse",
  identity: {
    mode: "email-code",
    provider_ids: ["otp-id"],
    provider_action: "reuse",
    provider_display_digest: "c".repeat(64),
    auto_redirect: true,
    rules: [{ kind: "domain", value: "example.com" }],
  },
  retention: {
    allowed_expiry_seconds: [900, 3600],
    maximum_expiry_seconds: 3600,
    lifecycle_rule_id: "artifactpass-managed-retention",
    lifecycle: { rules: [] },
  },
  authorization: {
    source: "oauth",
    client_environment: "staging",
    profile: "emailCode",
    granted_scopes: ["zone.read"],
  },
} satisfies PrivateDeploymentSpecification;

describe("private deployment receipt", () => {
  it("writes one redacted 0600 receipt only after hosted verification", async () => {
    const receipt = createPrivateDeploymentReceipt(specification, {
      baseUrl: "https://artifacts.example.com",
      teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
      plan: [],
      changed: [],
      resources: { d1_database_id: "db-id", r2_bucket_name: "artifactpass-11111111" },
      verification: {
        health: "passed",
        protectedUpload: "passed",
        verifiedAt: "2026-09-01T12:00:00.000Z",
      },
    }, new Date("2026-09-01T12:00:01.000Z"));
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-receipt-test-"));
    const path = await writePrivateDeploymentReceipt(root, receipt);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(receipt)).not.toMatch(/access_token|refresh_token|\/a\//u);
  });

  it("refuses an unverified deployment result", () => {
    expect(() => createPrivateDeploymentReceipt(specification, {
      baseUrl: "https://artifacts.example.com",
      teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
      plan: [],
      changed: [],
    })).toThrow("requires successful hosted verification");
  });

  it("rejects capability links and absolute local paths", () => {
    const receipt = createPrivateDeploymentReceipt(specification, {
      baseUrl: "https://artifacts.example.com",
      teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
      plan: [],
      changed: [],
      verification: { health: "passed", protectedUpload: "passed", verifiedAt: "2026-09-01T12:00:00.000Z" },
    });
    expect(() => validatePrivateDeploymentReceipt({
      ...receipt,
      resources: { receipt: "/Users/example/credential.json" },
    })).toThrow("unsafe value");
  });
});
