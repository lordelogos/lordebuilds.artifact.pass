import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  evalScenarioJsonSchema,
  evalScenarioSchema,
  validateEvalScenarioRuntimeContract,
} from "../src/contracts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("published eval scenario JSON Schema", () => {
  it("is generated from the runtime contract", async () => {
    const schema = JSON.parse(await readFile(
      join(repositoryRoot, "evals/scenarios/schema-version-1.json"),
      "utf8",
    )) as object;
    expect(schema).toEqual(evalScenarioJsonSchema);
  });

  it("matches the runtime contract for structural and semantic invalid inputs", async () => {
    const schema = JSON.parse(await readFile(
      join(repositoryRoot, "evals/scenarios/schema-version-1.json"),
      "utf8",
    )) as object;
    expect(() => new Ajv2020({ allErrors: true }).compile(schema)).toThrow(/unknown keyword/u);
    const ajv = new Ajv2020({ allErrors: true });
    ajv.addKeyword({
      keyword: "x-artifactpass-runtime-contract",
      schemaType: "string",
      errors: false,
      validate: validateEvalScenarioRuntimeContract,
    });
    const validate = ajv.compile(schema);
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
      {
        ...valid,
        repetition: { trials: 21, max_infrastructure_retries: 1 },
        budgets: { ...(valid.budgets as object), max_trials: 20 },
      },
      {
        ...valid,
        actions: {
          ...(valid.actions as object),
          required: [{ kind: "mcp_tool", name: "read_artifact" }],
        },
      },
      {
        ...valid,
        actions: {
          ...(valid.actions as object),
          forbidden: [{ kind: "mcp_tool", name: "publish_artifact" }],
        },
      },
    ]) {
      expect(validate(invalid)).toBe(false);
      expect(evalScenarioSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
