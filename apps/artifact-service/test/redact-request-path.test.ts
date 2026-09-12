import { describe, expect, it } from "vitest";

import { redactRequestPath } from "../src/server/observability/redact-request-path";

describe("request-path redaction", () => {
  it("removes capability tokens while retaining safe route context", () => {
    expect(redactRequestPath(`/a/${"A".repeat(43)}/source`)).toBe("/a/:capability/source");
    expect(redactRequestPath("/auth/callback/google")).toBe("/auth/callback/google");
  });
});
