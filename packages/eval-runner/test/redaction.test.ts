import { describe, expect, it } from "vitest";

import {
  RedactingChunkCollector,
  createIndependentRunId,
  redactSensitiveText,
  redactSensitiveValue,
  serializeRedacted,
} from "../src/redaction";

const token = "Z0J7-dS0-ArDdvW2cSSMFxiearBOa-ndd1zKz8jijIs";
const localUrl = `http://127.0.0.1:8787/a/${token}`;
const productionUrl = `https://artifactpass.com/a/${token}`;

describe("eval redaction", () => {
  it.each([localUrl, productionUrl])("removes the capability URL and token from %s", (url) => {
    const output = redactSensitiveText(`redirect=${url}`);
    expect(output).not.toContain(url);
    expect(output).not.toContain(token);
  });

  it("removes encoded and JSON-escaped capability links", () => {
    const encoded = encodeURIComponent(productionUrl);
    const escaped = productionUrl.replaceAll("/", "\\/");
    const output = redactSensitiveText(`${encoded} ${escaped}`);
    expect(output).not.toContain(token);
    expect(output).not.toContain(encoded);
    expect(output).not.toContain(escaped);
  });

  it("redacts nested headers, exceptions, raw streams, and sensitive paths", () => {
    const output = serializeRedacted({
      headers: { authorization: "Bearer secret-value" },
      error: new Error(`Request failed at ${productionUrl}`).message,
      stdout: productionUrl,
      workspace_path: "/Users/person/private/source.md",
      nested: [{ redirect: productionUrl }],
    });
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain(token);
    expect(output).not.toContain("/Users/person");
    expect(output).toContain("[PATH]");
  });

  it("handles bearer values split across stream chunks", () => {
    const collector = new RedactingChunkCollector();
    collector.push("http://127.0.0.1:8787/a/Z0J7-dS0-");
    collector.push("ArDdvW2cSSMFxiearBOa-ndd1zKz8jijIs");
    const output = collector.finish();
    expect(output).not.toContain(token);
    expect(output).toBe("[REDACTED]");
  });

  it("creates correlation identifiers independent from bearer links", () => {
    const runId = createIndependentRunId();
    expect(runId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(runId).not.toContain(token.slice(0, 8));
  });

  it("preserves ordinary values while redacting sensitive keys", () => {
    expect(redactSensitiveValue({ scenario_id: "publish-markdown", api_key: "secret" })).toEqual({
      scenario_id: "publish-markdown",
      api_key: "[REDACTED]",
    });
  });
});
