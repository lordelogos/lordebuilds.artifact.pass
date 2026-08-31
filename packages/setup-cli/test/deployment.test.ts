import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CloudflareApiError, CloudflareClient } from "../src/cloudflare/client";
import { runDeployCommand } from "../src/commands/deploy";
import {
  deployArtifactShare,
  describeCloudflareFailure,
  deploymentPlan,
  type DeployInput,
} from "../src/cloudflare/deployment";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
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

const deploymentRoot = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "artifact-share-deployment-test-"));
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
  remoteState?: { workerVersion: string; schemaVersion: string; lifecycleVersion: string };
  serviceName?: string;
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
    if (path === `/zones/${zoneId}`) return { name: "example.com", status: "active" };
    if (path.includes("/d1/database?")) return options.existing ? [{ uuid: "db-id", name: serviceName }] : [];
    if (path.endsWith("/d1/database")) return { uuid: "db-id", name: serviceName };
    if (path.endsWith("/r2/buckets") && init.method !== "POST") {
      return { buckets: options.existing ? [{ name: serviceName }] : [] };
    }
    if (path.endsWith("/r2/buckets") && init.method === "POST" && options.failR2 === true) {
      throw new Error("R2 provisioning failed");
    }
    if (path.includes("/d1/database/db-id/query")) return [{
      results: [{ name: "artifacts", type: "table", sql: options.remoteState?.schemaVersion ?? "schema-v1" }],
    }];
    if (path.endsWith(`/r2/buckets/${serviceName}/lifecycle`)) return {
      rules: [{ id: options.remoteState?.lifecycleVersion ?? "lifecycle-v1" }],
    };
    if (path.endsWith("/access/organizations")) return { auth_domain: "team.cloudflareaccess.com" };
    if (path.endsWith("/access/apps") && init.method !== "POST") {
      return options.existing ? [{
        id: "app-id",
        name: serviceName,
        aud: "audience",
        destinations: [
          { type: "public", uri: `${hostname}/upload*` },
          { type: "public", uri: `${hostname}/connect/approve*` },
        ],
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
      return options.collision ? [{ hostname, service: "other" }] : [];
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
    expect(runnerCalls.map(({ args }) => args[0])).toEqual([
      "d1", "r2", "secret", "deploy",
    ]);
    expect(JSON.parse(runnerCalls[2]?.input ?? "{}")).toEqual({
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
    });
    expect(deploymentConfiguration).toContain('"HUMAN_AUTH_MODE":"artifactpass"');
    expect(deploymentConfiguration).not.toContain("google-client-secret");
    expect(deploymentConfiguration).not.toContain("github-client-secret");
    expect(client.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps/app-id`,
      init: expect.objectContaining({ method: "DELETE" }),
    }));
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
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      commands.push([...args]);
      return { stdout: "", stderr: "" };
    });
    const result = await deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch: vi.fn(async (request) => String(request).endsWith("/health")
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(null, { status: 302 })),
    });
    expect(result.changed).toEqual(["Worker deployment"]);
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
    })).resolves.toMatchObject({ changed: ["Worker deployment", "Access application removal"] });

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

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      15_000,
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
});
