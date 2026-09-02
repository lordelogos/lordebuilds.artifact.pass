import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runPrivateDeploymentApproval } from "../src/private-deployment/deployment-approval";
import { DeploymentMutationError } from "../src/cloudflare/deployment";
import {
  createPrivateDeploymentState,
  writePrivateDeploymentState,
} from "../src/private-deployment/deployment-state";
import type { PrivateDeploymentAuthorizationSession } from "../src/private-deployment/deployment-authorization";

const deploymentId = "11111111-1111-4111-8111-111111111111";
const cliVersion = "0.1.0-rc.12";

const readyState = async (root: string) => {
  const initial = await createPrivateDeploymentState({ root, cliVersion, createId: () => deploymentId });
  return writePrivateDeploymentState(root, {
    ...initial,
    stage: "retention-ready",
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
      workers_subdomain_action: "reuse",
      identity_mode: "email-code",
      identity_provider_ids: JSON.stringify(["otp-id"]),
      identity_provider_action: "reuse",
      access_auto_redirect: "true",
      access_identity_rules: JSON.stringify([{ kind: "domain", value: "example.com" }]),
    },
    retention_seconds: [900, 3600],
    checkpoints: {
      ...initial.checkpoints,
      "cloudflare-authorized": {
        proven_at: initial.created_at,
        evidence: {
          source: "oauth",
          client_environment: "staging",
          profile: "emailCode",
          granted_scopes: ["zone.read"],
          persisted: true,
        },
      },
      "identity-ready": {
        proven_at: initial.created_at,
        evidence: { provider_display_digest: createHash("sha256").update("otp-id").digest("hex") },
      },
    },
  }, cliVersion);
};

const authorization: PrivateDeploymentAuthorizationSession = {
  persisted: true,
  source: "oauth",
  client: { environment: "staging", clientId: "a".repeat(32) },
  profile: "emailCode",
  grantedScopes: ["zone.read"],
  resolveAccessToken: async () => "x".repeat(40),
  close: async () => undefined,
};

describe("private deployment approval flow", () => {
  it("writes a read-only approval first, then deploys and seals a receipt", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-approval-test-"));
    const state = await readyState(root);
    const answers = ["1", "1"];
    const runDeploy = vi.fn(async (input: { readonly writeApprovalManifest?: string }) => {
      if (input.writeApprovalManifest !== undefined) {
        await writeFile(input.writeApprovalManifest, JSON.stringify({ version: 3, binding: { stable: true } }));
        return {
          baseUrl: "https://artifacts.example.com",
          teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
          plan: [],
          changed: [],
          approvalManifest: input.writeApprovalManifest,
        };
      }
      return {
        baseUrl: "https://artifacts.example.com",
        teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
        plan: [],
        changed: ["D1 database", "R2 bucket", "Worker deployment"],
        resources: { d1_database_id: "db-id", r2_bucket_name: "artifactpass-11111111" },
        verification: {
          health: "passed" as const,
          protectedUpload: "passed" as const,
          verifiedAt: "2026-09-01T12:00:00.000Z",
        },
      };
    });
    const result = await runPrivateDeploymentApproval(state, {
      root,
      cliVersion,
      deploymentRoot: root,
      authorization,
      prompt: {
        question: async () => answers.shift() ?? "1",
        write: vi.fn(),
      },
      runDeploy: runDeploy as never,
    });
    expect(runDeploy).toHaveBeenCalledTimes(2);
    expect(runDeploy.mock.calls[0]?.[0]).toMatchObject({ writeApprovalManifest: expect.any(String) });
    expect(runDeploy.mock.calls[1]?.[0]).toMatchObject({ approveManifest: expect.any(String) });
    expect(result.action).toBe("complete");
    expect(result.state.status).toBe("complete");
    expect(result.receiptPath).toContain(`${deploymentId}.json`);
  });

  it("saves an approval without running any mutation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-approval-save-test-"));
    const state = await readyState(root);
    const answers = ["1", "2"];
    const runDeploy = vi.fn(async (input: { readonly writeApprovalManifest?: string }) => {
      await writeFile(input.writeApprovalManifest as string, JSON.stringify({ version: 3, binding: {} }));
      return {
        baseUrl: "https://artifacts.example.com",
        teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
        plan: [],
        changed: [],
      };
    });
    const result = await runPrivateDeploymentApproval(state, {
      root,
      cliVersion,
      deploymentRoot: root,
      authorization,
      prompt: { question: async () => answers.shift() ?? "2", write: vi.fn() },
      runDeploy: runDeploy as never,
    });
    expect(result.action).toBe("saved");
    expect(result.state.stage).toBe("approval-ready");
    expect(runDeploy).toHaveBeenCalledTimes(1);
  });

  it("invalidates drifted approval without claiming that deployment mutation started", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-approval-drift-test-"));
    const state = await readyState(root);
    const answers = ["1", "1"];
    const runDeploy = vi.fn(async (input: { readonly writeApprovalManifest?: string }) => {
      if (input.writeApprovalManifest !== undefined) {
        await writeFile(input.writeApprovalManifest, JSON.stringify({ version: 3, binding: {} }));
        return {
          baseUrl: "https://artifacts.example.com",
          teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
          plan: [],
          changed: [],
        };
      }
      throw new Error("Hosted approval manifest no longer matches the deployment bundle or Cloudflare state");
    });
    const result = await runPrivateDeploymentApproval(state, {
      root,
      cliVersion,
      deploymentRoot: root,
      authorization,
      prompt: { question: async () => answers.shift() ?? "1", write: vi.fn() },
      runDeploy: runDeploy as never,
    });
    expect(result.action).toBe("approval-invalidated");
    expect(result.state.stage).toBe("specification-ready");
    expect(result.state.approval).toBeUndefined();
    expect(result.state.checkpoints["approval-invalidated"]?.evidence.mutation_started).toBe(false);
  });

  it("records exact containment when a deployment fails after mutation starts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-approval-failure-test-"));
    const state = await readyState(root);
    const answers = ["1", "1"];
    const runDeploy = vi.fn(async (input: { readonly writeApprovalManifest?: string }) => {
      if (input.writeApprovalManifest !== undefined) {
        await writeFile(input.writeApprovalManifest, JSON.stringify({ version: 3, binding: {} }));
        return {
          baseUrl: "https://artifacts.example.com",
          teamCommand: "pnpm dlx artifactpass --base-url https://artifacts.example.com",
          plan: [],
          changed: [],
        };
      }
      throw new DeploymentMutationError(
        "Worker verification failed",
        ["D1 database", "R2 bucket"],
        { d1_database_id: "db-id", r2_bucket_name: "artifactpass-11111111" },
        new Error("unavailable"),
        ["R2 bucket"],
      );
    });
    const result = await runPrivateDeploymentApproval(state, {
      root,
      cliVersion,
      deploymentRoot: root,
      authorization,
      prompt: { question: async () => answers.shift() ?? "1", write: vi.fn() },
      runDeploy: runDeploy as never,
    });
    expect(result.action).toBe("repair-required");
    expect(result.state.stage).toBe("repair-required");
    expect(result.state.checkpoints["deployment-failure"]?.evidence).toMatchObject({
      changed: ["D1 database", "R2 bucket"],
      rolled_back: ["R2 bucket"],
      rollback_failures: [],
      resources: { d1_database_id: "db-id" },
    });
  });
});
