import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (command === undefined) throw new Error("ArtifactPass eval MCP launcher requires a command");

const environment: Record<string, string> = {};
for (const key of [
  "PATH",
  "HOME",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "ARTIFACTPASS_CONFIG_PATH",
  "ARTIFACTPASS_OPEN_DEVELOPMENT",
  "ARTIFACTPASS_WORKSPACE_ROOTS",
]) {
  const value = process.env[key];
  if (value !== undefined) environment[key] = value;
}

const child = spawn(command, args, {
  env: environment,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", (error) => {
  process.stderr.write(`ArtifactPass eval MCP launch failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
