import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createSlackArchiveConfiguration, readSlackArchiveConfiguration, writeSlackArchiveConfiguration } from "../src/slack/configuration";
import { startSlackArchiveWizard, type SlackWizardHandle } from "../src/slack/wizard";
import type { ProcessRunner } from "../src/process";

const handles: SlackWizardHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map(handle => handle.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const fixture = async (runner: ProcessRunner) => {
  const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-wizard-"));
  directories.push(directory);
  const handle = await startSlackArchiveWizard({
    statePath: join(directory, "configuration.json"),
    deploymentRoot: directory,
    htmlPath: resolve(import.meta.dirname, "../src/slack/wizard.html"),
    runner,
  });
  handles.push(handle);
  const url = new URL(handle.url);
  const token = url.hash.slice(1);
  url.hash = "";
  const request = async (path: string, method = "GET", body?: unknown, authorized = true) =>
    fetch(new URL(path, url), {
      method,
      headers: {
        Origin: url.origin,
        ...(authorized ? { "X-ArtifactPass-Setup-Token": token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { directory, handle, request, url };
};

test("local wizard prints a profile-independent URL and keeps setup state out of the page", async () => {
  const { directory, handle, request, url } = await fixture(async () => {
    throw new Error("Loading the wizard must not contact Cloudflare");
  });
  expect(url.hostname).toBe("127.0.0.1");
  expect(handle.url).toMatch(/#[a-f0-9]{64}$/u);
  const page = await request("/");
  expect(page.status).toBe(200);
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await page.text()).toContain("ArtifactPass Archive");
  const denied = await request("/api/state", "GET", undefined, false);
  expect(denied.status).toBe(403);
  const state = await request("/api/state");
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ configuration: null, operation: null });
  const browserGet = await fetch(new URL("/api/state", url), { headers: { "X-ArtifactPass-Setup-Token": handle.url.split("#")[1] ?? "" } });
  expect(browserGet.status).toBe(200);
  await expect(readFile(join(directory, "configuration.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("account selection saves non-secret progress without creating Cloudflare resources", async () => {
  const calls: string[] = [];
  const runner: ProcessRunner = async (_command, args) => {
    calls.push(args.join(" "));
    if (args[0] === "whoami") return {
      stdout: JSON.stringify({ loggedIn: true, accounts: [
        { id: "a".repeat(32), name: "Example account" },
        { id: "b".repeat(32), name: "Other account" },
      ] }),
      stderr: "",
    };
    throw new Error(`Unexpected Cloudflare call: ${args.join(" ")}`);
  };
  const { directory, request } = await fixture(runner);
  const accounts = await request("/api/accounts", "POST", {});
  expect(accounts.status).toBe(200);
  expect(await accounts.json()).toMatchObject({ accounts: [{ name: "Example account" }, { name: "Other account" }] });
  const selected = await request("/api/account", "POST", { accountId: "b".repeat(32) });
  expect(selected.status).toBe(200);
  const saved = await readSlackArchiveConfiguration(join(directory, "configuration.json"));
  expect(saved?.account_id).toBe("b".repeat(32));
  expect(saved?.worker_url).toBeUndefined();
  expect(calls).toEqual(["whoami --json"]);
});

test("disconnected Cloudflare explains how to recover without exposing a raw Wrangler error", async () => {
  const { request } = await fixture(async () => {
    throw new Error("wrangler failed with status 1: internal command output");
  });
  const response = await request("/api/accounts", "POST", {});
  expect(response.status).toBe(400);
  const { error } = await response.json() as { error: string };
  expect(error).toContain("Connect Cloudflare");
  expect(error).toContain("browser profile");
  expect(error).not.toContain("internal command output");
});

test("the wizard does not provision until the exact resource review is approved", async () => {
  const runner: ProcessRunner = async (_command, args) => {
    if (args[0] === "whoami") return {
      stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "a".repeat(32), name: "Example account" }] }),
      stderr: "",
    };
    throw new Error("Resource creation was not authorized");
  };
  const { directory, request } = await fixture(runner);
  await request("/api/accounts", "POST", {});
  await request("/api/account", "POST", { accountId: "a".repeat(32) });
  const denied = await request("/api/deploy", "POST", { approved: false });
  expect(denied.status).toBe(400);
  expect((await readSlackArchiveConfiguration(join(directory, "configuration.json")))?.worker_url).toBeUndefined();
});

test("starting over requires the exact archive name and removes only its saved resources", async () => {
  const calls: string[] = [];
  const runner: ProcessRunner = async (_command, args) => {
    calls.push(args.join(" "));
    return { stdout: "removed", stderr: "" };
  };
  const { directory, request } = await fixture(runner);
  const statePath = join(directory, "configuration.json");
  const config = createSlackArchiveConfiguration();
  const workerName = `artifactpass-archive-${config.installation_id.slice(0, 8)}`;
  await writeSlackArchiveConfiguration(statePath, {
    ...config,
    stage: "manifest-pending",
    account_id: "a".repeat(32),
    worker_name: workerName,
    worker_url: `https://${workerName}.example.workers.dev`,
    queue_name: `${workerName}-queue`,
    database_id: "12345678-1234-1234-1234-123456789abc",
    app_id: "A1234567890",
  });
  const denied = await request("/api/reset", "POST", { confirmedResourceName: "wrong" });
  expect(denied.status).toBe(400);
  expect(calls).toEqual([]);
  expect(await readSlackArchiveConfiguration(statePath)).not.toBeNull();

  const started = await request("/api/reset", "POST", { confirmedResourceName: workerName });
  expect(started.status).toBe(202);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await (await request("/api/state")).json() as { operation?: { status: string } };
    if (state.operation?.status === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(await readSlackArchiveConfiguration(statePath)).toBeNull();
  expect(calls).toEqual([
    `queues consumer worker remove ${workerName}-queue ${workerName}`,
    `delete ${workerName}`,
    `queues delete ${workerName}-queue`,
    `d1 delete ${workerName}-db --skip-confirmation`,
  ]);
});

test("the wizard blocks channel setup and verification until the final Slack manifest is acknowledged", async () => {
  const { directory, request } = await fixture(async () => {
    throw new Error("The manifest gate must run before Cloudflare calls");
  });
  const statePath = join(directory, "configuration.json");
  await writeSlackArchiveConfiguration(statePath, {
    ...createSlackArchiveConfiguration(),
    stage: "manifest-pending",
    account_id: "a".repeat(32),
    worker_name: "artifactpass-archive-test",
    worker_url: "https://artifactpass-archive-test.example.workers.dev",
    team_id: "T1234567890",
    app_id: "A1234567890",
  });

  const channels = await request("/api/channels", "POST", { channels: ["C1234567890"] });
  expect(channels.status).toBe(400);
  expect(await channels.json()).toMatchObject({ error: expect.stringMatching(/manifest/u) });
  const verify = await request("/api/verify", "POST", {});
  expect(verify.status).toBe(400);
  expect(await (await request("/api/state")).json()).toMatchObject({ manifest_ready: false });

  const confirmed = await request("/api/manifest-applied", "POST", { applied: true });
  expect(confirmed.status).toBe(200);
  expect(await (await request("/api/state")).json()).toMatchObject({ manifest_ready: true });
  const saved = await readSlackArchiveConfiguration(statePath);
  expect(saved?.manifest_applied_for).toMatch(/^[a-f0-9]{64}$/u);

  await writeSlackArchiveConfiguration(statePath, {
    ...saved!,
    sources: ["https://artifactpass.com", "https://artifacts.example.com"],
  });
  const stale = await request("/api/channels", "POST", { channels: ["C1234567890"] });
  expect(stale.status).toBe(400);
  expect(await stale.json()).toMatchObject({ error: expect.stringMatching(/manifest/u) });
  expect(await (await request("/api/state")).json()).toMatchObject({ manifest_ready: false });
});

test("save and exit waits for an in-progress setup operation", async () => {
  let finishLogin: (() => void) | undefined;
  const authorizationUrl = "https://dash.cloudflare.com/oauth2/auth?state=test";
  const runner: ProcessRunner = async (_command, args, options) => {
    if (args[0] === "login") {
      options?.onOutput?.("Visit this link to authenticate: https://dash.cloudflare.com/oauth2/");
      options?.onOutput?.("auth?state=test\n");
      await new Promise<void>(resolve => { finishLogin = resolve; });
      return { stdout: "signed in", stderr: "" };
    }
    if (args[0] === "whoami") return {
      stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "a".repeat(32), name: "Example account" }] }), stderr: "",
    };
    throw new Error("Unexpected Cloudflare command");
  };
  const { request } = await fixture(runner);
  expect((await request("/api/login", "POST", {})).status).toBe(202);
  expect(await (await request("/api/state")).json()).toMatchObject({
    operation: { kind: "login", status: "working", authorizationUrl },
  });
  const exit = await request("/api/exit", "POST", {});
  expect(exit.status).toBe(409);
  expect(await exit.json()).toMatchObject({ error: expect.stringMatching(/still running/u) });
  finishLogin?.();
});

test("the local wizard uses the real setup engine and resumes without duplicating resources", async () => {
  let databaseExists = false;
  let delivered = false;
  const calls: string[] = [];
  const secretWrites: string[] = [];
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === "https://slack.com/api/auth.test") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-synthetic-test-token");
      return new Response(JSON.stringify({ ok: true, team_id: "T1234567890" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  });
  const runner: ProcessRunner = async (_command, args, options) => {
    const command = args.join(" ");
    calls.push(command);
    if (args[0] === "whoami") return {
      stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "a".repeat(32), name: "Example account" }] }), stderr: "",
    };
    if (args[0] === "queues" && args[1] === "info") throw new Error("Queue not found");
    if (args[0] === "queues" && args[1] === "create") return { stdout: "created", stderr: "" };
    if (args[0] === "d1" && args[1] === "list") return {
      stdout: JSON.stringify(databaseExists ? [{
        name: "artifactpass-archive-" + (await readSlackArchiveConfiguration(statePath))?.installation_id.slice(0, 8) + "-db",
        uuid: "12345678-1234-1234-1234-123456789abc",
      }] : []), stderr: "",
    };
    if (args[0] === "d1" && args[1] === "create") { databaseExists = true; return { stdout: "created", stderr: "" }; }
    if (args[0] === "d1" && args.includes("--file")) return { stdout: "migrated", stderr: "" };
    if (args[0] === "d1" && args.includes("--command")) {
      const sql = command;
      const latest = Date.now() + 60_000;
      const results = !delivered ? [] : sql.includes("GROUP BY channel_id")
        ? [{ channel_id: "C1234567890", latest }, { channel_id: "C0987654321", latest }]
        : sql.includes("GROUP BY source_origin")
          ? [{ source_origin: "https://artifactpass.com", latest }, { source_origin: "https://artifacts.example.com", latest }]
          : sql.includes("GROUP BY status") ? [{ status: "succeeded", count: 2, latest }] : [];
      return { stdout: JSON.stringify([{ results }]), stderr: "" };
    }
    if (args[0] === "secret" && args[1] === "bulk") {
      secretWrites.push(options?.input ?? "");
      return { stdout: "saved", stderr: "" };
    }
    if (args[0] === "secret") return { stdout: JSON.stringify([{ name: "SLACK_BOT_TOKEN" }, { name: "SLACK_SIGNING_SECRET" }]), stderr: "" };
    if (args[0] === "deploy") return { stdout: "https://artifactpass-archive-example.workers.dev", stderr: "" };
    throw new Error(`Unexpected command: ${command}`);
  };
  const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-wizard-"));
  directories.push(directory);
  const statePath = join(directory, "configuration.json");
  await writeFile(join(directory, "index.js"), "export default {};\n");
  await writeFile(join(directory, "0001-deliveries.sql"), "CREATE TABLE deliveries (id TEXT);\n");
  const handle = await startSlackArchiveWizard({ statePath, deploymentRoot: directory,
    htmlPath: resolve(import.meta.dirname, "../src/slack/wizard.html"), runner });
  handles.push(handle);
  const url = new URL(handle.url);
  const token = url.hash.slice(1);
  url.hash = "";
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, url), { method: body === undefined ? "GET" : "POST",
      headers: { Origin: url.origin, "X-ArtifactPass-Setup-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, value: await response.json() };
  };
  const waitFor = async (kind: string, status = "complete") => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { value } = await request("/api/state");
      if (value.operation?.kind === kind && value.operation.status !== "working") {
        expect(value.operation.status).toBe(status);
        return value;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`${kind} did not finish`);
  };
  await request("/api/accounts", {});
  await request("/api/account", { accountId: "a".repeat(32) });
  expect((await request("/api/initial-sources", { privateOrigins: ["https://artifacts.example.com"] })).response.status).toBe(200);
  expect((await request("/api/deploy", { approved: true })).response.status).toBe(202);
  await waitFor("deploy");
  const bootstrap = await request("/api/manifest");
  expect(bootstrap.value.manifest).toBeDefined();
  expect(bootstrap.value.manifest.features.unfurl_domains).toEqual(["artifactpass.com", "artifacts.example.com"]);
  expect(bootstrap.value.manifest.settings.event_subscriptions.bot_events).toEqual(["link_shared"]);
  expect(bootstrap.value.manifest.settings.event_subscriptions.request_url).toBe("https://artifactpass-archive-example.workers.dev/slack/events");
  expect(JSON.parse(await readFile(join(directory, "app-manifest.json"), "utf8"))).toEqual(bootstrap.value.manifest);
  await expect(readFile(join(directory, "bootstrap-manifest.json"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(bootstrap.value)).not.toContain("SLACK_BOT_TOKEN");
  expect((await request("/api/activate", {
    appId: "A1234567890", botToken: "invalid-synthetic-token", signingSecret: "synthetic-signing-secret", initialManifestInstalled: true,
  })).response.status).toBe(202);
  const rejected = await waitFor("activate", "failed");
  expect(JSON.stringify(rejected)).not.toContain("invalid-synthetic-token");
  expect(secretWrites).toEqual([]);
  expect((await request("/api/activate", {
    appId: "A1234567890", botToken: "xoxb-synthetic-test-token", signingSecret: "synthetic-signing-secret", initialManifestInstalled: true,
  })).response.status).toBe(202);
  await waitFor("activate");
  expect(secretWrites.map(value => JSON.parse(value))).toEqual([{
    SLACK_BOT_TOKEN: "xoxb-synthetic-test-token",
    SLACK_SIGNING_SECRET: "synthetic-signing-secret",
  }]);
  expect(calls.join(" ")).not.toContain("synthetic-");
  expect(await readFile(statePath, "utf8")).not.toMatch(/synthetic-(?:test-token|signing-secret)/u);
  expect((await request("/api/state")).value.manifest_ready).toBe(true);
  expect((await request("/api/channels", { channels: ["https://example.slack.com/archives/C1234567890", "C0987654321"] })).response.status).toBe(202);
  await waitFor("channels");
  expect((await request("/api/verify", {})).value.status.verified).toBe(false);
  delivered = true;
  const verification = await request("/api/verify", {});
  expect(verification.value.status.verified).toBe(true);
  expect(verification.value.status.channels).toHaveLength(2);
  expect(verification.value.status.verified_sources).toHaveLength(2);
  expect((await readSlackArchiveConfiguration(statePath))?.stage).not.toBe("ready");
  expect((await request("/api/finish", { inspected: false })).response.status).toBe(400);
  expect((await request("/api/finish", { inspected: true })).response.status).toBe(200);
  const saved = await readSlackArchiveConfiguration(statePath);
  expect(saved?.stage).toBe("ready");
  await handle.close();
  const beforeResume = calls.length;
  const resumed = await startSlackArchiveWizard({ statePath, deploymentRoot: directory,
    htmlPath: resolve(import.meta.dirname, "../src/slack/wizard.html"), runner });
  handles.push(resumed);
  expect((await readSlackArchiveConfiguration(statePath))?.enabled_channels).toEqual(["C1234567890", "C0987654321"]);
  expect(calls).toHaveLength(beforeResume);
});
