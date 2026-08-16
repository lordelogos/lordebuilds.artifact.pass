import { access, constants } from "node:fs/promises";

import type { ProcessRunner } from "./process";
import { runProcess } from "./process";

export interface DoctorResult {
  readonly node: boolean;
  readonly wrangler: boolean;
  readonly deploymentAssets: boolean;
  readonly codex: boolean;
  readonly claude: boolean;
}

const commandExists = async (runner: ProcessRunner, command: string): Promise<boolean> => {
  try {
    await runner(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
};

export const runDoctor = async (
  deploymentRoot: string,
  runner: ProcessRunner = runProcess,
): Promise<DoctorResult> => {
  const [wrangler, codex, claude, deploymentAssets] = await Promise.all([
    commandExists(runner, "wrangler"),
    commandExists(runner, "codex"),
    commandExists(runner, "claude"),
    access(deploymentRoot, constants.R_OK).then(() => true).catch(() => false),
  ]);
  return {
    node: Number(process.versions.node.split(".")[0]) >= 24,
    wrangler,
    deploymentAssets,
    codex,
    claude,
  };
};
