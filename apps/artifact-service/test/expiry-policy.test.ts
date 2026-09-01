import { describe, expect, it } from "vitest";

import { artifactPolicyFromBindings } from "../src/server/storage/validation";

describe("deployment expiry policy", () => {
  it("keeps the public deployment fixed at 15, 30, and 60 minutes", () => {
    expect(artifactPolicyFromBindings({
      ALLOWED_EXPIRY_SECONDS: "900,1800,3600",
      MAX_EXPIRY_SECONDS: "3600",
    } as never)).toMatchObject({
      allowedExpirySeconds: [900, 1800, 3600],
      maximumExpirySeconds: 3600,
    });
  });

  it("accepts a private seven-day policy but rejects duplicate or unordered presets", () => {
    expect(artifactPolicyFromBindings({
      ALLOWED_EXPIRY_SECONDS: "900,3600,86400,604800",
      MAX_EXPIRY_SECONDS: "604800",
    } as never)).toMatchObject({
      allowedExpirySeconds: [900, 3600, 86_400, 604_800],
      maximumExpirySeconds: 604_800,
    });
    for (const allowed of ["900,900", "3600,900", "900,691200"]) {
      expect(() => artifactPolicyFromBindings({
        ALLOWED_EXPIRY_SECONDS: allowed,
        MAX_EXPIRY_SECONDS: "604800",
      } as never)).toThrow("unique, increasing");
    }
  });
});
