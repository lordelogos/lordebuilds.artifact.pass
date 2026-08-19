import { spawn } from "node:child_process";

export const versionFor = async (command: string, options: {
  readonly args?: readonly string[];
  readonly timeoutMilliseconds?: number;
  readonly maxBytes?: number;
} = {}): Promise<string | undefined> => new Promise((resolveVersion) => {
  const child = spawn(command, [...(options.args ?? ["--version"])], {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const finish = (version: string | undefined): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolveVersion(version);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > (options.maxBytes ?? 64 * 1024)) {
      child.kill("SIGKILL");
      finish(undefined);
      return;
    }
    chunks.push(chunk);
  });
  child.once("error", () => finish(undefined));
  child.once("close", (code) => finish(code === 0
    ? Buffer.concat(chunks).toString("utf8").trim()
    : undefined));
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    finish(undefined);
  }, options.timeoutMilliseconds ?? 5_000);
});
