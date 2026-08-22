import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runDeterministicProfile } from "../src/runner";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("generic transport profile", () => {
  it("publishes and reconstructs exact Markdown and HTML through the installed MCP bridge", async () => {
    const result = await runDeterministicProfile({
      repositoryRoot,
      cohort: { profile: "baseline", trialIndex: 3, trialCount: 10 },
    });
    expect(result.report.result).toMatchObject({
      trial_outcome: "pass",
      outcome: "pass",
      teardown: "passed",
      failures: [],
    });
    expect(result.report.host).toMatchObject({ agent_a: "generic", agent_b: "generic" });
    expect(result.report.cohort).toEqual({ profile: "baseline", trial_index: 3, trial_count: 10 });
    expect(result.report.result.observed_actions).toEqual(expect.arrayContaining([
      { kind: "mcp_tool", name: "publish_artifact" },
      { kind: "mcp_tool", name: "read_artifact" },
    ]));
  }, 120_000);
});
