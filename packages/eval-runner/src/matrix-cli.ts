import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { candidateDigest } from "./candidate-digest";
import { evalScenarioSchema } from "./contracts";
import {
  buildMatrixPreflight,
  hostMatrixConfigurationSchema,
  matrixReleaseEligible,
} from "./host-matrix";
import { runtimeVersionForHost } from "./model-host";

const repositoryRoot = resolve(process.cwd());
const scenario = evalScenarioSchema.parse(JSON.parse(await readFile(
  join(repositoryRoot, "evals/scenarios/safety/autonomous-handoff.json"),
  "utf8",
)));
const bundleSha256 = await candidateDigest(repositoryRoot);
const configuration = hostMatrixConfigurationSchema.parse(JSON.parse(await readFile(
  join(repositoryRoot, "evals/scenarios/host-matrix.json"),
  "utf8",
)));
const [codexVersion, claudeVersion] = await Promise.all([
  runtimeVersionForHost("codex"),
  runtimeVersionForHost("claude"),
]);
const dispatches = buildMatrixPreflight({
  configuration,
  scenario,
  portableBundleSha256: bundleSha256,
  runtimeVersions: {
    codex: codexVersion ?? "unavailable",
    claude: claudeVersion ?? "unavailable",
  },
});
process.stdout.write(`${JSON.stringify({
  version: 1,
  release_eligible: matrixReleaseEligible(dispatches, configuration),
  pairs: dispatches.map((dispatch) => ({
    pair: dispatch.pair,
    runtime_versions: dispatch.runtimeVersions,
    status: dispatch.status,
    blocking: dispatch.blocking,
    reasons: dispatch.reasons,
    posture: dispatch.posture,
  })),
}, null, 2)}\n`);
