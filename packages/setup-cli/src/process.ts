import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const localRequire = createRequire(import.meta.url);

const resolvedCommand = (command: string, args: readonly string[]): {
  readonly command: string;
  readonly args: readonly string[];
} => {
  if (command !== "wrangler") return { command, args };
  const wranglerMain = localRequire.resolve("wrangler");
  const wranglerBin = resolve(dirname(wranglerMain), "../bin/wrangler.js");
  return { command: process.execPath, args: [wranglerBin, ...args] };
};

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

export const runProcess: ProcessRunner = async (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const executable = resolvedCommand(command, args);
    const child = spawn(executable.command, [...executable.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputSize += chunk.byteLength;
      if (outputSize > 1024 * 1024) {
        child.kill();
        reject(new Error(`${command} produced excessive output`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} failed with status ${code ?? "unknown"}: ${result.stderr.trim()}`));
    });
    child.stdin.end(options.input);
  });
