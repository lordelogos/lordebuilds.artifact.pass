import { describe, expect, it } from "vitest";

import { artifactPolicyFromBindings } from "../src/server/storage/validation";

describe("deployment expiry policy", () => {
  it("keeps short API presets while allowing public links up to seven days", () => {
    expect(artifactPolicyFromBindings({
      ALLOWED_EXPIRY_SECONDS: "900,1800,3600,86400,604800",
      MAX_EXPIRY_SECONDS: "604800",
    } as never)).toMatchObject({
      allowedExpirySeconds: [900, 1800, 3600, 86_400, 604_800],
      maximumExpirySeconds: 604_800,
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
