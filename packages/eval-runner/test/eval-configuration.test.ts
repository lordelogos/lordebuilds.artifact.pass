import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cohortReportSchema } from "../src/aggregation";
import { releasePolicySchema } from "../src/release-policy";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("eval release configuration", () => {
  it("binds the calibrated generic policy to checked-in non-secret baseline evidence", async () => {
    const policy = releasePolicySchema.parse(JSON.parse(await readFile(
      join(repositoryRoot, "evals/release-policy.json"),
      "utf8",
    )));
    const baseline = cohortReportSchema.parse(JSON.parse(await readFile(
      join(repositoryRoot, "evals/baselines/generic-to-generic-2026-08-19.json"),
      "utf8",
    )));
    const rule = policy.cohorts.find((cohort) => cohort.id === "generic-to-generic-fidelity");
    expect(rule).toMatchObject({ calibrated: true, host_pair: ["generic", "generic"] });
    expect(rule?.calibration_run_ids).toEqual(baseline.trial_run_ids);
    expect(rule?.calibration_candidate_sha256).toBe(baseline.candidate_sha256);
    expect(policy.cohorts.filter((cohort) => cohort.host_pair[0] !== "generic"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ blocking: true, calibrated: false }),
        expect.objectContaining({ blocking: true, calibrated: false }),
      ]));
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
