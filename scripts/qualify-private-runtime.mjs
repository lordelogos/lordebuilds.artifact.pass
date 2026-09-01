import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) {
    throw new Error(`Missing ${name}`);
  }
  return process.argv[index + 1];
};

const mcpConfigPath = resolve(valueAfter("--mcp-config"));
const localConfigPath = resolve(valueAfter("--local-config"));
const workspace = resolve(valueAfter("--workspace"));
const expectedOrigin = new URL(valueAfter("--expected-origin")).origin;
const expectedProfile = valueAfter("--expected-profile");
const awaitExpiry = process.argv.includes("--await-expiry");
const capabilityPath = process.argv.includes("--capability-path")
  ? resolve(valueAfter("--capability-path"))
  : undefined;
const fixtureBytes = Buffer.from([
  "# Private deployment qualification",
  "",
  "This exact Markdown artifact proves private publish and read interoperability.",
  "",
].join("\n"), "utf8");

const configuration = JSON.parse(await readFile(mcpConfigPath, "utf8"));
const server = configuration?.mcpServers?.artifactpass;
if (
  typeof server?.command !== "string" ||
  !Array.isArray(server.args) ||
  !server.args.every((argument) => typeof argument === "string")
) {
  throw new Error("The portable ArtifactPass MCP configuration is invalid");
}

const qualificationDirectory = await mkdtemp(join(workspace, ".artifactpass-private-runtime-"));
const fixturePath = resolve(qualificationDirectory, "private-runtime-qualification.md");
let capabilityCreated = false;

const inheritedEnvironmentNames = [
  "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER", "XDG_CACHE_HOME",
];
const environment = Object.fromEntries(inheritedEnvironmentNames.flatMap((name) => {
  const value = process.env[name];
  return value === undefined ? [] : [[name, value]];
}));
environment.ARTIFACTPASS_CONFIG_PATH = localConfigPath;
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  cwd: dirname(mcpConfigPath),
  env: environment,
  stderr: "pipe",
});
const client = new Client({ name: "artifactpass-private-runtime-qualification", version: "1" });
const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

const call = async (name, args, timeout = 30_000) => {
  const result = await client.callTool({ name, arguments: args }, { timeout });
  if (result.isError === true) {
    throw new Error(result.content?.map((item) => item.type === "text" ? item.text : "").join("\n") || `${name} failed`);
  }
  return result.structuredContent;
};

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const waitForConnection = async () => {
  let state = await call("connection_status", { workspace_path: fixturePath });
  if (state.status === "disconnected") {
    state = await call("connect_artifactpass", { workspace_path: fixturePath });
    process.stdout.write(`${JSON.stringify({
      event: "approval-required",
      approval_url: state.approval_url,
      user_code: state.user_code,
      browser_opened: state.browser_opened,
    })}\n`);
  }
  const deadline = Date.now() + 10 * 60 * 1_000;
  while (state.status !== "connected") {
    if (state.status === "failed") throw new Error(state.message ?? "Private connection failed");
    if (Date.now() >= deadline) throw new Error("Private connection approval timed out");
    await sleep(1_000);
    state = await call("connection_status", { workspace_path: fixturePath });
  }
  return state;
};

try {
  await writeFile(fixturePath, fixtureBytes, { flag: "wx", mode: 0o600 });
  await client.connect(transport, { timeout: 15_000 });
  const listed = await client.listTools({}, { timeout: 15_000 });
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  const expectedTools = ["connect_artifactpass", "connection_status", "publish_artifact", "read_artifact"];
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
    throw new Error("The private MCP surface does not match the four-tool contract");
  }

  const connection = await waitForConnection();
  if (connection.origin !== expectedOrigin || connection.profile !== expectedProfile) {
    throw new Error("Private connection did not match the expected deployment profile and origin");
  }
  const published = await call("publish_artifact", {
    path: fixturePath,
    expires_in_seconds: 900,
  }, 60_000);
  const chunks = [];
  let cursor;
  do {
    const chunk = await call("read_artifact", {
      share_url: published.share_url,
      representation: "source",
      ...(cursor === undefined ? {} : { cursor }),
    });
    chunks.push(Buffer.from(chunk.data, "base64"));
    cursor = chunk.next_cursor ?? undefined;
  } while (cursor !== undefined);
  const received = Buffer.concat(chunks);
  const sourceSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  if (capabilityPath !== undefined) {
    await writeFile(capabilityPath, published.share_url, { encoding: "utf8", flag: "wx", mode: 0o600 });
    capabilityCreated = true;
  }
  const evidence = {
    event: "private-runtime-passed",
    profile: connection.profile,
    origin: connection.origin,
    tools: toolNames,
    artifact_id: published.manifest.artifact_id,
    source_sha256: sourceSha256,
    manifest_sha256: published.manifest.sha256,
    exact_bytes: received.equals(fixtureBytes),
    byte_size: received.byteLength,
    mime_type: published.manifest.mime_type,
    expires_at: published.manifest.expires_at,
  };
  if (!evidence.exact_bytes || evidence.source_sha256 !== evidence.manifest_sha256) {
    throw new Error("Private publish/read evidence did not match the exact source");
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`);

  if (awaitExpiry) {
    const waitMilliseconds = Math.max(0, Date.parse(published.manifest.expires_at) - Date.now() + 2_000);
    await sleep(waitMilliseconds);
    const expiredRead = await client.callTool({
      name: "read_artifact",
      arguments: { share_url: published.share_url, representation: "source" },
    }, { timeout: 30_000 });
    const expiredDetail = expiredRead.content
      ?.map((item) => item.type === "text" ? item.text : "")
      .join("\n") ?? "";
    if (expiredRead.isError !== true || !expiredDetail.includes("ArtifactPass request failed: expired")) {
      throw new Error("An expired private artifact remained accessible");
    }
    const health = await fetch(new URL("/health", connection.origin), { redirect: "error" });
    if (!health.ok) throw new Error("Private deployment health failed during expiry verification");
    process.stdout.write(`${JSON.stringify({
      event: "private-expiry-passed",
      artifact_id: published.manifest.artifact_id,
      agent_read_refused: true,
    })}\n`);
  }
} catch (error) {
  const detail = stderr.join("").trim();
  throw new Error(detail.length === 0 ? String(error) : `${String(error)}\n${detail}`);
} finally {
  if (capabilityPath !== undefined && capabilityCreated) await unlink(capabilityPath).catch(() => undefined);
  await rm(qualificationDirectory, { recursive: true, force: true });
  await client.close().catch(() => undefined);
}
