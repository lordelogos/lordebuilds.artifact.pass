import { describe, expect, test } from "vitest";

import { findSensitiveContent } from "../../scripts/security-patterns.mjs";

describe("release secret patterns", () => {
  test("detects capability URLs without flagging ordinary artifact paths", () => {
    const capability = ["https://artifacts.example.test", "a", "s".repeat(43)].join("/");
    expect(findSensitiveContent(capability)).toEqual([
      expect.objectContaining({ label: "ArtifactPass capability URL" }),
    ]);
    expect(findSensitiveContent("https://artifacts.example.test/upload")).toEqual([]);
  });
});
