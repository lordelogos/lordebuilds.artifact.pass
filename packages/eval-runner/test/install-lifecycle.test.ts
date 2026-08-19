import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { installCandidateIntoLocalEval } from "../src/install-lifecycle";
import { startLocalEvalEnvironment } from "../src/local-environment";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("real candidate installation in a disposable eval home", () => {
  it("installs and repairs in place with one profile, one bundle, two skills, and negotiated MCP", async () => {
    const environment = await startLocalEvalEnvironment(repositoryRoot);
    try {
      const first = await installCandidateIntoLocalEval({
        environment,
        repositoryRoot,
        agent: "agent-a",
      });
      const repaired = await installCandidateIntoLocalEval({
        environment,
        repositoryRoot,
        agent: "agent-a",
      });
      for (const result of [first, repaired]) {
        expect(result.receipt).toMatchObject({
          receipt_version: 1,
          product: "ArtifactPass",
          status: "success",
          origin: environment.baseUrl.origin,
          workspace_roots: [environment.workspaces.agentA],
          mcp: {
            negotiated: true,
            tools: ["publish_artifact", "read_artifact"],
            representative_invocation: true,
          },
          skills: {
            verified: true,
            names: ["read-shared-artifact", "share-artifact"],
          },
        });
        expect(result.profileCount).toBe(1);
        expect(result.portableBundleCount).toBe(1);
      }
      expect(repaired.receipt.portable_bundle.sha256).toBe(first.receipt.portable_bundle.sha256);
      await expect(access(join(environment.homes.agentB, ".artifactpass", "config.json"))).rejects.toThrow();
    } finally {
      await environment.stop();
    }
  }, 120_000);
});
