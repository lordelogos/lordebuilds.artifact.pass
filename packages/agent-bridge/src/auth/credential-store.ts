import { spawn } from "node:child_process";

export interface CredentialStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

export const agentCredentialAccountForProfile = (profileName: string): string =>
  profileName === "production"
    ? "agent-token"
    : `agent-token:${profileName}`;

export interface CommandResult {
  readonly stdout: string;
}

export class CredentialStoreCommandError extends Error {
  public constructor(public readonly status: number | null) {
    super(`Credential store command failed with status ${status ?? "unknown"}`);
    this.name = "CredentialStoreCommandError";
  }
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: { readonly input?: string },
) => Promise<CommandResult>;

const defaultRunner: CommandRunner = async (executable, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputSize += chunk.byteLength;
      if (outputSize > 16 * 1024) {
        child.kill();
        reject(new Error("Credential store command produced excessive output"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
      else reject(new CredentialStoreCommandError(code));
    });
    child.stdin.end(options.input);
  });

export class EnvironmentCredentialStore {
  public constructor(
    private readonly variableName: string,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  public async get(): Promise<string | null> {
    const value = this.environment[this.variableName];
    return value === undefined || value.length === 0 ? null : value;
  }

  public async set(_value: string): Promise<void> {
    throw new Error("Environment credentials must be managed by the calling secret manager");
  }

  public async delete(): Promise<void> {
    throw new Error("Environment credentials must be managed by the calling secret manager");
  }
}

export interface OsCredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: CommandRunner;
  readonly service?: string;
  readonly account?: string;
}

export class OsCredentialStore implements CredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly runner: CommandRunner;
  private readonly service: string;
  private readonly account: string;

  public constructor(options: OsCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? defaultRunner;
    this.service = options.service ?? "lordebuilds.artifacts.share";
    this.account = options.account ?? "agent-token";
    if (this.platform !== "darwin" && this.platform !== "linux") {
      throw new Error("No supported OS credential store is available on this platform");
    }
  }

  public async get(): Promise<string | null> {
    try {
      const result = this.platform === "darwin"
        ? await this.runner("/usr/bin/security", [
          "find-generic-password", "-w", "-s", this.service, "-a", this.account,
        ])
        : await this.runner("secret-tool", [
          "lookup", "service", this.service, "account", this.account,
        ]);
      const value = result.stdout.trim();
      return value.length === 0 ? null : value;
    } catch (error) {
      if (this.platform === "darwin" && error instanceof CredentialStoreCommandError && error.status === 44) {
        return null;
      }
      throw error;
    }
  }

  public async set(value: string): Promise<void> {
    if (this.platform === "darwin") {
      await this.runner("/usr/bin/security", [
        "add-generic-password", "-U", "-s", this.service, "-a", this.account, "-w", value,
      ]);
      return;
    }
    await this.runner(
      "secret-tool",
      ["store", `--label=${this.service}`, "service", this.service, "account", this.account],
      { input: value },
    );
  }

  public async delete(): Promise<void> {
    if (this.platform === "darwin") {
      await this.runner("/usr/bin/security", [
        "delete-generic-password", "-s", this.service, "-a", this.account,
      ]).catch((error: unknown) => {
        if (!(error instanceof CredentialStoreCommandError && error.status === 44)) throw error;
      });
      return;
    }
    await this.runner("secret-tool", [
      "clear", "service", this.service, "account", this.account,
    ]);
  }
}

export interface CredentialResolutionOptions {
  readonly headless: boolean;
  readonly environmentStore: CredentialStore;
  readonly osStore?: CredentialStore;
}

export const resolveCredential = async (
  options: CredentialResolutionOptions,
): Promise<string> => {
  if (options.headless) {
    const value = await options.environmentStore.get();
    if (value === null) throw new Error("Headless mode requires an environment credential");
    return value;
  }
  if (options.osStore === undefined) {
    throw new Error("Interactive mode requires a supported OS credential store");
  }
  const value = await options.osStore.get();
  if (value === null) throw new Error("No interactive credential is stored; connect this host first");
  return value;
};
