import { describe, expect, test } from "vitest";

import { parseApprovedShareUrl } from "../src/source-policy";

const token = "A".repeat(43);
const publicUrl = `https://artifactpass.com/a/${token}`;
const origins = ["https://artifactpass.com", "https://artifacts.example.com"];

describe("approved ArtifactPass share URLs", () => {
  test("accepts exact public and configured private share URLs", () => {
    expect(parseApprovedShareUrl(publicUrl, origins)).toEqual({
      origin: "https://artifactpass.com",
      shareUrl: publicUrl,
      token,
    });
    expect(parseApprovedShareUrl(`https://artifacts.example.com/a/${token}`, origins)?.origin)
      .toBe("https://artifacts.example.com");
  });

  test.each([
    `http://artifactpass.com/a/${token}`,
    `https://artifactpass.com.evil.example/a/${token}`,
    `https://user@artifactpass.com/a/${token}`,
    `https://%61rtifactpass.com/a/${token}`,
    `https://artifactpass.com/a/${token}/raw`,
    `https://artifactpass.com/a/${token}?download=1`,
    `https://artifactpass.com/a/${token}#fragment`,
    `https://artifactpass.com/a/${"A".repeat(42)}`,
  ])("rejects a non-canonical or unapproved source: %s", (url) => {
    expect(parseApprovedShareUrl(url, origins)).toBeNull();
  });
});
