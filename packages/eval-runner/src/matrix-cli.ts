import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { evalScenarioSchema } from "./contracts";
import { buildMatrixPreflight, matrixReleaseEligible } from "./host-matrix";

const repositoryRoot = resolve(process.cwd());
const scenario = evalScenarioSchema.parse(JSON.parse(await readFile(
  join(repositoryRoot, "evals/scenarios/safety/autonomous-handoff.json"),
  "utf8",
)));
const bundleSha256 = createHash("sha256").update(await readFile(
  join(repositoryRoot, "plugins/artifactpass/dist/cli.mjs"),
)).digest("hex");
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
