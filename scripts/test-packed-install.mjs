import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execute = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifactpass-packed-install-"));
let healthServer;

const startHealthServer = async () => {
  const source = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ protocol_version: 1, error: { code: "not_found", message: "Route is unavailable" } }));
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise((resolvePort, reject) => {
    const timeout = setTimeout(() => reject(new Error("Packed install health server did not start")), 5_000);
    lines.once("line", (line) => {
      clearTimeout(timeout);
      resolvePort(Number(line));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null) reject(new Error(`Packed install health server exited with ${code}`));
    });
  });
  return { child, port };
};

try {
  const archiveDirectory = resolve(temporaryRoot, "archive");
  const installDirectory = resolve(temporaryRoot, "install");
  const workspace = resolve(temporaryRoot, "workspace");
  const configurationHome = resolve(temporaryRoot, "config");
  const home = resolve(temporaryRoot, "home");
  await Promise.all([
    mkdir(archiveDirectory),
    mkdir(installDirectory),
    mkdir(workspace),
    mkdir(configurationHome),
    mkdir(home),
  ]);
  await execute("pnpm", [
    "--dir", "packages/setup-cli", "pack", "--pack-destination", archiveDirectory,
  ], { cwd: repositoryRoot });
  const archives = (await readdir(archiveDirectory)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Packed install test expected exactly one archive");
  const archive = resolve(archiveDirectory, archives[0]);
  await writeFile(resolve(installDirectory, "package.json"), JSON.stringify({
    private: true,
    packageManager: "pnpm@10.11.0",
  }));
  await execute("pnpm", ["add", archive, "--ignore-scripts"], { cwd: installDirectory });
  const cli = resolve(installDirectory, "node_modules", "artifactpass", "dist", "cli.mjs");
  healthServer = await startHealthServer();
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configurationHome,
  };
  const args = [
    cli,
    "install",
    "--base-url", `http://127.0.0.1:${healthServer.port}`,
    "--open-development",
    "--agent", "gemini",
    "--workspace-root", workspace,
    "--json",
  ];
  const runInstall = async () => {
    const result = await execute(process.execPath, args, {
      cwd: workspace,
      env: environment,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  };

  const first = await runInstall();
  const second = await runInstall();
  for (const receipt of [first, second]) {
    if (
      receipt.receipt_version !== 3 ||
      receipt.product !== "ArtifactPass" ||
      receipt.status !== "success" ||
      receipt.profile !== "local" ||
      JSON.stringify(receipt.adapters) !== JSON.stringify(["gemini"]) ||
      receipt.portable_bundle?.host_registration !== "installed" ||
      receipt.mcp?.negotiated !== true ||
      JSON.stringify(receipt.mcp.tools) !== JSON.stringify([
        "connect_artifactpass", "connection_status", "publish_artifact", "read_artifact",
      ]) ||
      receipt.skills?.verified !== true
    ) {
      throw new Error(`Packed install returned an invalid receipt: ${JSON.stringify(receipt)}`);
    }
    if (/as_[A-Za-z0-9_-]{43}/u.test(JSON.stringify(receipt))) {
      throw new Error("Packed install receipt exposed an agent token");
    }
  }
  if (first.portable_bundle.sha256 !== second.portable_bundle.sha256) {
    throw new Error("Packed install rerun changed the canonical portable bundle");
  }
  const settings = JSON.parse(await readFile(
    resolve(configurationHome, "artifactpass", "config.json"),
    "utf8",
  ));
  if (
    settings.active_profile !== "local" ||
    JSON.stringify(Object.keys(settings.profiles)) !== JSON.stringify(["local"])
  ) {
    throw new Error("Packed install rerun duplicated or changed the active profile");
  }
  const geminiConfig = JSON.parse(await readFile(
    resolve(workspace, ".gemini", "settings.json"),
    "utf8",
  ));
  if (
    geminiConfig.mcpServers?.artifactpass?.command !== process.execPath ||
    !Array.isArray(geminiConfig.mcpServers?.artifactpass?.args) ||
    geminiConfig.mcpServers.artifactpass.args.length !== 1
  ) {
    throw new Error("Packed install did not register ArtifactPass for Gemini CLI");
  }
  await readFile(resolve(workspace, ".gemini", "skills", "share-artifact", "SKILL.md"));
  await readFile(resolve(workspace, ".gemini", "skills", "read-shared-artifact", "SKILL.md"));
  process.stdout.write(`Packed one-command install passed: Gemini project setup, MCP smoke, skills, receipt, and rerun repair are valid (${first.portable_bundle.sha256}).\n`);
} finally {
  healthServer?.child.kill();
  await rm(temporaryRoot, { recursive: true, force: true });
}
