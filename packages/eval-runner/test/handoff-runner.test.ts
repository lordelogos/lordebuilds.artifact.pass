import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evalScenarioSchema } from "../src/contracts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("isolated handoff scenarios", () => {
  it.each(["autonomous-handoff.json", "pdf-boundaries.json"])("validates %s as a portable safety scenario", async (name) => {
    const value = JSON.parse(await readFile(join(repositoryRoot, "evals/scenarios/safety", name), "utf8"));
    const scenario = evalScenarioSchema.parse(value);
    expect(scenario.gate_class).toBe("safety");
    expect(scenario.prompts.agent_b).toBeTruthy();
    expect(scenario.actions.forbidden.length).toBeGreaterThan(0);
  });
});
