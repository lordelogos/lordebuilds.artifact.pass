import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.ok(Number.parseInt(process.versions.node, 10) < 22, "Run this check with Node older than 22");

const cli = resolve("packages/setup-cli/dist/cli.mjs");
const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /slack setup/u);

const configRoot = await mkdtemp(join(tmpdir(), "artifactpass-cli-runtime-"));
try {
  await new Promise((resolveReady, reject) => {
    const child = spawn(process.execPath, [cli, "slack", "setup"], {
      env: { ...process.env, XDG_CONFIG_HOME: configRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    let ready = false;
    const timeout = setTimeout(() => {
      child.kill("SIGINT");
      reject(new Error(`Slack wizard did not start: ${errorOutput.slice(0, 500)}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!output.includes("Slack archive setup is ready")) return;
      ready = true;
      child.kill("SIGINT");
    });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (ready) resolveReady();
      else reject(new Error(`Slack wizard exited with ${code}: ${errorOutput.slice(0, 500)}`));
    });
  });
} finally {
  await rm(configRoot, { recursive: true, force: true });
}

process.stdout.write("CLI help and Slack wizard start under Node 20.\n");
