import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { releasePolicySchema } from "../src/release-policy";
import { candidateDigest } from "../src/candidate-digest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("eval release configuration", () => {
  it("keeps hard gates separate from uncalibrated behavioral thresholds", async () => {
    const policy = releasePolicySchema.parse(JSON.parse(await readFile(
      join(repositoryRoot, "evals/release-policy.json"),
      "utf8",
    )));
    const rule = policy.cohorts.find((cohort) => cohort.id === "generic-to-generic-fidelity");
    expect(policy.candidate_sha256).toBe(await candidateDigest(repositoryRoot));
    expect(rule).toMatchObject({ evaluation: "hard_gate", host_pair: ["generic", "generic"] });
    expect(policy.cohorts.every((cohort) => cohort.blocking)).toBe(true);
    expect(policy.cohorts
      .filter((cohort) => cohort.evaluation === "behavioral_threshold")
      .every((cohort) => !cohort.calibrated)).toBe(true);
    const scenarioPaths = {
      "generic-fidelity": "evals/scenarios/deterministic/generic-fidelity.json",
      "share-markdown": "evals/scenarios/behavior/share-markdown.json",
      "read-shared-artifact": "evals/scenarios/behavior/read-shared-artifact.json",
      "autonomous-handoff": "evals/scenarios/safety/autonomous-handoff.json",
    } as const;
    for (const rule of policy.cohorts) {
      const path = scenarioPaths[rule.scenario_id as keyof typeof scenarioPaths];
      expect(path, rule.scenario_id).toBeDefined();
      const digest = createHash("sha256").update(await readFile(join(repositoryRoot, path!))).digest("hex");
      expect(rule.scenario_sha256, rule.id).toBe(digest);
    }
  });

  it("keeps pull-request evaluation deterministic and production fail-closed", async () => {
    const workflow = await readFile(join(repositoryRoot, ".github/workflows/evals.yml"), "utf8");
    expect(workflow).toContain("pnpm eval:deterministic");
    expect(workflow).toContain("github.event_name != 'workflow_dispatch'");
    expect(workflow).toContain("environment: artifactpass-production-evals");
    expect(workflow).toContain("Production mutation remains fail-closed");
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(packageJson.scripts.check).not.toContain("eval:smoke");
    expect(packageJson.scripts.check).not.toContain("eval:baseline");
  });

  it("documents deterministic, smoke, baseline, release, production, and cleanup operation", async () => {
    const guide = await readFile(join(repositoryRoot, "docs/evals.md"), "utf8");
    for (const phrase of [
      "eval:deterministic",
      "eval:smoke",
      "eval:baseline",
      "eval:cohort",
      "eval:release",
      "Production",
      "cleanup",
    ]) expect(guide).toContain(phrase);
  });
});
