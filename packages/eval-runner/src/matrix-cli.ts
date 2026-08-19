import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { candidateDigest } from "./candidate-digest";
import { evalScenarioSchema } from "./contracts";
import { buildMatrixPreflight, matrixReleaseEligible } from "./host-matrix";

const repositoryRoot = resolve(process.cwd());
const scenario = evalScenarioSchema.parse(JSON.parse(await readFile(
  join(repositoryRoot, "evals/scenarios/safety/autonomous-handoff.json"),
  "utf8",
)));
const bundleSha256 = await candidateDigest(repositoryRoot);
const dispatches = buildMatrixPreflight({ scenario, portableBundleSha256: bundleSha256 });
process.stdout.write(`${JSON.stringify({
  version: 1,
  release_eligible: matrixReleaseEligible(dispatches),
  pairs: dispatches.map((dispatch) => ({
    pair: dispatch.pair,
    status: dispatch.status,
    blocking: dispatch.blocking,
    reasons: dispatch.reasons,
  })),
}, null, 2)}\n`);
