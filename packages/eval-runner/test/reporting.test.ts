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
      receipt_version: 3,
      scenario: { id: "generic-fidelity", version: 1, sha256: "b".repeat(64) },
      scorer_version: "1.0.0",
      host: { agent_a: "generic", agent_b: "codex", runtime: "node-test", model: "model-test" },
      cohort: { profile: "deterministic", trial_index: 2, trial_count: 3 },
      result: {
        version: 1,
        run_id: "8e885d98-7491-4ef8-84fe-1b8fea4c7235",
        scenario_id: "generic-fidelity",
        candidate_sha256: "a".repeat(64),
        started_at: "2026-08-19T03:00:00.000Z",
        completed_at: "2026-08-19T03:00:01.000Z",
        trial_outcome: "infrastructure_failure",
        outcome: "infrastructure_failure",
        gate_class: "deterministic",
        host_pair: { agent_a: "generic", agent_b: "codex" },
        infrastructure_code: "fixture-infrastructure",
        teardown: "passed",
        observed_actions: [],
        failures: [{
          code: "fixture",
          message: `Failed at /Users/person/private.md using http://127.0.0.1:8787/a/${token}`,
        }],
      },
      latency_ms: 1000,
      usage: { input_tokens: 120, output_tokens: 30, estimated_cost_usd: 0.0125 },
      infrastructure_classification: "fixture-infrastructure",
    });
    const json = await readFile(paths.jsonPath, "utf8");
    const markdown = await readFile(paths.markdownPath, "utf8");
    const output = `${json}\n${markdown}`;
    expect(markdown).toContain(`- Candidate: ${"a".repeat(64)}`);
    expect(markdown).toContain("- Receipt version: 3");
    expect(markdown).toContain("- Scenario: generic-fidelity v1");
    expect(markdown).toContain("- Scorer version: 1.0.0");
    expect(markdown).toContain("- Host: generic -> codex");
    expect(markdown).toContain("- Host runtime: node-test");
    expect(markdown).toContain("- Host model: model-test");
    expect(markdown).toContain("- Profile: deterministic");
    expect(markdown).toContain("- Cohort trial: 2/3");
    expect(markdown).toContain("- Outcome: infrastructure_failure");
    expect(markdown).toContain("- Latency: 1000 ms");
    expect(markdown).toContain("- Usage: input_tokens=120, output_tokens=30, estimated_cost_usd=0.0125");
    expect(markdown).toContain("- Teardown: passed");
    expect(markdown).toContain("- Infrastructure classification: fixture-infrastructure");
    expect([...markdown].every((character) => character.charCodeAt(0) <= 0x7f)).toBe(true);
    expect(output).not.toContain(token);
    expect(output).not.toContain("/Users/person");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[PATH]");
  });
});
