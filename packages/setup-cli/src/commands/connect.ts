import { resolve } from "node:path";

import {
  OsCredentialStore,
  assertSafeDeploymentOrigin,
  defaultLocalConfigPath,
  writeLocalBridgeSettings,
  type CredentialStore,
} from "agent-bridge";

import { completeDeviceFlow, type DeviceFlowDependencies } from "../device-flow";
import { detectHosts, installPluginForHosts, type AgentHost } from "../hosts";
import type { ProcessRunner } from "../process";
import { runProcess } from "../process";

export interface ConnectInput {
  readonly baseUrl: string;
  readonly workspaceRoots: readonly string[];
  readonly hosts?: readonly AgentHost[];
  readonly marketplaceSource: string;
  readonly configPath?: string;
}

export interface ConnectDependencies {
  readonly runner?: ProcessRunner;
  readonly credentialStore?: CredentialStore;
  readonly deviceFlow?: typeof completeDeviceFlow;
  readonly deviceFlowDependencies: DeviceFlowDependencies;
}

export const connectHost = async (
  input: ConnectInput,
  dependencies: ConnectDependencies,
): Promise<{ readonly hosts: readonly AgentHost[]; readonly expiresIn: number; readonly configPath: string }> => {
  const origin = assertSafeDeploymentOrigin(new URL(input.baseUrl));
  const roots = input.workspaceRoots.map((root) => resolve(root));
  if (roots.length === 0) throw new Error("At least one workspace root is required");
  const health = await (dependencies.deviceFlowDependencies.fetch ?? globalThis.fetch)(
    new URL("/health", origin),
    { redirect: "error" },
  );
  const healthBody = await health.clone().json().catch(() => null) as {
    readonly service?: string;
    readonly status?: string;
  } | null;
  if (
    !health.ok ||
    healthBody?.service !== "lordebuilds.artifacts.share" ||
    healthBody.status !== "ok"
  ) {
    throw new Error(`Artifact Share health check failed (${health.status})`);
  }
  const runner = dependencies.runner ?? runProcess;
  const hosts = input.hosts ?? await detectHosts(runner);
  if (hosts.length === 0) throw new Error("Install Claude Code or Codex before connecting Artifact Share");
  await installPluginForHosts(hosts, input.marketplaceSource, runner);
  const token = await (dependencies.deviceFlow ?? completeDeviceFlow)(
    origin.toString(),
    dependencies.deviceFlowDependencies,
  );
  const store = dependencies.credentialStore ?? new OsCredentialStore();
  await store.set(token.accessToken);
  const configPath = input.configPath ?? defaultLocalConfigPath();
  try {
    await writeLocalBridgeSettings(configPath, {
      version: 1,
      base_url: origin.toString(),
      workspace_roots: roots,
    });
  } catch (error) {
    await store.delete();
    throw error;
  }
  return { hosts, expiresIn: token.expiresIn, configPath };
};
