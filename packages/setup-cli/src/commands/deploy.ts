import { CloudflareClient } from "../cloudflare/client";
import {
  deployArtifactShare,
  describeCloudflareFailure,
  DeploymentMutationError,
  type DeployInput,
  type DeploymentResult,
} from "../cloudflare/deployment";
import type { ProcessRunner } from "../process";
import { runProcess } from "../process";

export interface DeployCommandDependencies {
  readonly deploymentRoot: string;
  readonly token?: string;
  readonly resolveToken?: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly runner?: ProcessRunner;
}

const wranglerEnvironmentNames = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME",
] as const;

export const createCloudflareProcessRunner = (
  runner: ProcessRunner,
  resolveToken: () => Promise<string>,
  accountId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProcessRunner => {
  const safeEnvironment = Object.fromEntries(
    wranglerEnvironmentNames.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]]]),
  );
  return async (command, args, options = {}) => {
    if (command !== "wrangler") return runner(command, args, options);
    const activeToken = await resolveToken();
    try {
      return await runner(command, args, {
        ...options,
        inheritEnvironment: false,
        env: {
          ...safeEnvironment,
          ...options.env,
          CLOUDFLARE_API_TOKEN: activeToken,
          CLOUDFLARE_ACCOUNT_ID: accountId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.split(activeToken).join("[REDACTED]"));
    }
  };
};

export const runDeployCommand = async (
  input: DeployInput,
  dependencies: DeployCommandDependencies,
): Promise<DeploymentResult> => {
  const runner = dependencies.runner ?? runProcess;
  let token = dependencies.token;
  let resolveToken = dependencies.resolveToken;
  if (resolveToken !== undefined && token !== undefined) {
    throw new Error("Choose one Cloudflare credential source");
  }
  if (!input.dryRun && resolveToken === undefined && (token === undefined || token.length === 0)) {
    try {
      const authentication = JSON.parse((await runner("wrangler", ["auth", "token", "--json"])).stdout) as {
        readonly type?: string;
        readonly token?: string;
      };
      if (
        (authentication.type === "oauth" || authentication.type === "api_token") &&
        typeof authentication.token === "string" &&
        authentication.token.length > 0
      ) {
        token = authentication.token;
      }
    } catch {
      throw new Error("Log in with `wrangler login --use-keyring` or set CLOUDFLARE_API_TOKEN; the setup CLI never persists the credential");
    }
  }
  if (!input.dryRun && resolveToken === undefined && (token === undefined || token.length === 0)) {
    throw new Error("Wrangler did not return a supported OAuth or API token");
  }
  if (resolveToken === undefined) {
    const resolved = token ?? "dry-run-not-used";
    resolveToken = async () => resolved;
  }
  const client = new CloudflareClient({
    resolveToken,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  const credentialedRunner = createCloudflareProcessRunner(runner, resolveToken, input.accountId);
  try {
    return await deployArtifactShare(input, {
      client,
      deploymentRoot: dependencies.deploymentRoot,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      runner: credentialedRunner,
    });
  } catch (error) {
    if (error instanceof DeploymentMutationError) {
      throw new DeploymentMutationError(
        describeCloudflareFailure(error.cause),
        error.changed,
        error.resources,
        error.cause,
      );
    }
    throw new Error(describeCloudflareFailure(error));
  }
};
