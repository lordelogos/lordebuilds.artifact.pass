import { CloudflareClient } from "../cloudflare/client";
import {
  deployArtifactShare,
  describeCloudflareFailure,
  type DeployInput,
  type DeploymentResult,
} from "../cloudflare/deployment";
import type { ProcessRunner } from "../process";
import { runProcess } from "../process";

export interface DeployCommandDependencies {
  readonly deploymentRoot: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly runner?: ProcessRunner;
}

export const runDeployCommand = async (
  input: DeployInput,
  dependencies: DeployCommandDependencies,
): Promise<DeploymentResult> => {
  const runner = dependencies.runner ?? runProcess;
  let token = dependencies.token;
  if (!input.dryRun && (token === undefined || token.length === 0)) {
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
  if (!input.dryRun && (token === undefined || token.length === 0)) {
    throw new Error("Wrangler did not return a supported OAuth or API token");
  }
  const client = new CloudflareClient({
    token: token ?? "dry-run-not-used",
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  try {
    return await deployArtifactShare(input, {
      client,
      deploymentRoot: dependencies.deploymentRoot,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      runner,
    });
  } catch (error) {
    throw new Error(describeCloudflareFailure(error));
  }
};
