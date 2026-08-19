import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeEvalReport } from "../src/reporting";

describe("eval reporting", () => {
  it("writes strict JSON and Markdown from redacted allowlisted fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-reporting-"));
    const token = "Z0J7-dS0-ArDdvW2cSSMFxiearBOa-ndd1zKz8jijIs";
    const paths = await writeEvalReport(root, {
      version: 1,
      run_id: "8e885d98-7491-4ef8-84fe-1b8fea4c7235",
      candidate: { sha256: "a".repeat(64) },
      receipt_version: 1,
      scenario: { id: "generic-fidelity", version: 1 },
      scorer_version: "1.0.0",
      host: { agent_a: "generic", runtime: "node-test" },
      cohort: { profile: "deterministic", trial_index: 1, trial_count: 1 },
      result: {
        version: 1,
        run_id: "8e885d98-7491-4ef8-84fe-1b8fea4c7235",
        scenario_id: "generic-fidelity",
        candidate_sha256: "a".repeat(64),
        started_at: "2026-08-19T03:00:00.000Z",
        completed_at: "2026-08-19T03:00:01.000Z",
        trial_outcome: "behavior_failure",
        outcome: "behavior_failure",
        gate_class: "deterministic",
        host_pair: { agent_a: "generic" },
        teardown: "passed",
        observed_actions: [],
        failures: [{
          code: "fixture",
          message: `Failed at /Users/person/private.md using http://127.0.0.1:8787/a/${token}`,
        }],
      },
      latency_ms: 1000,
      usage: {},
    });
    const output = `${await readFile(paths.jsonPath, "utf8")}\n${await readFile(paths.markdownPath, "utf8")}`;
    expect(output).not.toContain(token);
    expect(output).not.toContain("/Users/person");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[PATH]");
  });
});
