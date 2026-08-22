import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EvalInstallLifecycleError,
  installCandidateIntoLocalEval,
  preparePackedCandidateForLocalEval,
} from "../src/install-lifecycle";
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
          receipt_version: 2,
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
        expect(result.registrationCount).toBe(1);
        expect(result.hostRestartVerified).toBe(true);
        expect(result.candidateArchiveSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
      expect(repaired.receipt.portable_bundle.sha256).toBe(first.receipt.portable_bundle.sha256);
      expect(repaired.candidateArchiveSha256).toBe(first.candidateArchiveSha256);
      await expect(access(join(environment.homes.agentB, ".artifactpass", "config.json"))).rejects.toThrow();

      const candidate = await preparePackedCandidateForLocalEval({ environment, repositoryRoot });
      const stagedSkill = join(
        candidate.packageRoot,
        "marketplace/plugins/artifactpass/skills/share-artifact/SKILL.md",
      );
      const stagedSkillBytes = await readFile(stagedSkill);
      await rm(stagedSkill);
      let stagedFailure: EvalInstallLifecycleError | undefined;
      try {
        await installCandidateIntoLocalEval({
          environment,
          repositoryRoot,
          agent: "agent-b",
          packedCandidate: candidate,
        });
      } catch (error) {
        if (error instanceof EvalInstallLifecycleError) stagedFailure = error;
        else throw error;
      } finally {
        await writeFile(stagedSkill, stagedSkillBytes);
      }
      expect(stagedFailure?.receipt).toMatchObject({
        status: "failed",
        rollback: "complete",
        failed_stage: "connection",
      });
      await expect(access(join(environment.homes.agentB, ".artifactpass", "config.json"))).rejects.toThrow();
      await expect(readdir(join(environment.homes.agentB, ".artifactpass", "portable-integration")))
        .resolves.toEqual([]);

      const agentB = await installCandidateIntoLocalEval({
        environment,
        repositoryRoot,
        agent: "agent-b",
      });
      expect(agentB.receipt.portable_bundle.sha256).toBe(first.receipt.portable_bundle.sha256);
      expect(agentB.receipt.receipt_path).not.toBe(first.receipt.receipt_path);
      expect(agentB.receipt.workspace_roots).toEqual([environment.workspaces.agentB]);
      expect(await readFile(
        join(environment.homes.agentA, ".artifactpass", "config.json"),
        "utf8",
      )).not.toBe(await readFile(
        join(environment.homes.agentB, ".artifactpass", "config.json"),
        "utf8",
      ));

      const cancelled = new AbortController();
      cancelled.abort();
      await expect(installCandidateIntoLocalEval({
        environment,
        repositoryRoot,
        agent: "agent-b",
        packedCandidate: candidate,
        signal: cancelled.signal,
      })).rejects.toMatchObject({
        name: "EvalInstallLifecycleError",
        message: "ArtifactPass eval install command was cancelled",
      });
      await expect(installCandidateIntoLocalEval({
        environment,
        repositoryRoot,
        agent: "agent-b",
        packedCandidate: candidate,
      })).resolves.toMatchObject({
        profileCount: 1,
        portableBundleCount: 1,
        registrationCount: 1,
        hostRestartVerified: true,
      });
    } finally {
      await environment.stop();
    }
  }, 180_000);
});
