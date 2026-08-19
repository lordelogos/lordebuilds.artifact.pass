import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServer } from "node:net";

import { createLocalDemoConfiguration } from "../../../apps/artifact-service/src/demo/local-demo-config";

const RUN_PREFIX = "artifactpass-eval-";
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface LocalEvalEnvironment {
  readonly runId: string;
  readonly root: string;
  readonly baseUrl: URL;
  readonly stateRoot: string;
  readonly configPath: string;
  readonly receiptRoot: string;
  readonly workspaces: { readonly agentA: string; readonly agentB: string };
  readonly homes: { readonly agentA: string; readonly agentB: string };
  readonly controlToken: string;
  readonly pdfPrivateKey: string;
  readonly stop: () => Promise<void>;
}

interface CleanupJournal {
  readonly version: 1;
  readonly run_id: string;
  readonly owner_pid: number;
  readonly created_at: number;
  readonly worker_pid?: number;
}

const base64 = (value: ArrayBuffer): string => Buffer.from(value).toString("base64");

const freeLoopbackPort = async (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate an ArtifactPass eval port"));
      return;
    }
    server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
  });
});

export const assertLoopbackOrigin = (origin: URL): void => {
  if (
    origin.protocol !== "http:" ||
    (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost" && origin.hostname !== "[::1]") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("Routine ArtifactPass evals require a plain loopback HTTP origin");
  }
};

export const assertRoutineNetworkTarget = (target: URL, origin: URL): void => {
  assertLoopbackOrigin(origin);
  if (target.origin !== origin.origin) {
    throw new Error("Routine ArtifactPass eval network access escaped its local service origin");
  }
};

const canonicalExistingParent = async (path: string): Promise<string> => {
  let cursor = resolve(path);
  while (true) {
    try {
      return await realpath(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
};

export const assertPathWithinRoot = async (root: string, target: string): Promise<void> => {
  if (!isAbsolute(root) || !isAbsolute(target)) throw new Error("Eval containment paths must be absolute");
  const resolvedRoot = resolve(root);
  const canonicalRoot = await realpath(root);
  const resolvedTarget = resolve(target);
  const lexicalRelative = relative(resolvedRoot, resolvedTarget);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new Error("Eval path escaped its disposable root");
  }
  if (resolvedTarget === resolvedRoot) return;
  const canonicalParent = await canonicalExistingParent(dirname(resolvedTarget));
  const physicalRelative = relative(canonicalRoot, canonicalParent);
  if (physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) {
    throw new Error("Eval path escaped its disposable root through a symbolic link");
  }
};

export const createLocalEvalProcessEnvironment = (home: string): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CI: "1",
    NO_COLOR: "1",
  };
  for (const key of ["PATH", "TMPDIR", "SYSTEMROOT", "WINDIR"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

const runChecked = async (options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
}): Promise<void> => new Promise((resolveRun, reject) => {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error === undefined) resolveRun();
    else reject(error);
  };
  const capture = (chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
      stopProcess(child).finally(() => finish(new Error("Eval setup command produced excessive output")));
      return;
    }
    output.push(chunk);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("error", (error) => finish(error));
  child.once("close", (code) => finish(code === 0 ? undefined : new Error(
    `Eval setup command failed (${code ?? "signal"}): ${Buffer.concat(output).toString("utf8").slice(-4000)}`,
  )));
  const timeout = setTimeout(() => {
    stopProcess(child).finally(() => finish(new Error("Eval setup command timed out")));
  }, options.timeoutMilliseconds);
});

const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
  if (child?.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (graceful) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await exited;
};

const waitForHealth = async (baseUrl: URL, child: ChildProcess, processOutput: () => string): Promise<void> => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local eval Worker exited early: ${processOutput()}`);
    try {
      const response = await fetch(new URL("/health", baseUrl));
      if (response.ok) return;
    } catch {
      // The local Worker is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Local eval Worker did not become healthy: ${processOutput()}`);
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const reapOrphanedLocalEvalEnvironments = async (): Promise<readonly string[]> => {
  const removed: string[] = [];
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_PREFIX)) continue;
    const root = join(tmpdir(), entry.name);
    try {
      const metadata = await lstat(root);
      if (metadata.isSymbolicLink()) continue;
      const journal = JSON.parse(await readFile(join(root, "cleanup-journal.json"), "utf8")) as CleanupJournal;
      if (journal.version !== 1 || isProcessAlive(journal.owner_pid)) continue;
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
      removed.push(journal.run_id);
    } catch {
      // Unknown or active-looking directories are never removed speculatively.
    }
  }
  return removed;
};

export const startLocalEvalEnvironment = async (repositoryRoot: string): Promise<LocalEvalEnvironment> => {
  await reapOrphanedLocalEvalEnvironments();
  const runId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), RUN_PREFIX));
  await chmod(root, 0o700);
  let worker: ChildProcess | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopProcess(worker);
    await assertPathWithinRoot(root, root);
    await rm(root, { recursive: true, force: true, maxRetries: 2 });
  };
  try {
    const applicationRoot = join(repositoryRoot, "apps/artifact-service");
    const stateRoot = join(root, "cloudflare-state");
    const configPath = join(root, "wrangler-eval.jsonc");
    const receiptRoot = join(root, "receipts");
    const workspaces = {
      agentA: join(root, "workspaces", "agent-a"),
      agentB: join(root, "workspaces", "agent-b"),
    } as const;
    const homes = {
      agentA: join(root, "homes", "agent-a"),
      agentB: join(root, "homes", "agent-b"),
    } as const;
    await Promise.all([
      mkdir(stateRoot, { recursive: true, mode: 0o700 }),
      mkdir(receiptRoot, { recursive: true, mode: 0o700 }),
      ...Object.values(workspaces).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
      ...Object.values(homes).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    ]);
    const port = await freeLoopbackPort();
    const baseUrl = new URL(`http://127.0.0.1:${port}`);
    assertLoopbackOrigin(baseUrl);
    const controlToken = randomBytes(32).toString("base64url");
    const generatedKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pdfKeys = generatedKeys as unknown as {
      readonly privateKey: Parameters<typeof crypto.subtle.exportKey>[1];
      readonly publicKey: Parameters<typeof crypto.subtle.exportKey>[1];
    };
    const pdfPrivateKey = base64(await crypto.subtle.exportKey("pkcs8", pdfKeys.privateKey));
    const pdfPublicKey = base64(await crypto.subtle.exportKey("raw", pdfKeys.publicKey));
    await writeFile(configPath, `${JSON.stringify(createLocalDemoConfiguration({
      name: `artifactpass-eval-${runId.slice(0, 8)}`,
      workerEntry: join(applicationRoot, "src/demo/index.ts"),
      migrationsRoot: join(applicationRoot, "migrations"),
      controlToken,
      pdfPublicKey,
    }), null, 2)}\n`, { mode: 0o600 });
    const journalPath = join(root, "cleanup-journal.json");
    const journal: CleanupJournal = {
      version: 1,
      run_id: runId,
      owner_pid: process.pid,
      created_at: Date.now(),
    };
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

    const wranglerBin = join(applicationRoot, "node_modules/wrangler/bin/wrangler.js");
    const viteBin = join(applicationRoot, "node_modules/vite/bin/vite.js");
    await Promise.all([access(wranglerBin), access(viteBin)]);
    const environment = createLocalEvalProcessEnvironment(homes.agentA);
    await runChecked({
      command: process.execPath,
      args: [
        wranglerBin,
        "d1",
        "migrations",
        "apply",
        "ARTIFACT_DB",
        "--local",
        "--persist-to",
        stateRoot,
        "--config",
        configPath,
      ],
      cwd: repositoryRoot,
      env: environment,
      timeoutMilliseconds: 60_000,
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    worker = spawn(process.execPath, [viteBin, "--config", join(applicationRoot, "vite-demo.config.ts")], {
      cwd: applicationRoot,
      env: {
        ...environment,
        ARTIFACT_SHARE_DEMO_CONFIG_PATH: configPath,
        ARTIFACT_SHARE_DEMO_STATE_PATH: stateRoot,
        ARTIFACT_SHARE_DEMO_HOST: "127.0.0.1",
        ARTIFACT_SHARE_DEMO_PORT: String(port),
        ARTIFACT_SHARE_DEMO_NO_OPEN: "1",
      },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_PROCESS_OUTPUT_BYTES) output.push(chunk);
    };
    worker.stdout?.on("data", capture);
    worker.stderr?.on("data", capture);
    await writeFile(journalPath, `${JSON.stringify({ ...journal, worker_pid: worker.pid })}\n`, { mode: 0o600 });
    await waitForHealth(baseUrl, worker, () => Buffer.concat(output).toString("utf8").slice(-4000));

    return {
      runId,
      root,
      baseUrl,
      stateRoot,
      configPath,
      receiptRoot,
      workspaces,
      homes,
      controlToken,
      pdfPrivateKey,
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
};

export const localEnvironmentExists = async (environment: LocalEvalEnvironment): Promise<boolean> =>
  stat(environment.root).then(() => true, () => false);
