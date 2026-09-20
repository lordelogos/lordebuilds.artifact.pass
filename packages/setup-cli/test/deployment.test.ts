import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CloudflareApiError, CloudflareClient } from "../src/cloudflare/client";
import { createCloudflareProcessRunner, runDeployCommand } from "../src/commands/deploy";
import type { ProcessRunner } from "../src/process";
import {
  deployArtifactShare,
  describeCloudflareFailure,
  deploymentPlan,
  DeploymentMutationError,
  type DeployInput,
} from "../src/cloudflare/deployment";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const testMigrationNames = [
  "0001-migration-1.sql",
  "0002-migration-2.sql",
  "0003-migration-3.sql",
  "0004-migration-4.sql",
  "0005-migration-5.sql",
  "0006-migration-6.sql",
  "0007-public-auth.sql",
  "0008-private-deployment.sql",
  "0009-cleanup-indexes.sql",
] as const;
const input: DeployInput = {
  accountId,
  zoneId,
  hostname: "artifacts.example.com",
  identities: [{ kind: "domain", value: "example.com" }],
  pdfKeyId: "test-key",
  pdfPublicKey: `${"A".repeat(43)}=`,
  workersSubdomain: "artifact-share-test",
  dryRun: false,
};

const privateInput = (): Omit<DeployInput, "pdfKeyId" | "pdfPublicKey"> => {
  const { pdfKeyId: _pdfKeyId, pdfPublicKey: _pdfPublicKey, ...remaining } = input;
  return remaining;
};

const deploymentRoot = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "artifact-share-deployment-test-"));
  await mkdir(resolve(root, "migrations"));
  for (const name of testMigrationNames) {
    await writeFile(resolve(root, "migrations", name), "SELECT 1;\n");
  }
  await writeFile(resolve(root, "wrangler-template.json"), JSON.stringify({
    name: "template",
    main: "./index.js",
    assets: { directory: "./client" },
    vars: {},
    d1_databases: [{}],
    r2_buckets: [{}],
  }));
  await writeFile(resolve(root, "storage-lifecycle.json"), "{}");
  return root;
};

const fakeClient = (options: {
  collision?: boolean;
  existing?: boolean;
  forbidden?: boolean;
  failR2?: boolean;
  hostname?: string;
  policyDecision?: string;
  allowedIdps?: readonly string[];
  autoRedirect?: boolean;
  remoteState?: { workerVersion: string; schemaVersion: string; lifecycleVersion: string };
  serviceName?: string;
  ownershipDeploymentId?: string;
  appliedMigrations?: readonly string[];
  workersDevEnabled?: boolean;
  previewUrlsEnabled?: boolean;
  workerRoutes?: readonly { readonly id: string; readonly pattern: string; readonly script?: string }[];
} = {}) => {
  const hostname = options.hostname ?? "artifacts.example.com";
  const serviceName = options.serviceName ?? "lordebuilds-artifacts-share";
  const requests: { path: string; init: RequestInit }[] = [];
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init });
    if (options.forbidden && path.includes("/d1/")) {
      const error = new Error("forbidden") as Error & { status: number };
      error.status = 403;
      throw error;
    }
    if (path === "/user/tokens/verify") return { status: "active" };
    if (path.endsWith("/workers/subdomain") && init.method === "PUT") {
      return { subdomain: "artifact-share-test" };
    }
    if (path.endsWith("/workers/subdomain")) return { subdomain: "artifact-share-test" };
    if (path.endsWith("/workers/scripts")) return options.existing ? [{
      id: serviceName,
      modified_on: options.remoteState?.workerVersion ?? "worker-v1",
    }] : [];
    if (path.endsWith(`/workers/scripts/${serviceName}/subdomain`)) {
      return {
        enabled: options.workersDevEnabled ?? false,
        previews_enabled: options.previewUrlsEnabled ?? false,
      };
    }
    if (path === `/zones/${zoneId}/workers/routes`) return options.workerRoutes ?? [];
    if (path === `/zones/${zoneId}`) return { name: "example.com", status: "active" };
    if (path.includes("/d1/database?")) return options.existing ? [{ uuid: "db-id", name: serviceName }] : [];
    if (path.endsWith("/d1/database")) return { uuid: "db-id", name: serviceName };
    if (path.endsWith("/r2/buckets") && init.method !== "POST") {
      return { buckets: options.existing ? [{ name: serviceName }] : [] };
    }
    if (path.endsWith("/r2/buckets") && init.method === "POST" && options.failR2 === true) {
      throw new Error("R2 provisioning failed");
    }
    if (path.includes("/d1/database/db-id/query")) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) as { readonly sql?: string } : {};
      if (body.sql?.includes("d1_migrations")) {
        return [{ results: (options.appliedMigrations ?? testMigrationNames.slice(0, 8)).map((name) => ({ name })) }];
      }
      if (body.sql?.includes("deployment_metadata")) {
        return [{
          results: options.ownershipDeploymentId === undefined ? [] : [{
            deployment_id: options.ownershipDeploymentId,
            manifest_digest: "d".repeat(64),
            account_id: accountId,
            zone_id: zoneId,
            hostname,
            service_name: serviceName,
          }],
        }];
      }
      return [{ results: [{ name: "artifacts", type: "table", sql: options.remoteState?.schemaVersion ?? "schema-v1" }] }];
    }
    if (path.endsWith(`/r2/buckets/${serviceName}/lifecycle`)) return {
      rules: [{ id: options.remoteState?.lifecycleVersion ?? "lifecycle-v1" }],
    };
    if (path.endsWith("/access/organizations")) return { auth_domain: "team.cloudflareaccess.com" };
    if (path.endsWith("/access/identity_providers") && init.method !== "POST") return [];
    if (path.endsWith("/access/identity_providers") && init.method === "POST") {
      return { id: "otp-provider-id", name: "ArtifactPass email code", type: "onetimepin" };
    }
    if (path.endsWith("/access/apps") && init.method !== "POST") {
      return options.existing ? [{
        id: "app-id",
        name: serviceName,
        aud: "audience",
        destinations: [
          { type: "public", uri: `${hostname}/upload*` },
          { type: "public", uri: `${hostname}/connect/approve*` },
        ],
        ...(options.allowedIdps === undefined ? {} : { allowed_idps: options.allowedIdps }),
        ...(options.autoRedirect === undefined ? {} : { auto_redirect_to_identity: options.autoRedirect }),
      }] : [];
    }
    if (path.endsWith("/access/apps") && init.method === "POST") {
      return { id: "app-id", name: serviceName, aud: "audience" };
    }
    if (path.endsWith("/policies")) {
      return options.existing ? [{
        id: "policy-id",
        name: "Artifact Share uploaders",
        decision: options.policyDecision ?? "allow",
        include: [{ email_domain: { domain: "example.com" } }],
      }] : [];
    }
    if (path.endsWith("/workers/domains")) {
      return options.collision
        ? [{ hostname, service: "other" }]
        : options.existing ? [{ hostname, service: serviceName }] : [];
    }
    return {};
  });
  return {
    client: { request, verifyToken: () => request("/user/tokens/verify") } as unknown as CloudflareClient,
    requests,
  };
};

describe("Cloudflare deployment", () => {
  it("uses the versioned Cloudflare API origin and bearer authentication", async () => {
    const fetch = vi.fn(async (_request: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      success: true,
      result: { status: "active" },
    })));
    const client = new CloudflareClient({ token: "cloudflare-secret", fetch });
    await client.verifyToken();
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const [request, init] = call ?? ["", undefined];
    expect(String(request)).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cloudflare-secret");
  });

  it("accepts a Wrangler OAuth credential after an authenticated user lookup", async () => {
    const fetch = vi.fn(async (request: string | URL | Request) => {
      if (String(request).endsWith("/user/tokens/verify")) {
        return Response.json({
          success: false,
          result: null,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        }, { status: 400 });
      }
      return Response.json({ success: true, result: { id: "user-id" } });
    });
    const client = new CloudflareClient({ token: "wrangler-oauth", fetch });

    await expect(client.verifyToken()).resolves.toEqual({ status: "active" });
    expect(fetch.mock.calls.map(([request]) => String(request))).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      "https://api.cloudflare.com/client/v4/user",
    ]);
  });

  it("retries bounded read-only Cloudflare API failures but never retries a mutation", async () => {
    const sleep = vi.fn(async () => undefined);
    const readFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: false, result: null }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: "zone" } }));
    const readClient = new CloudflareClient({ token: "cloudflare-secret", fetch: readFetch, sleep });
    await expect(readClient.request("/zones")).resolves.toEqual({ id: "zone" });
    expect(readFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);

    const mutationFetch = vi.fn(async () => Response.json({ success: false, result: null }, { status: 503 }));
    const mutationClient = new CloudflareClient({ token: "cloudflare-secret", fetch: mutationFetch, sleep });
    await expect(mutationClient.request("/zones", { method: "POST" })).rejects.toMatchObject({ status: 503 });
    expect(mutationFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves Cloudflare pagination metadata for fail-closed inspectors", async () => {
    const fetch = vi.fn(async () => Response.json({
      success: true,
      result: [{ id: "first" }],
      result_info: { cursor: "next-page", is_truncated: true, per_page: 1 },
    }));
    const client = new CloudflareClient({ token: "cloudflare-secret", fetch });

    await expect(client.requestPage<readonly { readonly id: string }[]>("/objects"))
      .resolves.toEqual({
        result: [{ id: "first" }],
        resultInfo: { cursor: "next-page", is_truncated: true, per_page: 1 },
      });
  });

  it("turns permission denials into the least-privilege checklist", () => {
    const message = describeCloudflareFailure(new CloudflareApiError("forbidden", 403));
    expect(message).toContain("Workers Scripts Write");
    expect(message).toContain("Access: Apps and Policies Write");
    expect(message).toContain("Access: Organizations, Identity Providers, and Groups Read");
  });

  it("plans a complete deployment without mutations or credentials", async () => {
    const client = fakeClient();
    const result = await deployArtifactShare({ ...input, dryRun: true }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner: vi.fn(),
    });
    expect(result.plan).toHaveLength(7);
    expect(result.plan[3]).toContain("prepare the Worker configuration");
    expect(result.plan[4]).toContain("apply D1 migrations");
    expect(result.plan[5]).toContain("deploy the Worker");
    expect(result.changed).toEqual([]);
    expect(client.requests).toEqual([]);
    expect(result.teamCommand).toContain("--base-url https://artifacts.example.com");
  });

  it("runs the command-level dry-run without credentials, processes, or network calls", async () => {
    const runner = vi.fn();
    const fetch = vi.fn();
    const result = await runDeployCommand({ ...input, dryRun: true }, {
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
    });
    expect(result.changed).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves a fresh token for every Wrangler subprocess and scrubs inherited credentials", async () => {
    const runner = vi.fn<ProcessRunner>(async () => ({ stdout: "", stderr: "" }));
    const resolveToken = vi.fn()
      .mockResolvedValueOnce(`first-${"x".repeat(32)}`)
      .mockResolvedValueOnce(`second-${"y".repeat(32)}`);
    const wrapped = createCloudflareProcessRunner(runner, resolveToken, accountId, {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      CLOUDFLARE_API_TOKEN: "must-not-leak",
    });
    await wrapped("wrangler", ["d1", "migrations", "apply"], { env: { CUSTOM_SAFE_VALUE: "yes" } });
    await wrapped("wrangler", ["deploy"]);
    expect(resolveToken).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenNthCalledWith(1, "wrangler", ["d1", "migrations", "apply"], expect.objectContaining({
      inheritEnvironment: false,
      env: {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        CUSTOM_SAFE_VALUE: "yes",
        CLOUDFLARE_API_TOKEN: `first-${"x".repeat(32)}`,
        CLOUDFLARE_ACCOUNT_ID: accountId,
      },
    }));
    const secondOptions = runner.mock.calls[1]?.[2];
    expect(secondOptions?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(secondOptions?.env?.CLOUDFLARE_API_TOKEN).toBe(`second-${"y".repeat(32)}`);
  });

  it("redacts a Wrangler bearer from child-process failures", async () => {
    const token = `secret-${"z".repeat(32)}`;
    const wrapped = createCloudflareProcessRunner(
      vi.fn(async () => { throw new Error(`wrangler echoed ${token}`); }),
      async () => token,
      accountId,
      {},
    );
    await expect(wrapped("wrangler", ["deploy"])).rejects.toThrow("wrangler echoed [REDACTED]");
  });

  it("writes an authenticated state-bound approval manifest without mutations", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "approval.json");
    const client = fakeClient({ existing: true });
    const runner = vi.fn();
    const result = await deployArtifactShare({
      ...input,
      writeApprovalManifest: manifestPath,
    }, {
      client: client.client,
      deploymentRoot: root,
      runner,
    });

    expect(result.approvalManifest).toBe(manifestPath);
    expect(result.changed).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      version: 2,
      binding: {
        input: { hostname: "artifacts.example.com", pdfKeyId: "test-key" },
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        remote: { database: { uuid: "db-id" } },
      },
    });
  });

  it("binds a private deployment ID, authorization profile, planned OTP, and retention without mutation", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "private-approval.json");
    const runner = vi.fn();
    const client = fakeClient();
    await deployArtifactShare({
      ...privateInput(),
      deploymentId: "11111111-1111-4111-8111-111111111111",
      serviceName: "artifactpass-11111111",
      workersSubdomainAction: "reuse",
      privateAccess: {
        identityMode: "email-code",
        allowedIdpIds: [],
        providerAction: "create-after-approval",
        providerDisplayDigest: "c".repeat(64),
        autoRedirectToIdentity: true,
      },
      authorizationBinding: {
        source: "oauth",
        client_environment: "staging",
        profile: "emailCode",
        granted_scopes: ["zone.read"],
      },
      allowedExpirySeconds: [900, 3600, 604_800],
      writeApprovalManifest: manifestPath,
    }, {
      client: client.client,
      deploymentRoot: root,
      runner,
    });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest.version).toBe(3);
    expect(JSON.stringify(manifest)).toContain("create-after-approval");
    expect(JSON.stringify(manifest)).toContain("604800");
    expect(JSON.stringify(manifest)).not.toContain("PDF_PROVENANCE");
    expect(runner).not.toHaveBeenCalled();
    expect(client.requests.every(({ init }) => init.method === undefined)).toBe(true);
  });

  it("reuses named private resources only when D1 and R2 ownership markers match", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "owned-private-approval.json");
    const deploymentId = "11111111-1111-4111-8111-111111111111";
    const serviceName = "artifactpass-11111111";
    const client = fakeClient({ existing: true, serviceName, ownershipDeploymentId: deploymentId });
    const runner = vi.fn<ProcessRunner>(async (_command, args) => {
      const fileIndex = args.indexOf("--file");
      if (args.slice(0, 3).join(" ") === "r2 object get" && fileIndex >= 0) {
        await writeFile(args[fileIndex + 1] as string, JSON.stringify({
          version: 1,
          deployment_id: deploymentId,
          bucket_name: serviceName,
          creation_operation_id: "22222222-2222-4222-8222-222222222222",
          manifest_digest: "d".repeat(64),
        }));
      }
      return { stdout: "", stderr: "" };
    });
    await expect(deployArtifactShare({
      ...privateInput(),
      deploymentId,
      serviceName,
      privateAccess: {
        identityMode: "email-code",
        allowedIdpIds: ["otp-id"],
        providerAction: "reuse",
        autoRedirectToIdentity: true,
      },
      authorizationBinding: {
        source: "oauth",
        client_environment: "staging",
        profile: "emailCode",
        granted_scopes: ["zone.read"],
      },
      allowedExpirySeconds: [900, 3600],
      writeApprovalManifest: manifestPath,
    }, { client: client.client, deploymentRoot: root, runner })).resolves.toMatchObject({ changed: [] });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("refuses name-only D1 and R2 collisions for a private deployment", async () => {
    const root = await deploymentRoot();
    const deploymentId = "11111111-1111-4111-8111-111111111111";
    const serviceName = "artifactpass-11111111";
    const client = fakeClient({ existing: true, serviceName });
    const runner = vi.fn<ProcessRunner>(async () => {
      throw new Error("object not found");
    });
    await expect(deployArtifactShare({
      ...privateInput(),
      deploymentId,
      serviceName,
      privateAccess: {
        identityMode: "email-code",
        allowedIdpIds: ["otp-id"],
        providerAction: "reuse",
        autoRedirectToIdentity: true,
      },
      authorizationBinding: {
        source: "oauth",
        client_environment: "staging",
        profile: "emailCode",
        granted_scopes: ["zone.read"],
      },
      allowedExpirySeconds: [900],
      writeApprovalManifest: resolve(root, "foreign-approval.json"),
    }, { client: client.client, deploymentRoot: root, runner })).rejects.toThrow("D1 database is not owned");
  });

  it("binds an approval manifest to an explicitly isolated staging service", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "staging-approval.json");
    const client = fakeClient();
    const runner = vi.fn();
    const result = await deployArtifactShare({
      ...input,
      hostname: "staging.example.com",
      serviceName: "artifactpass-staging",
      writeApprovalManifest: manifestPath,
    }, {
      client: client.client,
      deploymentRoot: root,
      runner,
    });

    expect(result.changed).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      binding: {
        input: {
          hostname: "staging.example.com",
          serviceName: "artifactpass-staging",
        },
        remote: {
          database: null,
          bucket: null,
          worker: null,
          application: null,
        },
      },
    });
  });

  it("aborts before mutation when an approved bundle changes", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "approval.json");
    const client = fakeClient({ existing: true });
    await deployArtifactShare({ ...input, writeApprovalManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
    });
    await writeFile(resolve(root, "storage-lifecycle.json"), "{\"changed\":true}");
    const runner = vi.fn();

    await expect(deployArtifactShare({ ...input, approveManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
      runner,
    })).rejects.toThrow("no longer matches");
    expect(runner).not.toHaveBeenCalled();
  });

  it("aborts before mutation when approved remote deployment state changes", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "approval.json");
    const remoteState = { workerVersion: "worker-v1", schemaVersion: "schema-v1", lifecycleVersion: "lifecycle-v1" };
    const client = fakeClient({ existing: true, remoteState });
    await deployArtifactShare({ ...input, writeApprovalManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
    });
    remoteState.schemaVersion = "schema-v2";
    const runner = vi.fn();

    await expect(deployArtifactShare({ ...input, approveManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
      runner,
    })).rejects.toThrow("no longer matches");
    expect(runner).not.toHaveBeenCalled();
  });

  it("repairs a matching Access policy whose decision is not allow", async () => {
    const client = fakeClient({ existing: true, policyDecision: "deny" });
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/health")
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(null, { status: 302 })
    );

    const result = await deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
    });

    expect(result.changed).toContain("Access policy");
    const update = client.requests.find(({ path, init }) =>
      path.endsWith("/policies/policy-id") && init.method === "PUT"
    );
    expect(JSON.parse(String(update?.init.body))).toMatchObject({ decision: "allow" });
  });

  it("creates a path-scoped Access application with the approved provider binding", async () => {
    const client = fakeClient();
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/health")
        ? Response.json({ service: "lordebuilds.artifacts.share", status: "ok" })
        : new Response(null, { status: 302 })
    );
    const result = await deployArtifactShare({
      ...input,
      privateAccess: {
        identityMode: "email-code",
        allowedIdpIds: ["otp-provider"],
        autoRedirectToIdentity: true,
      },
    }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
    });
    expect(result.changed).toContain("Access application");
    const create = client.requests.find(({ path, init }) => path.endsWith("/access/apps") && init.method === "POST");
    expect(JSON.parse(String(create?.init.body))).toMatchObject({
      allowed_idps: ["otp-provider"],
      auto_redirect_to_identity: true,
      destinations: [
        { type: "public", uri: "artifacts.example.com/upload*" },
        { type: "public", uri: "artifacts.example.com/connect/approve*" },
      ],
    });
  });

  it("deploys private expiry bindings with an R2 lifecycle after the longest link", async () => {
    const client = fakeClient();
    let workerConfiguration: Record<string, unknown> | undefined;
    let lifecycle: Record<string, unknown> | undefined;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      const configIndex = args.indexOf("--config");
      if (args[0] === "deploy" && configIndex >= 0) {
        workerConfiguration = JSON.parse(await readFile(args[configIndex + 1] as string, "utf8"));
      }
      const fileIndex = args.indexOf("--file");
      if (args[0] === "r2" && fileIndex >= 0) {
        lifecycle = JSON.parse(await readFile(args[fileIndex + 1] as string, "utf8"));
      }
      return { stdout: "", stderr: "" };
    });
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/health")
        ? Response.json({ service: "lordebuilds.artifacts.share", status: "ok" })
        : new Response(null, { status: 302 })
    );
    await deployArtifactShare({
      ...input,
      allowedExpirySeconds: [900, 3600, 86_400, 604_800],
    }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
    });
    expect(workerConfiguration).toMatchObject({
      vars: {
        ALLOWED_EXPIRY_SECONDS: "900,3600,86400,604800",
        MAX_EXPIRY_SECONDS: "604800",
      },
    });
    expect(lifecycle).toMatchObject({
      rules: [{ deleteObjectsTransition: { condition: { maxAge: 691_200 } } }],
    });
  });

  it("refuses an existing Access application with incompatible provider bindings", async () => {
    const client = fakeClient({ existing: true, allowedIdps: ["another-provider"], autoRedirect: true });
    const runner = vi.fn();
    await expect(deployArtifactShare({
      ...input,
      privateAccess: {
        identityMode: "email-code",
        allowedIdpIds: ["otp-provider"],
        autoRedirectToIdentity: true,
      },
    }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    })).rejects.toThrow("incompatible identity-provider bindings");
    expect(runner).not.toHaveBeenCalled();
  });

  it("deploys public OAuth before removing the matching legacy Access gate", async () => {
    const client = fakeClient({ existing: true });
    const runnerCalls: Array<{
      readonly args: readonly string[];
      readonly input?: string;
    }> = [];
    let deploymentConfiguration = "";
    const runner = vi.fn(async (_command: string, args: readonly string[], options = {}) => {
      runnerCalls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
      if (args[0] === "deploy") {
        const configurationPath = args[args.indexOf("--config") + 1];
        deploymentConfiguration = await readFile(configurationPath ?? "", "utf8");
      }
      return { stdout: "", stderr: "" };
    });
    const fetch = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(String(request));
      if (url.pathname === "/health") {
        return Response.json({
          service: "lordebuilds.artifacts.share",
          status: "ok",
          human_auth_mode: "artifactpass",
          authentication_configured: true,
        });
      }
      if (url.pathname === "/auth/sign-in") {
        return new Response("Continue with Google and Continue with GitHub");
      }
      if (url.pathname === "/auth/login/google") {
        return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth" } });
      }
      if (url.pathname === "/auth/login/github") {
        return new Response(null, { status: 302, headers: { location: "https://github.com/login/oauth/authorize" } });
      }
      if (url.pathname === "/upload") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://artifacts.example.com/auth/sign-in?return_to=%2Fupload" },
        });
      }
      throw new Error(`Unexpected public deployment request: ${url}`);
    });
    const result = await deployArtifactShare({
      ...input,
      identities: [],
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
    }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
    });

    expect(result.changed).toEqual(["Worker deployment", "Access application removal"]);
    expect(runnerCalls.map(({ args }) => args[0])).toEqual(["d1", "r2", "deploy"]);
    expect(runnerCalls[2]?.args).toContain("--secrets-file");
    expect(deploymentConfiguration).toContain('"HUMAN_AUTH_MODE":"artifactpass"');
    expect(deploymentConfiguration).toContain('"ALLOWED_EXPIRY_SECONDS":"900,1800,3600,86400,604800"');
    expect(deploymentConfiguration).toContain('"MAX_EXPIRY_SECONDS":"604800"');
    expect(deploymentConfiguration).not.toContain("google-client-secret");
    expect(deploymentConfiguration).not.toContain("github-client-secret");
    expect(client.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps/app-id`,
      init: expect.objectContaining({ method: "DELETE" }),
    }));
  });

  it.each([
    ["Cloudflare Access", "https://team.cloudflareaccess.com/cdn-cgi/access/login"],
    ["activated ArtifactPass sign-in", "/auth/sign-in?return_to=%2Fupload"],
  ])("deploys production OAuth and code atomically through the %s boundary", async (_boundary, uploadLocation) => {
    const root = await deploymentRoot();
    const manifestRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-approval-test-"));
    const manifestPath = resolve(manifestRoot, "production-approval.json");
    const client = fakeClient({ existing: true });
    const productionInput: DeployInput = {
      ...input,
      identities: [],
      productionExistingResources: true,
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
      writeApprovalManifest: manifestPath,
    };

    await deployArtifactShare(productionInput, { client: client.client, deploymentRoot: root });

    const runnerCalls: string[][] = [];
    let secretsPath = "";
    let secretsMode = 0;
    let secrets = "";
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      runnerCalls.push([...args]);
      if (args[0] === "deploy") {
        secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";
        secretsMode = (await stat(secretsPath)).mode & 0o777;
        secrets = await readFile(secretsPath, "utf8");
      }
      return { stdout: "", stderr: "" };
    });
    const fetch = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(String(request));
      if (url.pathname === "/health") {
        return Response.json({
          service: "lordebuilds.artifacts.share",
          status: "ok",
          human_auth_mode: "artifactpass",
          authentication_configured: true,
        });
      }
      if (url.pathname === "/auth/sign-in") return new Response("Continue with Google");
      if (url.pathname === "/auth/login/google") {
        return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth" } });
      }
      if (url.pathname === "/auth/login/github") {
        return new Response(null, { status: 302, headers: { location: "https://github.com/login/oauth/authorize" } });
      }
      if (url.pathname === "/upload") {
        return new Response(null, {
          status: 302,
          headers: { location: uploadLocation },
        });
      }
      throw new Error(`Unexpected production deployment request: ${url}`);
    });

    const { writeApprovalManifest: _writeApprovalManifest, ...approvedProductionInput } = productionInput;
    const result = await deployArtifactShare({
      ...approvedProductionInput,
      approveManifest: manifestPath,
    }, { client: client.client, deploymentRoot: root, runner, fetch });

    expect(result.changed).toEqual(["R2 lifecycle", "Worker deployment"]);
    expect(runnerCalls.map(([command]) => command)).toEqual(["d1", "r2", "deploy"]);
    expect(runnerCalls[2]).toContain("--secrets-file");
    expect(secretsMode).toBe(0o600);
    expect(JSON.parse(secrets)).toEqual({
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
    });
    await expect(stat(secretsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.requests).not.toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps/app-id`,
      init: expect.objectContaining({ method: "DELETE" }),
    }));
  });

  it("stops a production deployment before mutation when an existing resource is missing", async () => {
    const root = await deploymentRoot();
    const client = fakeClient({ existing: false });
    const runner = vi.fn();

    await expect(deployArtifactShare({
      ...input,
      identities: [],
      productionExistingResources: true,
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
      writeApprovalManifest: resolve(root, "production-approval.json"),
    }, { client: client.client, deploymentRoot: root, runner })).rejects.toThrow(
      "existing Worker, D1, R2, custom domain, and Access application",
    );

    expect(runner).not.toHaveBeenCalled();
    expect(client.requests.every(({ init }) => init.method === undefined || init.method === "GET")).toBe(true);
  });

  it("writes a production approval manifest from the observed 0001-0006 baseline", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "production-approval.json");
    const client = fakeClient({
      existing: true,
      appliedMigrations: testMigrationNames.slice(0, 6),
    });
    const runner = vi.fn();

    const result = await deployArtifactShare({
      ...input,
      identities: [],
      productionExistingResources: true,
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
      writeApprovalManifest: manifestPath,
    }, { client: client.client, deploymentRoot: root, runner });

    expect(result.approvalManifest).toBe(manifestPath);
    expect(runner).not.toHaveBeenCalled();
  });

  it("writes a production approval manifest when every migration is already applied", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "production-approval.json");
    const client = fakeClient({
      existing: true,
      appliedMigrations: testMigrationNames,
    });
    const runner = vi.fn();

    const result = await deployArtifactShare({
      ...input,
      identities: [],
      productionExistingResources: true,
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
      writeApprovalManifest: manifestPath,
    }, { client: client.client, deploymentRoot: root, runner });

    expect(result.approvalManifest).toBe(manifestPath);
    expect(runner).not.toHaveBeenCalled();
  });

  it("stops a production deployment before mutation for a partial migration baseline", async () => {
    const root = await deploymentRoot();
    const client = fakeClient({
      existing: true,
      appliedMigrations: testMigrationNames.slice(0, 7),
    });
    const runner = vi.fn();

    await expect(deployArtifactShare({
      ...input,
      identities: [],
      productionExistingResources: true,
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
      writeApprovalManifest: resolve(root, "production-approval.json"),
    }, { client: client.client, deploymentRoot: root, runner })).rejects.toThrow(
      "approved production migration baseline",
    );

    expect(runner).not.toHaveBeenCalled();
  });

  it("stops before mutation when production has an alternate Worker ingress", async () => {
    const root = await deploymentRoot();
    const client = fakeClient({ existing: true, workersDevEnabled: true });
    const runner = vi.fn();

    await expect(deployArtifactShare({
      ...input,
      identities: [],
      productionExistingResources: true,
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
      writeApprovalManifest: resolve(root, "production-approval.json"),
    }, { client: client.client, deploymentRoot: root, runner })).rejects.toThrow(
      "existing Worker, D1, R2, custom domain, and Access application",
    );

    expect(runner).not.toHaveBeenCalled();
  });

  it("restores the legacy Access gate when post-removal upload verification fails", async () => {
    const client = fakeClient({ existing: true });
    let uploadRequests = 0;
    const deployedConfigurations: string[] = [];
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === "deploy") {
        const configurationPath = args[args.indexOf("--config") + 1];
        deployedConfigurations.push(await readFile(configurationPath ?? "", "utf8"));
      }
      return { stdout: "", stderr: "" };
    });
    const fetch = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(String(request));
      if (url.pathname === "/health") {
        return Response.json({
          service: "lordebuilds.artifacts.share",
          status: "ok",
          human_auth_mode: "artifactpass",
          authentication_configured: true,
        });
      }
      if (url.pathname === "/auth/sign-in") return new Response("Continue with Google");
      if (url.pathname === "/auth/login/google") {
        return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth" } });
      }
      if (url.pathname === "/auth/login/github") {
        return new Response(null, { status: 302, headers: { location: "https://github.com/login/oauth/authorize" } });
      }
      if (url.pathname === "/upload") {
        uploadRequests += 1;
        return uploadRequests === 1
          ? new Response("unprotected")
          : new Response(null, { status: 302 });
      }
      throw new Error(`Unexpected public deployment request: ${url}`);
    });

    await expect(deployArtifactShare({
      ...input,
      identities: [],
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
    }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
      sleep: vi.fn(async (_milliseconds: number) => undefined),
    })).rejects.toThrow("did not protect the upload route");

    expect(client.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps/app-id`,
      init: expect.objectContaining({ method: "DELETE" }),
    }));
    expect(client.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps`,
      init: expect.objectContaining({ method: "POST" }),
    }));
    expect(client.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps/app-id/policies`,
      init: expect.objectContaining({ method: "POST" }),
    }));
    expect(deployedConfigurations).toHaveLength(2);
    expect(deployedConfigurations[0]).toContain('"HUMAN_AUTH_MODE":"artifactpass"');
    expect(deployedConfigurations[1]).toContain('"HUMAN_AUTH_MODE":"cloudflare-access"');
    expect(deployedConfigurations[1]).toContain('"ACCESS_AUD":"audience"');
  });

  it("restores the legacy Access gate for a cross-origin upload redirect", async () => {
    const client = fakeClient({ existing: true });
    let uploadRequests = 0;
    const fetch = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(String(request));
      if (url.pathname === "/health") {
        return Response.json({
          service: "lordebuilds.artifacts.share",
          status: "ok",
          human_auth_mode: "artifactpass",
          authentication_configured: true,
        });
      }
      if (url.pathname === "/auth/sign-in") return new Response("Continue with Google");
      if (url.pathname === "/auth/login/google") {
        return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth" } });
      }
      if (url.pathname === "/auth/login/github") {
        return new Response(null, { status: 302, headers: { location: "https://github.com/login/oauth/authorize" } });
      }
      if (url.pathname === "/upload") {
        uploadRequests += 1;
        if (uploadRequests > 1) return new Response(null, { status: 302 });
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/auth/sign-in?return_to=%2Fupload" },
        });
      }
      throw new Error(`Unexpected public deployment request: ${url}`);
    });

    await expect(deployArtifactShare({
      ...input,
      identities: [],
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
    }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      fetch,
      sleep: vi.fn(async (_milliseconds: number) => undefined),
    })).rejects.toThrow("did not protect the upload route");

    expect(client.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps`,
      init: expect.objectContaining({ method: "POST" }),
    }));
  });

  it("binds public OAuth secrets by hash without writing them to the approval manifest", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "public-approval.json");
    const client = fakeClient();
    await deployArtifactShare({
      ...input,
      identities: [],
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
      writeApprovalManifest: manifestPath,
    }, {
      client: client.client,
      deploymentRoot: root,
    });

    const manifestSource = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestSource);
    expect(manifest).toMatchObject({
      version: 2,
      binding: {
        input: {
          authMode: "artifactpass",
          googleClientId: "google-client-id",
          googleClientSecretSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          githubClientId: "github-client-id",
          githubClientSecretSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
    });
    expect(manifestSource).not.toContain("google-client-secret");
    expect(manifestSource).not.toContain("github-client-secret");
    expect(client.requests.map(({ path }) => path)).not.toContain(
      `/accounts/${accountId}/access/organizations`,
    );
  });

  it("rejects missing identity, invalid IDs, and a hostname outside the zone", async () => {
    expect(() => deploymentPlan({ ...input, identities: [] })).toThrow("allowed identity");
    expect(() => deploymentPlan({ ...input, accountId: "wrong" })).toThrow("32 lowercase");
    expect(() => deploymentPlan({ ...input, serviceName: "Invalid Service" })).toThrow("service name");
    expect(() => deploymentPlan({ ...input, serviceName: "a" })).toThrow("service name");
    expect(() => deploymentPlan({ ...input, serviceName: "ab" })).toThrow("service name");
    expect(() => deploymentPlan({ ...input, allowedExpirySeconds: [3600, 900] }))
      .toThrow("unique, increasing");
    expect(() => deploymentPlan({
      ...input,
      identities: [{ kind: "authenticated", value: "selected-providers" }],
      privateAccess: {
        identityMode: "email-code",
        allowedIdpIds: ["otp-provider"],
        autoRedirectToIdentity: true,
      },
    })).toThrow("cannot allow every internet email address");
    const client = fakeClient();
    await expect(deployArtifactShare({ ...input, hostname: "artifacts.foreign.com" }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
    })).rejects.toThrow("selected active");
  });

  it("accepts the active zone apex as the Worker Custom Domain", async () => {
    const root = await deploymentRoot();
    const client = fakeClient({ existing: true });
    await expect(deployArtifactShare({
      ...input,
      hostname: "example.com",
      writeApprovalManifest: resolve(root, "apex-approval.json"),
    }, {
      client: client.client,
      deploymentRoot: root,
    })).resolves.toMatchObject({ changed: [] });
  });

  it("refuses a custom-hostname collision before running Wrangler", async () => {
    const client = fakeClient({ collision: true, existing: true });
    const runner = vi.fn();
    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    })).rejects.toThrow("already attached");
    expect(runner).not.toHaveBeenCalled();
  });

  it("surfaces partial provisioning and leaves the rerunnable named D1 resource", async () => {
    const client = fakeClient({ failR2: true });
    const runner = vi.fn();
    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    })).rejects.toThrow("R2 provisioning failed");
    expect(client.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: `/accounts/${accountId}/d1/database`,
        init: expect.objectContaining({ method: "POST" }),
      }),
    ]));
    expect(runner).not.toHaveBeenCalled();
  });

  it("reuses existing resources and reruns deployment safely", async () => {
    const client = fakeClient({ existing: true });
    const commands: string[][] = [];
    const progress: string[] = [];
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      commands.push([...args]);
      return { stdout: "", stderr: "" };
    });
    const result = await deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      onProgress: (message) => progress.push(message),
      fetch: vi.fn(async (request) => String(request).endsWith("/health")
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(null, { status: 302 })),
    });
    expect(result.changed).toEqual(["Worker deployment"]);
    expect(progress).toEqual([
      "Checking Cloudflare authorization",
      "Preparing Cloudflare resources",
      "Checking domain and Worker settings",
      "Preparing D1 database",
      "Preparing R2 storage",
      "Configuring publisher access",
      "Applying D1 migrations",
      "Applying R2 retention policy",
      "Deploying ArtifactPass to artifacts.example.com",
      "Waiting for artifacts.example.com to become ready",
      "Verifying private sign-in",
    ]);
    const rerun = await deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch: vi.fn(async (request) => String(request).endsWith("/health")
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(null, { status: 302 })),
    });
    expect(rerun.changed).toEqual(["Worker deployment"]);
    expect(commands.map((args) => args.slice(0, 3))).toEqual([
      ["d1", "migrations", "apply"],
      ["r2", "bucket", "lifecycle"],
      ["deploy", "--config", expect.any(String)],
      ["d1", "migrations", "apply"],
      ["r2", "bucket", "lifecycle"],
      ["deploy", "--config", expect.any(String)],
    ]);
  });

  it("provisions every staging resource under the explicit service name", async () => {
    const serviceName = "artifactpass-staging";
    const hostname = "staging.example.com";
    const client = fakeClient({ hostname, serviceName });
    let configuration: Record<string, unknown> | undefined;
    const commands: string[][] = [];
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      commands.push([...args]);
      if (args[0] === "deploy") {
        const configurationPath = args[args.indexOf("--config") + 1];
        if (configurationPath !== undefined) {
          configuration = JSON.parse(await readFile(configurationPath, "utf8")) as Record<string, unknown>;
        }
      }
      return { stdout: "", stderr: "" };
    });

    await deployArtifactShare({ ...input, hostname, serviceName }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch: vi.fn(async (request) => String(request).endsWith("/health")
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(null, { status: 302 })),
    });

    const createDatabase = client.requests.find(({ path, init }) =>
      path.endsWith("/d1/database") && init.method === "POST"
    );
    const createBucket = client.requests.find(({ path, init }) =>
      path.endsWith("/r2/buckets") && init.method === "POST"
    );
    const createApplication = client.requests.find(({ path, init }) =>
      path.endsWith("/access/apps") && init.method === "POST"
    );
    expect(JSON.parse(String(createDatabase?.init.body))).toEqual({ name: serviceName });
    expect(JSON.parse(String(createBucket?.init.body))).toEqual({ name: serviceName });
    expect(JSON.parse(String(createApplication?.init.body))).toMatchObject({ name: serviceName });
    expect(commands).toEqual(expect.arrayContaining([
      expect.arrayContaining(["d1", "migrations", "apply", serviceName]),
      expect.arrayContaining(["r2", "bucket", "lifecycle", "set", serviceName]),
    ]));
    expect(configuration).toMatchObject({
      name: serviceName,
      d1_databases: [{ database_name: serviceName }],
      r2_buckets: [{ bucket_name: serviceName }],
      routes: [{ pattern: hostname, custom_domain: true }],
    });
  });

  it("retries a bounded transient DNS failure before verifying the deployed routes", async () => {
    const client = fakeClient({ existing: true });
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        service: "lordebuilds.artifacts.share",
        status: "ok",
      })))
      .mockResolvedValueOnce(new Response(null, { status: 302 }));

    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
      sleep,
    })).resolves.toMatchObject({ changed: ["Worker deployment"] });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries transient HTTP readiness responses for health and Access", async () => {
    const client = fakeClient({ existing: true });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        service: "lordebuilds.artifacts.share",
        status: "ok",
      })))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 302 }));

    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner: vi.fn(async () => ({ stdout: "", stderr: "" })),
      fetch,
      sleep,
    })).resolves.toMatchObject({ changed: ["Worker deployment"] });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("waits for the new public-auth Worker health body after deployment propagation", async () => {
    const client = fakeClient({ existing: true });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const staleHealth = {
      service: "lordebuilds.artifacts.share",
      status: "ok",
      human_auth_mode: "cloudflare-access",
      authentication_configured: true,
    };
    const readyHealth = {
      service: "lordebuilds.artifacts.share",
      status: "ok",
      human_auth_mode: "artifactpass",
      authentication_configured: true,
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(staleHealth))
      .mockResolvedValueOnce(Response.json(readyHealth))
      .mockResolvedValueOnce(new Response("Continue with Google"))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://accounts.google.com/o/oauth2/v2/auth" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://github.com/login/oauth/authorize" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/artifacts.example.com" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "/auth/sign-in?return_to=%2Fupload" },
      }));

    await expect(deployArtifactShare({
      ...input,
      identities: [],
      publicAuth: {
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        githubClientId: "github-client-id",
        githubClientSecret: "github-client-secret",
      },
    }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner: vi.fn(async () => ({ stdout: "", stderr: "" })),
      fetch,
      sleep,
    })).resolves.toMatchObject({
      changed: ["Worker deployment", "Access application removal"],
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("bounds every readiness attempt and fails after exhausting retries", async () => {
    const client = fakeClient({ existing: true });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const fetch = vi.fn(async (_request: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing readiness timeout"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    );

    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner: vi.fn(async () => ({ stdout: "", stderr: "" })),
      fetch,
      sleep,
      readinessTimeoutMilliseconds: 1,
    })).rejects.toThrow();

    expect(fetch).toHaveBeenCalledTimes(9);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      15_000,
      30_000,
      30_000,
      30_000,
    ]);
  });

  it("surfaces migration failure and never writes a provisioning token into command arguments", async () => {
    const client = fakeClient({ existing: true });
    const seen: readonly string[][] = [];
    const mutableSeen = seen as string[][];
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      mutableSeen.push([...args]);
      if (args[0] === "d1") throw new Error("migration failed");
      return { stdout: "", stderr: "" };
    });
    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    })).rejects.toThrow("migration failed");
    expect(JSON.stringify(mutableSeen)).not.toContain("cloudflare-secret");
  });

  it("does not report idempotent storage preparation as a resource change", async () => {
    const client = fakeClient({ existing: true });
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === "deploy") throw new Error("injected Worker failure");
      return { stdout: "", stderr: "" };
    });

    const failure = await deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DeploymentMutationError);
    expect((failure as DeploymentMutationError).message).toBe("injected Worker failure");
    expect((failure as DeploymentMutationError).changed).toEqual([]);
  });

  it("restores the approved R2 lifecycle after a later deployment failure", async () => {
    const root = await deploymentRoot();
    const manifestRoot = await mkdtemp(resolve(tmpdir(), "artifactpass-rollback-approval-"));
    const manifestPath = resolve(manifestRoot, "approval.json");
    const client = fakeClient({ existing: true });
    const rollbackInput = { ...input, allowedExpirySeconds: [900] } as const;
    await deployArtifactShare({ ...rollbackInput, writeApprovalManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
    });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      binding: { remote: { lifecycle: { rules: [{ id: "lifecycle-v1" }] } } },
    });
    const failure = await deployArtifactShare({ ...rollbackInput, approveManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
      runner: vi.fn(async (_command: string, args: readonly string[]) => {
        if (args[0] === "deploy") throw new Error("injected Worker failure");
        return { stdout: "", stderr: "" };
      }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DeploymentMutationError);
    expect((failure as DeploymentMutationError).message).toBe("injected Worker failure");
    expect((failure as DeploymentMutationError).changed).toContain("R2 lifecycle");
    expect((failure as DeploymentMutationError).rolledBack).toEqual(["R2 lifecycle"]);
    expect((failure as DeploymentMutationError).rollbackFailures).toEqual([]);
    const rollback = client.requests.find(({ path, init }) =>
      path.endsWith("/lifecycle") && init.method === "PUT"
    );
    expect(JSON.parse(String(rollback?.init.body))).toEqual({ rules: [{ id: "lifecycle-v1" }] });
  });
});
