import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { evalScenarioSchema } from "../src/contracts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("published eval scenario JSON Schema", () => {
  it("matches the runtime contract for representative nested inputs", async () => {
    const schema = JSON.parse(await readFile(
      join(repositoryRoot, "evals/scenarios/schema-version-1.json"),
      "utf8",
    )) as object;
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const valid = JSON.parse(await readFile(
      join(repositoryRoot, "evals/scenarios/behavior/share-markdown.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(validate(valid)).toBe(true);
    expect(evalScenarioSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, fixtures: [null] },
      { ...valid, prompts: { agent_a: "" } },
      { ...valid, actions: { allowed: [null], required: [], forbidden: [] } },
      { ...valid, budgets: { timeout_ms: 0, max_steps: 1, max_tool_calls: 1, max_artifact_bytes: 1, max_trials: 1 } },
    ]) {
      expect(validate(invalid)).toBe(false);
      expect(evalScenarioSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
