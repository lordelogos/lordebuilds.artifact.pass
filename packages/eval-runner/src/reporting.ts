import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evalReportSchema, type EvalReport } from "./contracts";
import { redactSensitiveText, serializeRedacted } from "./redaction";

export const renderMarkdownScorecard = (report: EvalReport): string => {
  const status = report.result.outcome === "pass" ? "PASS" : "FAIL";
  const failures = report.result.failures.length === 0
    ? "- None"
    : report.result.failures.map((failure) => `- ${failure.code}: ${failure.message}`).join("\n");
  return [
    `# ArtifactPass eval: ${status}`,
    "",
    `- Scenario: ${report.scenario.id} v${report.scenario.version}`,
    `- Profile: ${report.cohort.profile}`,
    `- Host: ${report.host.agent_a}${report.host.agent_b === undefined ? "" : ` → ${report.host.agent_b}`}`,
    `- Candidate: ${report.candidate.sha256}`,
    `- Outcome: ${report.result.outcome}`,
    `- Trial outcome: ${report.result.trial_outcome}`,
    `- Teardown: ${report.result.teardown}`,
    `- Latency: ${report.latency_ms} ms`,
    "",
    "## Failures",
    "",
    failures,
    "",
  ].join("\n");
};

export const writeEvalReport = async (outputRoot: string, reportValue: unknown): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> => {
  const report = evalReportSchema.parse(reportValue);
  const directory = join(outputRoot, report.run_id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jsonPath = join(directory, "report.json");
  const markdownPath = join(directory, "scorecard.md");
  await writeFile(jsonPath, `${serializeRedacted(report)}\n`, { mode: 0o600 });
  await writeFile(markdownPath, redactSensitiveText(renderMarkdownScorecard(report)), { mode: 0o600 });
  return { jsonPath, markdownPath };
};
