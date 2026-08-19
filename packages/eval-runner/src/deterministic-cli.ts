import { resolve } from "node:path";

import { runDeterministicProfile } from "./runner";

const main = async (): Promise<void> => {
  const repositoryRoot = resolve(process.cwd());
  const result = await runDeterministicProfile({ repositoryRoot });
  process.stdout.write(`${JSON.stringify({
    outcome: result.report.result.outcome,
    report: result.jsonPath,
    scorecard: result.markdownPath,
  }, null, 2)}\n`);
  if (result.report.result.outcome !== "pass") process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Deterministic eval failed"}\n`);
  process.exitCode = 1;
});
