import { spawn } from "node:child_process";
import { access, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createLocalEvalProcessEnvironment,
  localEnvironmentExists,
  reapOrphanedLocalEvalEnvironments,
  startLocalEvalEnvironment,
} from "../src/local-environment";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("disposable local ArtifactPass environment", () => {
  it("starts the real local Worker with D1 and R2 state and removes the run root", async () => {
    const environment = await startLocalEvalEnvironment(repositoryRoot);
    try {
      expect(environment.baseUrl.hostname).toBe("127.0.0.1");
      expect((await fetch(new URL("/health", environment.baseUrl))).status).toBe(200);
      expect((await fetch(new URL("/__local-test/time", environment.baseUrl), { method: "POST" })).status).toBe(404);
      await expect(access(environment.stateRoot)).resolves.toBeUndefined();
      await expect(access(environment.workspaces.agentA)).resolves.toBeUndefined();
      await expect(access(environment.workspaces.agentB)).resolves.toBeUndefined();
      expect(environment.workspaces.agentA).not.toBe(environment.workspaces.agentB);
      expect(createLocalEvalProcessEnvironment(environment.homes.agentA).TMPDIR)
        .toBe(resolve(environment.homes.agentA, "tmp"));
    } finally {
      await environment.stop();
    }
    await expect(localEnvironmentExists(environment)).resolves.toBe(false);
    await expect(environment.stop()).resolves.toBeUndefined();
  }, 90_000);

  it.skipIf(process.platform === "win32")("terminates a verified orphan Worker before deleting its state", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-eval-"));
    const marker = `artifactpass-eval-orphan-${Date.now()}`;
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {
      detached: true,
      stdio: "ignore",
    });
    worker.unref();
    const workerPid = worker.pid;
    if (workerPid === undefined) throw new Error("Orphan test Worker did not start");
    await writeFile(join(root, "cleanup-journal.json"), `${JSON.stringify({
      version: 1,
      run_id: marker,
      owner_pid: 999_999_999,
      created_at: Date.now(),
      worker_pid: workerPid,
      worker_marker: marker,
    })}\n`);

    await expect(reapOrphanedLocalEvalEnvironments()).resolves.toContain(marker);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(workerPid, 0)).toThrow();
  }, 15_000);
});
