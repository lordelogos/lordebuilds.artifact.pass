import { describe, expect, it, vi } from "vitest";

import type { CloudflareClient } from "../src/cloudflare/client";
import {
  renderPrivateDeploymentDoctor,
  runPrivateDeploymentDoctor,
  type DeploymentDoctorDependencies,
} from "../src/commands/deployment-doctor";
import type { CloudflarePrerequisiteSnapshot } from "../src/cloudflare/discovery";
import type { PrivateDeploymentState } from "../src/private-deployment/deployment-state";

const timestamp = "2026-09-01T12:00:00.000Z";
const future = "2026-09-01T14:00:00.000Z";

const completeState = (): PrivateDeploymentState => ({
  schema_version: 1,
  deployment_id: "11111111-1111-4111-8111-111111111111",
  created_by_cli_version: "0.1.0-rc.12",
  last_written_by_cli_version: "0.1.0-rc.12",
  status: "complete",
  stage: "complete",
  created_at: timestamp,
  updated_at: timestamp,
  hostname: "artifacts.example.com",
  service_name: "artifactpass-private-11111111",
  sign_in_mode: "email-code",
  cloudflare: {
    account_id: "a".repeat(32),
    account_name: "Example",
    zone_id: "b".repeat(32),
    zone_name: "example.com",
  },
  resources: {
    d1_database_id: "c".repeat(32),
    r2_bucket_name: "artifactpass-private-11111111",
    access_application_id: "d".repeat(32),
    access_policy_id: "e".repeat(32),
    identity_provider_id: "f".repeat(32),
    worker_service: "artifactpass-private-11111111",
    deployment_receipt_path: "/redacted/local/receipt.json",
  },
  retention_seconds: [900, 3600, 86_400],
  checkpoints: {
    started: { proven_at: timestamp, evidence: { state_initialized: true } },
    "hosted-verification": {
      proven_at: timestamp,
      evidence: { health: "passed", protected_upload: "passed" },
    },
  },
});

const readyPrerequisites = (): CloudflarePrerequisiteSnapshot => ({
  d1: { status: "ready", evidence: { accessible: true } },
  r2: { status: "ready", evidence: { accessible: true } },
  zeroTrust: { status: "ready", evidence: { accessible: true } },
  workersSubdomain: { status: "ready", evidence: { accessible: true } },
});

const browserFetch = (deploymentId = completeState().deployment_id): typeof globalThis.fetch =>
  vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/health") return Response.json({ status: "ok", deployment_id: deploymentId });
    if (path === "/session/status") return Response.json({
      deployment_mode: "private",
      policy: { expiry: { allowed_seconds: [900, 3600, 86_400] } },
    });
    if (path === "/upload") return new Response(null, { status: 302, headers: { location: "https://access.example" } });
    return new Response(null, { status: 404 });
  });

const dependencies = (
  overrides: Partial<DeploymentDoctorDependencies> = {},
): DeploymentDoctorDependencies => {
  const client = {
    verifyToken: vi.fn().mockResolvedValue({ status: "active" }),
    request: vi.fn().mockResolvedValue({}),
  } as unknown as CloudflareClient;
  return {
    authorizationStatus: vi.fn().mockResolvedValue({
      connected: true,
      profile: "emailCode",
      granted_scopes: ["access.write"],
      expires_at: future,
      refresh_available: true,
    }),
    accessTokenForInspection: vi.fn().mockResolvedValue("x".repeat(40)),
    createClient: () => client,
    inspectPrerequisites: vi.fn().mockResolvedValue(readyPrerequisites()),
    listZones: vi.fn().mockResolvedValue([{
      id: "b".repeat(32),
      account_id: "a".repeat(32),
      name: "example.com",
      status: "active",
      name_servers: [],
    }]),
    fetch: browserFetch(),
    receiptExists: vi.fn().mockResolvedValue(true),
    now: () => new Date(timestamp),
    ...overrides,
  };
};

describe("private deployment doctor", () => {
  it("classifies a healthy deployment without exposing credentials or capability links", async () => {
    const result = await runPrivateDeploymentDoctor(completeState(), dependencies());
    expect(result.classification).toBe("healthy");
    expect(Object.values(result.checks).every((check) => check.status === "passed")).toBe(true);
    const rendered = renderPrivateDeploymentDoctor(result);
    expect(rendered).not.toContain("x".repeat(40));
    expect(rendered).not.toMatch(/\/a\/[A-Za-z0-9_-]+/u);
  });

  it.each([
    ["incomplete", { status: "incomplete", stage: "retention-ready" }],
    ["repair-required", { status: "incomplete", stage: "repair-required" }],
    ["conflict", { status: "abandoned", stage: "started" }],
  ] as const)("classifies %s local state", async (classification, change) => {
    const result = await runPrivateDeploymentDoctor({ ...completeState(), ...change }, dependencies());
    expect(result.classification).toBe(classification);
  });

  it("classifies missing or expired authorization without querying Cloudflare resources", async () => {
    const createClient = vi.fn();
    const result = await runPrivateDeploymentDoctor(completeState(), dependencies({
      authorizationStatus: vi.fn().mockResolvedValue({ connected: false }),
      accessTokenForInspection: vi.fn().mockResolvedValue(null),
      createClient,
    }));
    expect(result.classification).toBe("authorization-required");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("classifies a pending Cloudflare prerequisite", async () => {
    const result = await runPrivateDeploymentDoctor(completeState(), dependencies({
      inspectPrerequisites: vi.fn().mockResolvedValue({
        ...readyPrerequisites(),
        r2: { status: "pending", message: "R2 setup is pending" },
      }),
    }));
    expect(result.classification).toBe("prerequisite-pending");
  });

  it("classifies missing remote resources as drift without mutating them", async () => {
    const client = {
      verifyToken: vi.fn().mockResolvedValue({ status: "active" }),
      request: vi.fn().mockRejectedValue(new Error("not found")),
    } as unknown as CloudflareClient;
    const result = await runPrivateDeploymentDoctor(completeState(), dependencies({
      createClient: () => client,
    }));
    expect(result.classification).toBe("drifted");
    expect(client.request).toHaveBeenCalled();
  });

  it("classifies a mismatched Worker deployment as verification failed", async () => {
    const result = await runPrivateDeploymentDoctor(completeState(), dependencies({
      fetch: browserFetch("22222222-2222-4222-8222-222222222222"),
    }));
    expect(result.classification).toBe("verification-failed");
    expect(result.checks.worker_health.status).toBe("failed");
  });
});
