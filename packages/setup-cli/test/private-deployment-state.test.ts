import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPrivateDeploymentState,
  invalidatePrivateDeploymentCheckpoints,
  listPrivateDeploymentStates,
  privateDeploymentStateRoot,
  provePrivateDeploymentCheckpoint,
  readPrivateDeploymentState,
  resolvePrivateDeploymentState,
  validatePrivateDeploymentState,
  withPrivateDeploymentLock,
  writePrivateDeploymentState,
} from "../src/private-deployment/deployment-state";

const deploymentId = "11111111-1111-4111-8111-111111111111";
const secondDeploymentId = "22222222-2222-4222-8222-222222222222";
const cliVersion = "0.1.0-rc.12";
const instant = new Date("2026-09-01T16:00:00.000Z");

const temporaryRoot = async (name: string): Promise<string> => {
  const root = resolve(tmpdir(), `artifactpass-${name}-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
};

describe("private deployment state", () => {
  it("uses the machine-level ArtifactPass config root instead of the workspace", () => {
    expect(privateDeploymentStateRoot({ XDG_CONFIG_HOME: "/tmp/example-config" }, "linux"))
      .toBe("/tmp/example-config/artifactpass/deployments");
    expect(privateDeploymentStateRoot({ APPDATA: "C:\\Users\\Example\\AppData\\Roaming" }, "win32"))
      .toContain("artifactpass");
  });

  it("creates, checkpoints, atomically writes, lists, and resolves a deployment by hostname", async () => {
    const root = await temporaryRoot("deployment-state");
    let state = await createPrivateDeploymentState({
      root,
      cliVersion,
      createId: () => deploymentId,
      now: () => instant,
    });
    expect(state.stage).toBe("started");
    state = provePrivateDeploymentCheckpoint(
      { ...state, hostname: "artifacts.example.com", sign_in_mode: "email-code" },
      "sign-in-mode-selected",
      { mode: "email-code" },
      "authorization-required",
      instant,
    );
    state = await writePrivateDeploymentState(root, state, cliVersion, () => instant);

    expect(await resolvePrivateDeploymentState(root, "artifacts.example.com", cliVersion)).toEqual(state);
    expect(await listPrivateDeploymentStates(root, cliVersion)).toEqual([state]);
    const mode = (await import("node:fs/promises")).stat(resolve(root, "by-id", `${deploymentId}.json`));
    expect((await mode).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(resolve(root, "by-hostname", "artifacts.example.com.json"), "utf8")))
      .toMatchObject({ deployment_id: deploymentId, hostname: "artifacts.example.com" });
  });

  it("rejects state files containing credentials or a newer schema", () => {
    const base = {
      schema_version: 1,
      deployment_id: deploymentId,
      created_by_cli_version: cliVersion,
      last_written_by_cli_version: cliVersion,
      status: "incomplete",
      stage: "started",
      created_at: instant.toISOString(),
      updated_at: instant.toISOString(),
      checkpoints: {},
    };
    expect(() => validatePrivateDeploymentState({ ...base, refresh_token: "must-not-persist" }, cliVersion))
      .toThrow("cannot store secret-bearing field");
    expect(() => validatePrivateDeploymentState({ ...base, schema_version: 2 }, cliVersion))
      .toThrow(`pnpm dlx artifactpass@${cliVersion} deploy --resume ${deploymentId}`);
  });

  it("rejects oversized and symlinked state files", async () => {
    const root = await temporaryRoot("deployment-bounds");
    const path = resolve(root, "by-id", `${deploymentId}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "x".repeat(256 * 1024 + 1));
    await expect(readPrivateDeploymentState(root, deploymentId, cliVersion)).rejects.toThrow("too large");
  });

  it("prevents hostname alias collisions", async () => {
    const root = await temporaryRoot("deployment-index");
    const first = await createPrivateDeploymentState({ root, cliVersion, createId: () => deploymentId, now: () => instant });
    const second = await createPrivateDeploymentState({ root, cliVersion, createId: () => secondDeploymentId, now: () => instant });
    await writePrivateDeploymentState(root, { ...first, hostname: "artifacts.example.com" }, cliVersion, () => instant);
    await expect(writePrivateDeploymentState(
      root,
      { ...second, hostname: "artifacts.example.com" },
      cliVersion,
      () => instant,
    )).rejects.toThrow("already bound");
  });

  it("blocks concurrent writers and recovers a stale lock", async () => {
    const root = await temporaryRoot("deployment-lock");
    const lockPath = resolve(root, "locks", `${deploymentId}.lock`);
    await mkdir(dirname(lockPath), { recursive: true });
    const active = await open(lockPath, "wx", 0o600);
    await active.writeFile("{}");
    await active.close();
    await expect(withPrivateDeploymentLock(root, deploymentId, async () => undefined))
      .rejects.toThrow("already open in another process");
    await expect(withPrivateDeploymentLock(
      root,
      deploymentId,
      async () => "recovered",
      { now: () => Date.now() + 10 * 60_000, staleLockMilliseconds: 1_000 },
    )).resolves.toBe("recovered");
  });

  it("recovers immediately when an interrupted lock owner no longer exists", async () => {
    const root = await temporaryRoot("deployment-dead-lock");
    const lockPath = resolve(root, "locks", `${deploymentId}.lock`);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ deployment_id: deploymentId, pid: 2_147_483_647 }));

    await expect(withPrivateDeploymentLock(root, deploymentId, async () => "resumed"))
      .resolves.toBe("resumed");
  });

  it("invalidates dependent checkpoints and approval when an earlier answer changes", async () => {
    const root = await temporaryRoot("deployment-invalidation");
    let state = await createPrivateDeploymentState({ root, cliVersion, createId: () => deploymentId, now: () => instant });
    state = provePrivateDeploymentCheckpoint(state, "sign-in-mode-selected", { mode: "email-code" }, "authorization-required", instant);
    state = provePrivateDeploymentCheckpoint(state, "approval-ready", { digest: "a".repeat(64) }, "approval-ready", instant);
    state = validatePrivateDeploymentState({
      ...state,
      approval: { manifest_path: "/tmp/approval.json", manifest_digest: "a".repeat(64) },
    });
    const invalidated = invalidatePrivateDeploymentCheckpoints(
      state,
      ["sign-in-mode-selected", "approval-ready"],
      "started",
    );
    expect(invalidated.checkpoints).not.toHaveProperty("sign-in-mode-selected");
    expect(invalidated.checkpoints).not.toHaveProperty("approval-ready");
    expect(invalidated.approval).toBeUndefined();
    expect(invalidated.stage).toBe("started");
  });
});
