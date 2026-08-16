import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SESSION_COOKIE = "__Host-artifact-share-tunnel";
const TUNNEL_PATH = "/__artifact-share-tunnel";
const MAX_AUTH_BODY_BYTES = 8 * 1024;
const MAX_SESSIONS = 32;

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const html = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifact Share tunnel upload</title><style>body{font:16px/1.5 system-ui;max-width:34rem;margin:12vh auto;padding:1.5rem;color:#171717}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.8rem;margin-top:.5rem}button{margin-top:1rem}p{color:#555}</style></head><body>${body}</body></html>`;

const isLoopback = (address) =>
  address === "127.0.0.1" || address === "::1" || address.startsWith("127.");

export const findLanIpv4Address = (interfaces = networkInterfaces()) => {
  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (record.family === "IPv4" && !record.internal && !isLoopback(record.address)) {
        return record.address;
      }
    }
  }
  throw new Error("No active LAN IPv4 address was found. Connect this computer to the local network and try again.");
};

export const generateUploadToken = (bytes = randomBytes(32)) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32) {
    throw new Error("Quick Tunnel upload tokens require at least 32 random bytes");
  }
  return Buffer.from(bytes).toString("base64url");
};

const tokenMatches = (expected, candidate) => {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.byteLength === candidateBytes.byteLength &&
    timingSafeEqual(expectedBytes, candidateBytes);
};

const bearerToken = (authorization) => {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/u.exec(authorization ?? "");
  return match?.[1];
};

const cookieValues = (header) => new Map(
  (header ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator === -1 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }),
);

const publicOriginFor = (request) => {
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "http";
  return `${protocol === "https" ? "https" : "http"}://${request.headers.host}`;
};

const readBoundedBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_AUTH_BODY_BYTES) throw new Error("Authorization form is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const send = (response, status, headers, body = "") => {
  response.writeHead(status, headers);
  response.end(body);
};

const tunnelLoginPage = (failed = false) => html(`
  <main><h1>Unlock tunnel uploads</h1>
  <p>Public artifact links are readable without this token. Enter the temporary token shown by the tunnel helper to enable uploads in this browser session.</p>
  ${failed ? "<p role=\"alert\">That temporary token was not accepted.</p>" : ""}
  <form method="post" action="${TUNNEL_PATH}/authorize" autocomplete="off">
    <label>Temporary upload token<input name="token" type="password" required autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <button type="submit">Continue to upload</button>
  </form></main>`);

const pipeWebBody = async (body, response) => {
  if (body === null) {
    response.end();
    return;
  }
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!response.write(Buffer.from(value))) {
      await new Promise((resolve) => response.once("drain", resolve));
    }
  }
  response.end();
};

const rewriteUploadResponse = async (upstream, externalOrigin) => {
  const body = await upstream.json();
  if (typeof body?.share_url === "string") {
    const localShare = new URL(body.share_url);
    body.share_url = new URL(`${localShare.pathname}${localShare.search}`, externalOrigin).toString();
  }
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
};

export const createTunnelGateway = async ({
  targetOrigin,
  uploadToken = generateUploadToken(),
  hostname = "127.0.0.1",
  port = 0,
  fetchImplementation = globalThis.fetch,
} = {}) => {
  const target = new URL(targetOrigin);
  if (target.protocol !== "http:" || !isLoopback(target.hostname)) {
    throw new Error("The Quick Tunnel gateway target must be a loopback HTTP origin");
  }
  const health = await fetchImplementation(new URL("/health", target), { redirect: "manual" });
  if (!health.ok) throw new Error(`The local Artifact Share demo is not healthy (${health.status})`);

  const sessions = new Set();
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", publicOriginFor(request));
      if (requestUrl.pathname.startsWith("/__local-test/")) {
        send(response, 404, securityHeaders);
        return;
      }
      if (requestUrl.pathname === "/connect" || requestUrl.pathname.startsWith("/connect/")) {
        send(response, 404, securityHeaders);
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === `${TUNNEL_PATH}/upload`) {
        send(response, 200, { ...securityHeaders, "content-type": "text/html; charset=utf-8" }, tunnelLoginPage());
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === `${TUNNEL_PATH}/authorize`) {
        const body = new URLSearchParams(await readBoundedBody(request));
        const supplied = body.get("token") ?? "";
        if (!tokenMatches(uploadToken, supplied)) {
          send(response, 401, { ...securityHeaders, "content-type": "text/html; charset=utf-8" }, tunnelLoginPage(true));
          return;
        }
        const session = generateUploadToken();
        sessions.add(session);
        if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.values().next().value);
        send(response, 303, {
          ...securityHeaders,
          location: "/upload",
          "set-cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict`,
        });
        return;
      }

      const isBrowserUpload = requestUrl.pathname === "/upload/artifacts" && request.method === "POST";
      const isAgentUpload = requestUrl.pathname === "/api/artifacts" && request.method === "POST";
      const isUpload = isBrowserUpload || isAgentUpload;
      const suppliedBearer = bearerToken(request.headers.authorization);
      const session = cookieValues(request.headers.cookie).get(SESSION_COOKIE);
      const bearerAuthorized = suppliedBearer !== undefined && tokenMatches(uploadToken, suppliedBearer);
      const sessionAuthorized = session !== undefined && sessions.has(session);
      if (isUpload && !bearerAuthorized && !sessionAuthorized) {
        send(response, 401, {
          ...securityHeaders,
          "content-type": "application/json; charset=utf-8",
        }, JSON.stringify({ error: { code: "upload_token_required", message: "A temporary Quick Tunnel upload token is required" } }));
        return;
      }
      if (isBrowserUpload && sessionAuthorized) {
        const origin = request.headers.origin;
        if (origin === undefined || origin !== requestUrl.origin) {
          send(response, 403, securityHeaders);
          return;
        }
      }

      const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, target);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        const tunnelMetadata = name.startsWith("cf-") || name.startsWith("x-forwarded-");
        if (value !== undefined && !tunnelMetadata && !["host", "connection", "transfer-encoding", "authorization", "cookie"].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      if (isBrowserUpload) headers.set("origin", target.origin);
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request;
      let upstream = await fetchImplementation(upstreamUrl, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        ...(body === undefined ? {} : { duplex: "half" }),
      });
      if (isUpload && upstream.headers.get("content-type")?.includes("application/json")) {
        upstream = await rewriteUploadResponse(upstream, requestUrl.origin);
      }
      const responseHeaders = Object.fromEntries(upstream.headers);
      const location = upstream.headers.get("location");
      if (location !== null) {
        const resolved = new URL(location, target);
        if (resolved.origin === target.origin) {
          responseHeaders.location = new URL(`${resolved.pathname}${resolved.search}`, requestUrl.origin).toString();
        }
      }
      response.writeHead(upstream.status, responseHeaders);
      if (request.method === "HEAD") response.end();
      else await pipeWebBody(upstream.body, response);
    } catch (error) {
      if (!response.headersSent) {
        send(response, 502, { ...securityHeaders, "content-type": "text/plain; charset=utf-8" }, "Tunnel gateway could not reach the local demo.");
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not bind the tunnel gateway");
  let closed = false;
  return {
    uploadToken,
    localOrigin: new URL(`http://${hostname}:${address.port}`),
    async close() {
      if (closed) return;
      closed = true;
      sessions.clear();
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  };
};

export const parseQuickTunnelUrl = (text) => {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/iu.exec(text);
  return match === null ? undefined : new URL(match[0]);
};

export const quickTunnelArguments = (configPath, gatewayOrigin) => [
  "tunnel",
  "--config", configPath,
  "--url", gatewayOrigin,
  "--no-autoupdate",
  "--protocol", "http2",
];

const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
};

export const startQuickTunnel = async ({
  targetOrigin = "http://127.0.0.1:8787",
  cloudflaredPath = "cloudflared",
  spawnProcess = spawn,
  timeoutMs = 30_000,
  readinessDelayMs = 5_000,
  readinessTimeoutMs = 30_000,
  fetchImplementation = globalThis.fetch,
} = {}) => {
  const gateway = await createTunnelGateway({ targetOrigin, fetchImplementation });
  const configRoot = await mkdtemp(join(tmpdir(), "artifact-share-cloudflared-"));
  const configPath = join(configRoot, "config.yaml");
  await writeFile(configPath, "{}\n", { mode: 0o600 });
  let child;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([
      ...(child === undefined ? [] : [stopChild(child)]),
      gateway.close(),
      rm(configRoot, { recursive: true, force: true }),
    ]);
  };
  try {
    child = spawnProcess(
      cloudflaredPath,
      quickTunnelArguments(configPath, gateway.localOrigin.toString()),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    await cleanup();
    throw new Error(`Could not start cloudflared: ${error instanceof Error ? error.message : "process launch failed"}`);
  }
  let output = "";
  let settled = false;
  let timer;
  const publicOrigin = await new Promise((resolve, reject) => {
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(url);
    };
    const inspect = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-24_000);
      const found = parseQuickTunnelUrl(output);
      if (found !== undefined) finish(undefined, found);
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", (error) => finish(new Error(`Could not start cloudflared: ${error.message}. Install it with Homebrew: brew install cloudflared`)));
    child.once("exit", (code) => finish(new Error(`cloudflared exited before creating a Quick Tunnel (${code ?? "signal"}). ${output.trim()}`)));
    timer = setTimeout(() => finish(new Error(`cloudflared did not create a Quick Tunnel within ${timeoutMs}ms. ${output.trim()}`)), timeoutMs);
  }).catch(async (error) => {
    await cleanup();
    throw error;
  });
  if (readinessDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, readinessDelayMs));
  }
  const readinessDeadline = Date.now() + readinessTimeoutMs;
  let lastReadiness = "no edge response";
  while (true) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await cleanup();
      throw new Error("cloudflared exited while the Quick Tunnel was becoming reachable");
    }
    try {
      const health = await fetchImplementation(new URL("/health", publicOrigin), { redirect: "manual" });
      if (health.ok) break;
      lastReadiness = `HTTP ${health.status}`;
    } catch (error) {
      // A new trycloudflare hostname can take a moment to resolve and reach the edge.
      lastReadiness = error instanceof Error ? error.message : "network error";
    }
    if (Date.now() >= readinessDeadline) {
      await cleanup();
      throw new Error(`Quick Tunnel was created but did not become reachable within ${readinessTimeoutMs}ms (${lastReadiness}). ${output.trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.once("exit", () => {
    void cleanup();
  });
  return {
    publicOrigin,
    browserUploadUrl: new URL(`${TUNNEL_PATH}/upload`, publicOrigin),
    uploadToken: gateway.uploadToken,
    gatewayOrigin: gateway.localOrigin,
    child,
    async close() {
      await cleanup();
    },
  };
};

const parseArguments = (arguments_) => {
  const result = { targetOrigin: "http://127.0.0.1:8787", cloudflaredPath: "cloudflared" };
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--origin" && arguments_[index + 1] !== undefined) result.targetOrigin = arguments_[++index];
    else if (arguments_[index] === "--cloudflared" && arguments_[index + 1] !== undefined) result.cloudflaredPath = arguments_[++index];
    else throw new Error(`Unknown tunnel option: ${arguments_[index]}`);
  }
  return result;
};

export const runQuickTunnelCli = async (arguments_ = process.argv.slice(2)) => {
  const session = await startQuickTunnel(parseArguments(arguments_));
  process.stdout.write([
    "Artifact Share Quick Tunnel is ready.",
    `Public reads: ${session.publicOrigin}`,
    `Browser upload entry: ${session.browserUploadUrl}`,
    "For an agent bridge process, set ARTIFACT_SHARE_BASE_URL to the public origin, ARTIFACT_SHARE_WORKSPACE_ROOTS to its absolute approved roots, and pass the temporary token only as ARTIFACT_SHARE_TOKEN.",
    "Do not enable ARTIFACT_SHARE_OPEN_DEVELOPMENT for the public HTTPS tunnel and do not save the token in shared config.",
    "Temporary upload token (shown once):",
    session.uploadToken,
    "Press Ctrl+C to stop the tunnel and token gateway.",
    "",
  ].join("\n"));
  const shutdown = async () => {
    await session.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  return session;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runQuickTunnelCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Quick Tunnel failed"}\n`);
    process.exitCode = 1;
  });
}
