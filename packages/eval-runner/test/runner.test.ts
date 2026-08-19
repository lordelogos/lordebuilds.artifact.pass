import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runDeterministicProfile } from "../src/runner";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("generic deterministic profile", () => {
  it("publishes and reconstructs exact Markdown and HTML through the installed MCP bridge", async () => {
    const result = await runDeterministicProfile({ repositoryRoot });
    expect(result.report.result).toMatchObject({
      trial_outcome: "pass",
      outcome: "pass",
      teardown: "passed",
      failures: [],
    });
    expect(result.report.host).toMatchObject({ agent_a: "generic", agent_b: "generic" });
    expect(result.report.result.observed_actions).toEqual(expect.arrayContaining([
      { kind: "mcp_tool", name: "publish_artifact" },
      { kind: "mcp_tool", name: "read_artifact" },
    ]));
  }, 120_000);
});
