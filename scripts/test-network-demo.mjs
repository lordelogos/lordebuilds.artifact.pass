import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  findLanIpv4Address,
  generateUploadToken,
  startQuickTunnel,
} from "./network-demo.mjs";
import { sourceSha256 } from "./publication-commitment.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const applicationRoot = join(repositoryRoot, "apps/artifact-service");

const formats = [
  { name: "network-test.md", type: "text/markdown", bytes: Buffer.from("# LAN artifact\n\nExact Markdown bytes.\n") },
  { name: "network-test.html", type: "text/html", bytes: Buffer.from("<!doctype html><title>LAN artifact</title><main>Exact HTML bytes.</main>") },
  { name: "network-test.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4\n% ArtifactPass network fixture\n%%EOF\n") },
];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const freePort = async () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate a network-demo port"));
      return;
    }
    server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
  });
});

const health = async (origin) => {
  const response = await fetch(new URL("/health", origin), { redirect: "manual" });
  assert(response.ok, `ArtifactPass is not reachable at ${origin} (${response.status})`);
};

const stopProcess = async (child) => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 10_000)),
  ]);
  if (!graceful) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
  }
};

const startIsolatedDemo = async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "artifact-share-network-demo-"));
  const stateRoot = join(temporaryRoot, "state");
  const configPath = join(temporaryRoot, "wrangler-network-test.jsonc");
  const port = await freePort();
  const loopbackOrigin = new URL(`http://127.0.0.1:${port}`);
  const config = {
    name: "lordebuilds-artifacts-share-network-test",
    main: join(applicationRoot, "src/demo/index.ts"),
    compatibility_date: "2026-08-16",
    vars: {
      ALLOWED_EXPIRY_SECONDS: "900,1800,3600,43200,86400",
      MAX_ARTIFACT_BYTES: "26214400",
      MAX_EXPIRY_SECONDS: "86400",
      LOCAL_TEST_CONTROL_TOKEN: generateUploadToken(),
    },
    d1_databases: [{
      binding: "ARTIFACT_DB",
      database_name: "lordebuilds-artifacts-share-network-test",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: join(applicationRoot, "migrations"),
    }],
    r2_buckets: [{
      binding: "ARTIFACTS",
      bucket_name: "lordebuilds-artifacts-share-network-test",
    }],
    assets: {
      binding: "ASSETS",
      run_worker_first: ["/health", "/upload", "/connect/*", "/api/*", "/a/*", "/__local-test/*"],
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await execute("pnpm", [
    "--dir", applicationRoot,
    "exec", "wrangler", "d1", "migrations", "apply", "ARTIFACT_DB",
    "--local", "--persist-to", stateRoot, "--config", configPath,
  ], { cwd: repositoryRoot, env: { ...process.env, CI: "1", NO_COLOR: "1" } });
  let logs = "";
  const child = spawn("pnpm", [
    "--dir", applicationRoot,
    "exec", "vite", "--config", "vite-demo.config.ts",
  ], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      ARTIFACT_SHARE_DEMO_CONFIG_PATH: configPath,
      ARTIFACT_SHARE_DEMO_STATE_PATH: stateRoot,
      ARTIFACT_SHARE_DEMO_HOST: "0.0.0.0",
      ARTIFACT_SHARE_DEMO_PORT: String(port),
      ARTIFACT_SHARE_DEMO_NO_OPEN: "1",
      CI: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => { logs = `${logs}${String(chunk)}`.slice(-20_000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolated local demo exited before becoming healthy.\n${logs}`);
    try {
      await health(loopbackOrigin);
      return {
        loopbackOrigin,
        async close() {
          await stopProcess(child);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      };
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
  await stopProcess(child);
  await rm(temporaryRoot, { recursive: true, force: true });
  throw new Error(`Isolated local demo did not become healthy.\n${logs}`);
};

const upload = async (origin, fixture, { authorization, browser = false, cookie } = {}) => {
  const form = new FormData();
  form.set("file", new File([fixture.bytes], fixture.name, { type: fixture.type }));
  form.set("expires_in_seconds", "3600");
  if (fixture.type === "application/pdf") {
    form.set("extraction_status", "unavailable");
    form.set("extraction_reason", "Minimal network transport fixture");
  } else {
    form.set("extraction_status", "not_applicable");
  }
  const response = await fetch(new URL(browser ? "/upload/artifacts" : "/api/artifacts", origin), {
    method: "POST",
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...(browser ? { origin: origin.origin } : {}),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: form,
    redirect: "manual",
  });
  const body = await response.json().catch(() => null);
  assert(response.status === 201, `Upload failed at ${origin} (${response.status} ${JSON.stringify(body)})`);
  assert(typeof body?.share_url === "string", "Upload response did not contain a share URL");
  return new URL(body.share_url);
};

const verify = async (shareUrl, fixture, expectedOrigin) => {
  assert(shareUrl.origin === expectedOrigin.origin, `Share URL used ${shareUrl.origin}, expected ${expectedOrigin.origin}`);
  const [page, manifestResponse, raw] = await Promise.all([
    fetch(shareUrl),
    fetch(new URL(`${shareUrl.pathname}/manifest`, shareUrl)),
    fetch(new URL(`${shareUrl.pathname}/raw`, shareUrl)),
  ]);
  assert(page.ok, `Viewer failed for ${fixture.name} (${page.status})`);
  assert(manifestResponse.ok, `Manifest failed for ${fixture.name} (${manifestResponse.status})`);
  assert(raw.ok, `Raw read failed for ${fixture.name} (${raw.status})`);
  const manifest = await manifestResponse.json();
  const rawBytes = Buffer.from(await raw.arrayBuffer());
  const checksum = await sourceSha256(fixture.bytes);
  assert(rawBytes.equals(fixture.bytes), `Raw bytes changed for ${fixture.name}`);
  assert(manifest.sha256 === checksum, `Checksum changed for ${fixture.name}`);
  assert(manifest.mime_type === fixture.type, `MIME type changed for ${fixture.name}`);
};

const runBridgeProof = async (origin, { token, openDevelopment = false } = {}) => {
  const result = await execute(
    "pnpm",
    ["--dir", "packages/agent-bridge", "exec", "vitest", "run", "test/network-live.test.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARTIFACT_SHARE_NETWORK_ORIGIN: origin.toString(),
        ...(openDevelopment ? { ARTIFACT_SHARE_NETWORK_OPEN_DEVELOPMENT: "1" } : {}),
        ...(token === undefined ? {} : { ARTIFACT_SHARE_TOKEN: token }),
      },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout);
};

let localDemo;
let tunnel;
try {
  const explicitOrigin = process.env.ARTIFACT_SHARE_DEMO_ORIGIN;
  localDemo = explicitOrigin === undefined ? await startIsolatedDemo() : undefined;
  const loopbackOrigin = explicitOrigin === undefined
    ? localDemo.loopbackOrigin
    : new URL(explicitOrigin);
  const lanOrigin = new URL(
    process.env.ARTIFACT_SHARE_LAN_ORIGIN ??
    `http://${findLanIpv4Address()}:${loopbackOrigin.port}`,
  );

  await health(loopbackOrigin);
  await health(lanOrigin);
  for (const fixture of formats) {
    await verify(await upload(lanOrigin, fixture, { browser: true }), fixture, lanOrigin);
  }
  await runBridgeProof(lanOrigin, { openDevelopment: true });
  process.stdout.write(`LAN proof passed at ${lanOrigin}: browser and shared bridge flows handled Markdown, HTML, and PDF with exact bytes.\n`);

  tunnel = await startQuickTunnel({
    targetOrigin: loopbackOrigin.toString(),
    ...(process.env.CLOUDFLARED_PATH === undefined ? {} : { cloudflaredPath: process.env.CLOUDFLARED_PATH }),
  });
  await health(tunnel.publicOrigin);
  const denied = await Promise.all([
    fetch(new URL("/upload/artifacts", tunnel.publicOrigin), { method: "POST", body: "anonymous" }),
    fetch(new URL("/api/artifacts", tunnel.publicOrigin), { method: "POST", body: "anonymous" }),
    fetch(new URL("/connect", tunnel.publicOrigin)),
  ]);
  assert(denied[0].status === 401 && denied[1].status === 401 && denied[2].status === 404,
    "Quick Tunnel did not deny anonymous browser upload, agent upload, and connection minting");
  const browserAuthorization = await fetch(new URL("/__artifact-share-tunnel/authorize", tunnel.publicOrigin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tunnel.uploadToken }),
    redirect: "manual",
  });
  assert(browserAuthorization.status === 303, `Quick Tunnel browser token entry returned ${browserAuthorization.status}`);
  const browserCookie = browserAuthorization.headers.get("set-cookie")?.split(";", 1)[0];
  assert(browserCookie !== undefined && !browserCookie.includes(tunnel.uploadToken), "Browser session cookie exposed the upload token");
  await verify(
    await upload(tunnel.publicOrigin, formats[0], { browser: true, cookie: browserCookie }),
    formats[0],
    tunnel.publicOrigin,
  );
  await runBridgeProof(tunnel.publicOrigin, { token: tunnel.uploadToken });
  process.stdout.write(`Quick Tunnel proof passed at ${tunnel.publicOrigin}: public reads work and shared bridge uploads require the process token.\n`);

  const gatewayOrigin = tunnel.gatewayOrigin;
  const child = tunnel.child;
  await tunnel.close();
  tunnel = undefined;
  await fetch(gatewayOrigin, { signal: AbortSignal.timeout(500) })
    .then(() => { throw new Error("Token gateway remained reachable after shutdown"); })
    .catch((error) => {
      if (error instanceof Error && error.message === "Token gateway remained reachable after shutdown") throw error;
    });
  assert(child.exitCode !== null || child.signalCode !== null, "cloudflared remained alive after shutdown");
  process.stdout.write("Quick Tunnel shutdown proof passed: cloudflared and the token gateway stopped together.\n");
} finally {
  await tunnel?.close();
  await localDemo?.close();
}
