import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve } from "node:path";

const localRequire = createRequire(
  typeof __filename === "string" ? __filename : import.meta.url,
);

const wranglerNode = (): string => {
  if (Number.parseInt(process.versions.node, 10) >= 22) return process.execPath;
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  for (const directory of (process.env[pathKey] ?? "").split(delimiter)) {
    if (!directory) continue;
    const executable = resolve(directory, executableName);
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 1_500,
      windowsHide: true,
    });
    const major = Number.parseInt(/^v(\d+)\./u.exec(result.stdout?.trim() ?? "")?.[1] ?? "", 10);
    if (result.status === 0 && major >= 22) return executable;
  }
  throw new Error("Cloudflare setup requires Node.js 22 or newer to run Wrangler. Install it, then retry this step.");
};

const resolvedCommand = (command: string, args: readonly string[]): {
  readonly command: string;
  readonly args: readonly string[];
} => {
  if (command !== "wrangler") return { command, args };
  const wranglerMain = localRequire.resolve("wrangler");
  const wranglerBin = resolve(dirname(wranglerMain), "../bin/wrangler.js");
  return { command: wranglerNode(), args: [wranglerBin, ...args] };
};

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
  readonly timeoutMilliseconds?: number;
  readonly inheritEnvironment?: boolean;
  readonly onOutput?: (chunk: string) => void;
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
      env: options.inheritEnvironment === false
        ? { ...options.env }
        : { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let settled = false;
    const timeoutMilliseconds = options.timeoutMilliseconds ?? 10 * 60 * 1000;
    let timeout: ReturnType<typeof setTimeout>;
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    timeout = setTimeout(() => {
      finishWithError(new Error(`${command} timed out after ${timeoutMilliseconds}ms`));
    }, timeoutMilliseconds);
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputSize += chunk.byteLength;
      if (outputSize > 1024 * 1024) {
        finishWithError(new Error(`${command} produced excessive output`));
        return;
      }
      target.push(chunk);
      options.onOutput?.(chunk.toString("utf8"));
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => finishWithError(error));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} failed with status ${code ?? "unknown"}: ${result.stderr.trim()}`));
    });
    child.stdin.end(options.input);
  });
