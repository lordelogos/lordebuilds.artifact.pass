import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runArtifactpassInstall,
  type ArtifactpassInstallReceipt,
} from "../../setup-cli/src/installer";

import type { LocalEvalEnvironment } from "./local-environment";

export interface EvalInstallResult {
  readonly receipt: ArtifactpassInstallReceipt;
  readonly profileCount: number;
  readonly portableBundleCount: number;
}

export const installCandidateIntoLocalEval = async (options: {
  readonly environment: LocalEvalEnvironment;
  readonly repositoryRoot: string;
  readonly agent: "agent-a" | "agent-b";
}): Promise<EvalInstallResult> => {
  const workspace = options.agent === "agent-a"
    ? options.environment.workspaces.agentA
    : options.environment.workspaces.agentB;
  const home = options.agent === "agent-a"
    ? options.environment.homes.agentA
    : options.environment.homes.agentB;
  const configPath = join(home, ".artifactpass", "config.json");
  const receiptDirectory = join(options.environment.receiptRoot, options.agent);
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const receipt = await runArtifactpassInstall({
    baseUrl: options.environment.baseUrl.origin,
    profileName: "local-eval",
    workspaceRoot: workspace,
    marketplaceSource: options.repositoryRoot,
    configPath,
    receiptDirectory,
    openDevelopment: true,
    installKnownHostAdapters: false,
  }, {
    connectDependencies: {
      deviceFlowDependencies: { openBrowser: async () => undefined },
    },
    skipCredentialStorePreflight: true,
    homeDirectory: home,
  });
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    readonly profiles?: Readonly<Record<string, unknown>>;
  };
  const portableRoot = join(home, ".artifactpass", "portable-integration");
  const portableBundleCount = await readdir(portableRoot, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).length);
  return {
    receipt,
    profileCount: Object.keys(config.profiles ?? {}).length,
    portableBundleCount,
  };
};
