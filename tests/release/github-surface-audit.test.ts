import { describe, expect, it } from "vitest";

import { auditSurfaceText } from "../../scripts/github-surface-audit-core.mjs";

describe("GitHub public-surface audit", () => {
  it("reports a sensitive value without retaining it", () => {
    const secret = `cf${"ut_"}${"x".repeat(32)}`;
    const findings = auditSurfaceText([{
      surface: "issue",
      identity: "42",
      text: `accidental value ${secret}`,
    }]);

    expect(findings).toEqual([{
      surface: "issue",
      identity: "42",
      label: "Cloudflare user token",
      line: 1,
    }]);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("keeps ordinary public metadata clean", () => {
    expect(auditSurfaceText([{
      surface: "release",
      identity: "v0.1.0-rc.18",
      text: "ArtifactPass release candidate",
    }])).toEqual([]);
  });
});
