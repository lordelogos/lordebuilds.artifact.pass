import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  installReceiptVersion,
  parseArtifactpassInstallReceipt,
  type ArtifactpassInstallReceipt,
} from "../../setup-cli/src/installer";

export { installReceiptVersion };

import { connectGenericMcpHost } from "./hosts/generic";
import {
  assertPathWithinRoot,
  assertRoutineNetworkTarget,
  createLocalEvalProcessEnvironment,
  type LocalEvalEnvironment,
} from "./local-environment";

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface PackedEvalCandidate {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly packageRoot: string;
  readonly cliPath: string;
}

export interface EvalInstallResult {
  readonly receipt: ArtifactpassInstallReceipt;
  readonly profileCount: number;
  readonly portableBundleCount: number;
  readonly registrationCount: number;
  readonly hostRestartVerified: boolean;
  readonly candidateArchiveSha256: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class EvalInstallLifecycleError extends Error {
  public constructor(
    message: string,
    public readonly commandResult: CommandResult,
    public readonly receipt?: ArtifactpassInstallReceipt,
  ) {
    super(message);
    this.name = "EvalInstallLifecycleError";
  }
}

const stopProcess = async (child: ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null) return;
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

const runCommand = async (options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly signal?: AbortSignal;
}): Promise<CommandResult> => new Promise((resolveCommand, reject) => {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let failure: Error | undefined;
  let settled = false;
  const capture = (target: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
      failure ??= new Error("ArtifactPass eval install command produced excessive output");
      void stopProcess(child);
      return;
    }
    target.push(chunk);
  };
  child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
  child.once("error", (error) => { failure ??= error; });
  const abort = (): void => {
    failure ??= new Error("ArtifactPass eval install command was cancelled");
    void stopProcess(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted === true) abort();
  const timeout = setTimeout(() => {
    failure ??= new Error("ArtifactPass eval install command timed out");
    void stopProcess(child);
  }, options.timeoutMilliseconds);
  child.once("close", (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    const result = {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode,
      signal,
    };
    if (failure !== undefined) {
      reject(new EvalInstallLifecycleError(failure.message, result));
      return;
    }
    resolveCommand(result);
  });
});

const sha256File = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const packagePreparationEnvironment = (): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = { CI: "1", NO_COLOR: "1" };
  for (const key of ["PATH", "HOME", "XDG_DATA_HOME", "PNPM_HOME", "SYSTEMROOT", "WINDIR"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

const candidatePromises = new WeakMap<LocalEvalEnvironment, Promise<PackedEvalCandidate>>();

const preparePackedCandidate = async (options: {
  readonly environment: LocalEvalEnvironment;
  readonly repositoryRoot: string;
}): Promise<PackedEvalCandidate> => {
  const candidateRoot = join(options.environment.root, "packed-candidate");
  const archiveRoot = join(candidateRoot, "archive");
  const installRoot = join(candidateRoot, "install");
  await assertPathWithinRoot(options.environment.root, candidateRoot);
  await Promise.all([
    mkdir(archiveRoot, { recursive: true, mode: 0o700 }),
    mkdir(installRoot, { recursive: true, mode: 0o700 }),
  ]);
  const preparationEnvironment = packagePreparationEnvironment();
  const built = await runCommand({
    command: "pnpm",
    args: ["--dir", "packages/setup-cli", "build"],
    cwd: options.repositoryRoot,
    env: preparationEnvironment,
    timeoutMilliseconds: 120_000,
  });
  if (built.exitCode !== 0 || built.signal !== null) {
    throw new EvalInstallLifecycleError(
      `ArtifactPass candidate build failed: ${(built.stderr || built.stdout).slice(-2_000)}`,
      built,
    );
  }
  await access(join(options.repositoryRoot, "packages/setup-cli/dist/cli.mjs"));
  const storeResult = await runCommand({
    command: "pnpm",
    args: ["store", "path"],
    cwd: options.repositoryRoot,
    env: preparationEnvironment,
    timeoutMilliseconds: 10_000,
  });
  const storePath = storeResult.stdout.trim();
  if (storeResult.exitCode !== 0 || storeResult.signal !== null || storePath.length === 0) {
    throw new EvalInstallLifecycleError("ArtifactPass could not locate the pnpm package store", storeResult);
  }
  const environment = {
    ...preparationEnvironment,
    TMPDIR: join(options.environment.homes.agentA, "tmp"),
  };
  const packed = await runCommand({
    command: "pnpm",
    args: ["--dir", "packages/setup-cli", "pack", "--pack-destination", archiveRoot],
    cwd: options.repositoryRoot,
    env: environment,
    timeoutMilliseconds: 60_000,
  });
  if (packed.exitCode !== 0 || packed.signal !== null) {
    throw new EvalInstallLifecycleError("ArtifactPass candidate packing failed", packed);
  }
  const archives = (await readdir(archiveRoot)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new Error("ArtifactPass eval expected exactly one packed candidate archive");
  }
  const archivePath = join(archiveRoot, archives[0]);
  await assertPathWithinRoot(options.environment.root, archivePath);
  await writeFile(join(installRoot, "package.json"), `${JSON.stringify({
    private: true,
    packageManager: "pnpm@10.11.0",
  }, null, 2)}\n`, { mode: 0o600 });
  const installed = await runCommand({
    command: "pnpm",
    args: ["add", archivePath, "--ignore-scripts", "--offline", "--store-dir", storePath],
    cwd: installRoot,
    env: environment,
    timeoutMilliseconds: 120_000,
  });
  if (installed.exitCode !== 0 || installed.signal !== null) {
    throw new EvalInstallLifecycleError(
      `ArtifactPass packed candidate installation failed: ${(installed.stderr || installed.stdout).slice(-2_000)}`,
      installed,
    );
  }
  const packageRoot = join(installRoot, "node_modules", "artifactpass", "dist");
  const cliPath = join(packageRoot, "cli.mjs");
  await access(cliPath);
  await Promise.all([
    assertPathWithinRoot(options.environment.root, packageRoot),
    assertPathWithinRoot(options.environment.root, cliPath),
  ]);
  return {
    archivePath,
    archiveSha256: await sha256File(archivePath),
    packageRoot,
    cliPath,
  };
};

export const preparePackedCandidateForLocalEval = (options: {
  readonly environment: LocalEvalEnvironment;
  readonly repositoryRoot: string;
}): Promise<PackedEvalCandidate> => {
  const existing = candidatePromises.get(options.environment);
  if (existing !== undefined) return existing;
  const prepared = preparePackedCandidate(options).catch((error: unknown) => {
    candidatePromises.delete(options.environment);
    throw error;
  });
  candidatePromises.set(options.environment, prepared);
  return prepared;
};

const parseReceipt = (stdout: string): ArtifactpassInstallReceipt | undefined => {
  try {
    return parseArtifactpassInstallReceipt(JSON.parse(stdout) as unknown);
  } catch {
    return undefined;
  }
};

export const installCandidateIntoLocalEval = async (options: {
  readonly environment: LocalEvalEnvironment;
  readonly repositoryRoot: string;
  readonly agent: "agent-a" | "agent-b";
  readonly packedCandidate?: PackedEvalCandidate;
  readonly signal?: AbortSignal;
}): Promise<EvalInstallResult> => {
  assertRoutineNetworkTarget(options.environment.baseUrl, options.environment.baseUrl);
  const workspace = options.agent === "agent-a"
    ? options.environment.workspaces.agentA
    : options.environment.workspaces.agentB;
  const home = options.agent === "agent-a"
    ? options.environment.homes.agentA
    : options.environment.homes.agentB;
  const configPath = join(home, ".artifactpass", "config.json");
  const candidate = options.packedCandidate ?? await preparePackedCandidateForLocalEval(options);
  await Promise.all([
    assertPathWithinRoot(options.environment.root, workspace),
    assertPathWithinRoot(options.environment.root, home),
    assertPathWithinRoot(options.environment.root, configPath),
    assertPathWithinRoot(options.environment.root, candidate.cliPath),
  ]);
  const environment = {
    ...createLocalEvalProcessEnvironment(home),
    ARTIFACTPASS_CONFIG_PATH: configPath,
  };
  const commandResult = await runCommand({
    command: process.execPath,
    args: [
      candidate.cliPath,
      "install",
      "--base-url", options.environment.baseUrl.origin,
      "--profile", "local-eval",
      "--workspace-root", workspace,
      "--open-development",
      "--no-host-install",
      "--json",
    ],
    cwd: workspace,
    env: environment,
    timeoutMilliseconds: 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const receipt = parseReceipt(commandResult.stdout);
  if (
    commandResult.exitCode !== 0 ||
    commandResult.signal !== null ||
    receipt?.status !== "success"
  ) {
    throw new EvalInstallLifecycleError(
      `ArtifactPass packed installer failed: ${commandResult.stderr.slice(-2_000)}`,
      commandResult,
      receipt,
    );
  }
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    readonly profiles?: Readonly<Record<string, unknown>>;
  };
  const mcpConfigPath = receipt.portable_bundle.mcp_config;
  const skillsDirectory = receipt.portable_bundle.skills_directory;
  if (mcpConfigPath === undefined || skillsDirectory === undefined) {
    throw new Error("Packed ArtifactPass install did not return portable registration paths");
  }
  await Promise.all([
    assertPathWithinRoot(options.environment.root, receipt.receipt_path),
    assertPathWithinRoot(options.environment.root, mcpConfigPath),
    assertPathWithinRoot(options.environment.root, skillsDirectory),
  ]);
  const portableRoot = join(home, ".artifactpass", "portable-integration");
  const portableBundleCount = await readdir(portableRoot, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).length);
  const profileCount = Object.keys(config.profiles ?? {}).length;
  const mcpConfiguration = JSON.parse(await readFile(mcpConfigPath, "utf8")) as {
    readonly mcpServers?: Readonly<Record<string, unknown>>;
  };
  const registrationCount = Object.keys(mcpConfiguration.mcpServers ?? {})
    .filter((name) => name === "artifactpass").length;
  const restartedHost = await connectGenericMcpHost({
    mcpConfigPath,
    cwd: workspace,
    environment,
  });
  let hostRestartVerified = false;
  try {
    hostRestartVerified = JSON.stringify(await restartedHost.listTools()) ===
      JSON.stringify(["publish_artifact", "read_artifact"]);
  } finally {
    await restartedHost.close();
  }
  if (profileCount !== 1 || portableBundleCount !== 1 || registrationCount !== 1 || !hostRestartVerified) {
    throw new Error(
      "Packed ArtifactPass install did not produce exactly one profile, bundle, registration, and verified host restart",
    );
  }
  return {
    receipt,
    profileCount,
    portableBundleCount,
    registrationCount,
    hostRestartVerified,
    candidateArchiveSha256: candidate.archiveSha256,
  };
};
