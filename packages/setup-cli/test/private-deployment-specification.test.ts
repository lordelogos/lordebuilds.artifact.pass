import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compilePrivateDeploymentSpecification,
  deploymentInputFromPrivateSpecification,
  privateDeploymentSpecificationDigest,
} from "../src/private-deployment/deployment-specification";
import type { PrivateDeploymentState } from "../src/private-deployment/deployment-state";

const instant = "2026-09-01T12:00:00.000Z";
const deploymentId = "11111111-1111-4111-8111-111111111111";
const state = (): PrivateDeploymentState => ({
  schema_version: 1,
  deployment_id: deploymentId,
  created_by_cli_version: "0.1.0-rc.12",
  last_written_by_cli_version: "0.1.0-rc.12",
  status: "incomplete",
  stage: "retention-ready",
  created_at: instant,
  updated_at: instant,
  sign_in_mode: "email-code",
  cloudflare: {
    account_id: "a".repeat(32),
    account_name: "Example",
    zone_id: "b".repeat(32),
    zone_name: "example.com",
  },
  resources: {
    placement: "automatic",
    workers_subdomain: "example-artifactpass",
    workers_subdomain_action: "create-after-approval",
    identity_mode: "email-code",
    identity_provider_ids: "[]",
    identity_provider_action: "create-after-approval",
    access_auto_redirect: "true",
    access_identity_rules: JSON.stringify([{ kind: "domain", value: "example.com" }]),
  },
  retention_seconds: [900, 3600, 604_800],
  checkpoints: {
    started: { proven_at: instant, evidence: { state_initialized: true } },
    "cloudflare-authorized": {
      proven_at: instant,
      evidence: {
        source: "oauth",
        client_environment: "staging",
        profile: "emailCode",
        granted_scopes: ["zone.read", "workers.write"],
        persisted: true,
      },
    },
    "identity-ready": {
      proven_at: instant,
      evidence: { provider_display_digest: createHash("sha256").update("[]").digest("hex") },
    },
  },
});

describe("private deployment specification", () => {
  it("compiles every non-secret deployment choice into a stable contract", () => {
    const specification = compilePrivateDeploymentSpecification(state());
    expect(specification).toMatchObject({
      version: 1,
      deployment_id: deploymentId,
      hostname: "artifacts.example.com",
      service_name: "artifactpass-11111111",
      placement: "automatic",
      identity: {
        mode: "email-code",
        provider_action: "create-after-approval",
        provider_ids: [],
      },
      retention: {
        allowed_expiry_seconds: [900, 3600, 604_800],
        maximum_expiry_seconds: 604_800,
        lifecycle_rule_id: "artifactpass-managed-retention",
      },
    });
    expect(privateDeploymentSpecificationDigest(specification)).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(specification)).not.toMatch(/token|secret|private_key/iu);
  });

  it("turns the specification into an approval-only deploy input", () => {
    const specification = compilePrivateDeploymentSpecification(state());
    const input = deploymentInputFromPrivateSpecification(specification, {
      dryRun: false,
      writeApprovalManifest: "/tmp/approval.json",
    });
    expect(input).toMatchObject({
      deploymentId,
      hostname: "artifacts.example.com",
      workersSubdomainAction: "create-after-approval",
      privateAccess: {
        providerAction: "create-after-approval",
        allowedIdpIds: [],
      },
    });
    expect(input.pdfKeyId).toBeUndefined();
  });

  it("rejects a hostname outside the selected domain", () => {
    expect(() => compilePrivateDeploymentSpecification(state(), { hostname: "artifacts.foreign.com" }))
      .toThrow("must belong to the selected Cloudflare domain");
  });
});
