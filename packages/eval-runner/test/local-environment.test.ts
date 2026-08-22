import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createLocalEvalProcessEnvironment,
  localEnvironmentExists,
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
});
