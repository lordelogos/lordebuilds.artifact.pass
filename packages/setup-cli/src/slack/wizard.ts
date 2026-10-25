import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import { runProcess, type ProcessRunner } from "../process";
import {
  addSlackChannel,
  addSlackSource,
  removeSlackSource,
  createSlackArchiveConfiguration,
  readSlackArchiveConfiguration,
  writeSlackArchiveConfiguration,
  type SlackArchiveConfiguration,
} from "./configuration";
import { activateSlackArchive } from "./activation";
import { provisionSlackResources } from "./deployment";
import { createSlackAppManifest, createSlackInitialManifest } from "./manifest";
import { readSlackArchiveStatus, type SlackArchiveStatus } from "./status";
import { uninstallSlackArchive } from "./uninstall";

export interface SlackWizardOptions {
  readonly statePath: string;
  readonly deploymentRoot: string;
  readonly htmlPath: string;
  readonly runner?: ProcessRunner;
}

export interface SlackWizardHandle {
  readonly url: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface CloudflareAccount {
  readonly id: string;
  readonly name: string;
}

interface Operation {
  readonly kind: string;
  readonly status: "working" | "complete" | "failed";
  readonly message: string;
  readonly authorizationUrl?: string;
}

const cloudflareAuthorizationUrl = (output: string): string | undefined => {
  const ansiColorCode = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
  const plain = output.replace(ansiColorCode, "");
  const match = plain.match(/Visit this link to authenticate:\s*(https:\/\/[^\s]+)\s/u);
  if (!match?.[1]) return undefined;
  try {
    const url = new URL(match[1]);
    return url.protocol === "https:" && url.hostname === "dash.cloudflare.com" && url.pathname === "/oauth2/auth"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(value));
};

const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  let source = "";
  for await (const chunk of request) {
    source += String(chunk);
    if (source.length > 8 * 1024) throw new Error("Setup request is too large");
  }
  let parsed: unknown;
  try {
    parsed = source ? JSON.parse(source) : {};
  } catch {
    throw new Error("Enter valid setup details");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Enter valid setup details");
  }
  return parsed as Record<string, unknown>;
};

const cloudflareAccounts = async (runner: ProcessRunner): Promise<CloudflareAccount[]> => {
  let identity: unknown;
  try {
    const result = await runner("wrangler", ["whoami", "--json"]);
    identity = JSON.parse(result.stdout);
  } catch {
    throw new Error("Could not check Cloudflare accounts. Choose Connect Cloudflare, open the link shown here in the intended browser profile, then check again.");
  }
  if (!identity || typeof identity !== "object" || !("loggedIn" in identity) || identity.loggedIn !== true ||
      !("accounts" in identity) || !Array.isArray(identity.accounts)) {
    throw new Error("Connect Cloudflare, then check accounts again");
  }
  const accounts = identity.accounts.filter((item): item is CloudflareAccount =>
    typeof item === "object" && item !== null &&
    "id" in item && typeof item.id === "string" && /^[a-f0-9]{32}$/u.test(item.id) &&
    "name" in item && typeof item.name === "string");
  if (accounts.length === 0) throw new Error("No usable Cloudflare account was found");
  return accounts;
};

const connectSlackApp = async (
  config: SlackArchiveConfiguration,
  appId: string,
  botToken: string,
  signingSecret: string,
  runner: ProcessRunner,
): Promise<string> => {
  if (!config.account_id || !config.worker_name) throw new Error("Deploy the archive Worker first");
  if (!/^A[A-Z0-9]{8,}$/u.test(appId)) throw new Error("Enter the App ID from ArtifactPass Archive in Slack");
  if (!/^xoxb-[A-Za-z0-9-]+$/u.test(botToken) || !signingSecret.trim()) {
    throw new Error("Enter this app's Bot User OAuth Token and Signing Secret from Slack");
  }

  let teamId: string;
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      signal: AbortSignal.timeout(15_000),
    });
    const identity: unknown = await response.json();
    if (!response.ok || !identity || typeof identity !== "object" ||
        !("ok" in identity) || identity.ok !== true ||
        !("team_id" in identity) || typeof identity.team_id !== "string" ||
        !/^T[A-Z0-9]{8,}$/u.test(identity.team_id)) {
      throw new Error("Slack did not confirm the bot token");
    }
    teamId = identity.team_id;
  } catch {
    throw new Error("Slack could not verify that bot token. Copy the Bot User OAuth Token from the selected app and try again.");
  }

  try {
    await runner("wrangler", ["secret", "bulk", "--name", config.worker_name], {
      env: { CLOUDFLARE_ACCOUNT_ID: config.account_id },
      input: JSON.stringify({ SLACK_BOT_TOKEN: botToken, SLACK_SIGNING_SECRET: signingSecret }),
    });
  } catch {
    throw new Error("Cloudflare could not save the Slack secrets. Check the connected Cloudflare account and try again.");
  }
  return teamId;
};

const manifestFor = (config: SlackArchiveConfiguration): object => {
  if (!config.worker_url) throw new Error("Deploy the archive Worker first");
  return config.app_id
    ? createSlackAppManifest(config, config.worker_url)
    : createSlackInitialManifest(config, config.worker_url);
};

const manifestFingerprint = (config: SlackArchiveConfiguration): string =>
  createHash("sha256").update(JSON.stringify(createSlackAppManifest(config, config.worker_url ?? ""))).digest("hex");

const manifestIsApplied = (config: SlackArchiveConfiguration): boolean =>
  Boolean(config.app_id && config.worker_url &&
    (config.stage === "ready" && config.verified_at ||
      config.manifest_applied_for === manifestFingerprint(config)));

const writeManifest = async (config: SlackArchiveConfiguration, statePath: string): Promise<string> => {
  const path = join(dirname(statePath), "app-manifest.json");
  await writeFile(path, `${JSON.stringify(manifestFor(config), null, 2)}\n`, { mode: 0o600 });
  return path;
};

export const startSlackArchiveWizard = async (options: SlackWizardOptions): Promise<SlackWizardHandle> => {
  const html = await readFile(options.htmlPath, "utf8");
  const runner = options.runner ?? runProcess;
  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token);
  let operation: Operation | null = null;
  let lastVerification: { readonly status: SlackArchiveStatus; readonly updatedAt: string } | null = null;
  let accounts: CloudflareAccount[] = [];
  let closing = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let expectedOrigin = "";

  const authorized = (request: IncomingMessage): boolean => {
    const supplied = request.headers["x-artifactpass-setup-token"];
    if (typeof supplied !== "string" || supplied.length !== token.length) return false;
    const suppliedBytes = Buffer.from(supplied);
    return (request.headers.origin === undefined || request.headers.origin === expectedOrigin) &&
      suppliedBytes.length === tokenBytes.length && timingSafeEqual(suppliedBytes, tokenBytes);
  };

  const current = async (): Promise<SlackArchiveConfiguration> =>
    await readSlackArchiveConfiguration(options.statePath) ?? createSlackArchiveConfiguration();

  const run = (kind: string, message: string, action: () => Promise<void>): boolean => {
    if (operation?.status === "working") return false;
    operation = { kind, status: "working", message };
    void action().then(
      () => { operation = { kind, status: "complete", message: `${message} complete` }; },
      error => { operation = { kind, status: "failed", message: error instanceof Error ? error.message : String(error) }; },
    );
    return true;
  };

  const server = createServer(async (request, response) => {
    try {
      const address = request.headers.host;
      if (address !== expectedOrigin.slice("http://".length)) {
        json(response, 403, { error: "This setup link is local to your computer" });
        return;
      }
      const path = new URL(request.url ?? "/", expectedOrigin).pathname;
      if (request.method === "GET" && path === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        response.end(html);
        return;
      }
      if (!path.startsWith("/api/") || !authorized(request)) {
        json(response, 403, { error: "Open the fresh setup link printed in your terminal" });
        return;
      }
      if (request.method === "GET" && path === "/api/state") {
        const configuration = await readSlackArchiveConfiguration(options.statePath);
        json(response, 200, { configuration, manifest_ready: configuration ? manifestIsApplied(configuration) : false, operation, accounts });
        return;
      }
      if (request.method === "GET" && path === "/api/manifest") {
        json(response, 200, { manifest: manifestFor(await current()) });
        return;
      }
      if (request.method !== "POST") {
        json(response, 404, { error: "Unknown setup action" });
        return;
      }
      if (operation?.status === "working") {
        json(response, 409, { error: "A setup action is still running. Wait for it to finish." });
        return;
      }
      const body = await bodyOf(request);
      if (path === "/api/accounts") {
        accounts = await cloudflareAccounts(runner);
        json(response, 200, { accounts });
        return;
      }
      if (path === "/api/login") {
        const started = run("login", "Cloudflare sign-in", async () => {
          let loginOutput = "";
          await runner("wrangler", ["login", "--browser=false", "--use-keyring"], {
            onOutput: chunk => {
              loginOutput = (loginOutput + chunk).slice(-16_384);
              const authorizationUrl = cloudflareAuthorizationUrl(loginOutput);
              if (authorizationUrl && operation?.kind === "login" && operation.status === "working") {
                operation = { ...operation, authorizationUrl, message: "Waiting for Cloudflare approval" };
              }
            },
            timeoutMilliseconds: 10 * 60 * 1_000,
          });
          accounts = await cloudflareAccounts(runner);
        });
        json(response, started ? 202 : 409, { operation });
        return;
      }
      if (path === "/api/account") {
        const accountId = body.accountId;
        if (typeof accountId !== "string" || !accounts.some(account => account.id === accountId)) {
          throw new Error("Choose a Cloudflare account from the connected account list");
        }
        const config = await current();
        if (config.account_id && config.account_id !== accountId && config.queue_name) {
          throw new Error("This archive already has resources in another Cloudflare account");
        }
        await writeSlackArchiveConfiguration(options.statePath, { ...config, account_id: accountId, updated_at: new Date().toISOString() });
        json(response, 200, { accountId });
        return;
      }
      if (path === "/api/initial-sources") {
        const config = await current();
        if (config.worker_url) throw new Error("Change link sources before creating the Slack app");
        if (!Array.isArray(body.privateOrigins) || !body.privateOrigins.every(origin => typeof origin === "string")) {
          throw new Error("Enter private deployment origins, one per line");
        }
        let next = config;
        for (const origin of config.sources.filter(source => source !== "https://artifactpass.com")) {
          next = removeSlackSource(next, origin);
        }
        for (const origin of body.privateOrigins) next = addSlackSource(next, origin);
        await writeSlackArchiveConfiguration(options.statePath, next);
        json(response, 200, { sources: next.sources });
        return;
      }
      if (path === "/api/reset") {
        const config = await current();
        if (!config.worker_name || !config.account_id ||
            body.confirmedResourceName !== config.worker_name) {
          throw new Error("Confirm the exact archive Worker name before starting over");
        }
        const started = run("reset", "Removing the old archive resources", async () => {
          await uninstallSlackArchive(config, { statePath: options.statePath, approved: true, runner });
          lastVerification = null;
        });
        json(response, started ? 202 : 409, { operation });
        return;
      }
      if (path === "/api/deploy") {
        if (body.approved !== true) throw new Error("Approve the Worker, Queue, and D1 database before deployment");
        const config = await current();
        if (!config.account_id) throw new Error("Choose a Cloudflare account first");
        const started = run("deploy", "Cloudflare resource deployment", async () => {
          const deployed = await provisionSlackResources(config, {
            accountId: config.account_id ?? "",
            statePath: options.statePath,
            deploymentRoot: options.deploymentRoot,
            runner,
            approved: true,
          });
          await writeManifest(deployed, options.statePath);
        });
        json(response, started ? 202 : 409, { operation });
        return;
      }
      if (path === "/api/activate") {
        if (typeof body.appId !== "string" || typeof body.botToken !== "string" ||
            typeof body.signingSecret !== "string" || body.initialManifestInstalled !== true) {
          throw new Error("Enter the Slack app ID, bot token, and signing secret");
        }
        const config = await current();
        const started = run("activate", "Slack app activation", async () => {
          const teamId = await connectSlackApp(config, body.appId as string,
            body.botToken as string, body.signingSecret as string, runner);
          const activated = await activateSlackArchive(config, {
            statePath: options.statePath,
            deploymentRoot: options.deploymentRoot,
            teamId,
            appId: body.appId as string,
            runner,
          });
          await writeSlackArchiveConfiguration(options.statePath, {
            ...activated,
            manifest_applied_for: manifestFingerprint(activated),
            updated_at: new Date().toISOString(),
          });
        });
        json(response, started ? 202 : 409, { operation });
        return;
      }
      if (path === "/api/manifest-applied") {
        if (body.applied !== true) throw new Error("Confirm that Slack saved the final app manifest");
        const config = await current();
        if (!config.app_id || !config.worker_url) throw new Error("Connect the Slack app before applying its final manifest");
        await writeSlackArchiveConfiguration(options.statePath, {
          ...config, manifest_applied_for: manifestFingerprint(config), updated_at: new Date().toISOString(),
        });
        json(response, 200, { applied: true });
        return;
      }
      if (path === "/api/source") {
        if (typeof body.origin !== "string") throw new Error("Enter an HTTPS ArtifactPass origin");
        const config = await current();
        const next = addSlackSource(config, body.origin);
        const started = run("source", "Private source update", async () => {
          if (next !== config) await writeSlackArchiveConfiguration(options.statePath, next);
          if (!next.account_id || !next.worker_url) return;
          const deployed = await provisionSlackResources(next, {
            accountId: next.account_id,
            statePath: options.statePath,
            deploymentRoot: options.deploymentRoot,
            runner,
            approved: true,
          });
          await writeManifest(deployed, options.statePath);
        });
        json(response, started ? 202 : 409, { operation });
        return;
      }
      if (path === "/api/channels") {
        if (!Array.isArray(body.channels) || !body.channels.every(item => typeof item === "string")) {
          throw new Error("Paste one or more Slack channel links");
        }
        const config = await current();
        if (!config.app_id || !config.account_id) throw new Error("Activate the Slack app before enabling channels");
        if (!manifestIsApplied(config)) throw new Error("Save the final Slack app manifest before enabling channels");
        const next = addSlackChannel(config, ...body.channels);
        const started = run("channels", "Channel update", async () => {
          if (next !== config) await writeSlackArchiveConfiguration(options.statePath, next);
          await provisionSlackResources(next, {
            accountId: next.account_id ?? "",
            statePath: options.statePath,
            deploymentRoot: options.deploymentRoot,
            runner,
            approved: true,
          });
        });
        json(response, started ? 202 : 409, { operation });
        return;
      }
      if (path === "/api/verify") {
        const config = await current();
        if (!manifestIsApplied(config)) throw new Error("Save the final Slack app manifest before verifying links");
        const status = await readSlackArchiveStatus(config, runner);
        lastVerification = { status, updatedAt: config.updated_at };
        json(response, 200, { status });
        return;
      }
      if (path === "/api/finish") {
        const config = await current();
        if (body.inspected !== true || !lastVerification?.status.verified ||
            lastVerification.updatedAt !== config.updated_at) {
          throw new Error("Verify each channel and source, then confirm the actual Slack files before finishing");
        }
        await writeSlackArchiveConfiguration(options.statePath, {
          ...config, stage: "ready", verified_at: new Date().toISOString(),
        });
        json(response, 200, { ready: true });
        return;
      }
      if (path === "/api/exit") {
        json(response, 200, { saved: true });
        setImmediate(() => { void close(); });
        return;
      }
      json(response, 404, { error: "Unknown setup action" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Setup could not continue" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local setup server did not start");
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  const close = async (): Promise<void> => {
    if (closing) return closed;
    closing = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    resolveClosed();
  };
  return { url: `${expectedOrigin}/#${token}`, closed, close };
};
