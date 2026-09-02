import { describe, expect, it } from "vitest";

import { privateArtifactStorageEvidence } from "../../../scripts/inspect-private-artifact-cleanup";
import { publicResourceIdentityEvidence } from "../../../scripts/inspect-public-resource-inventory";

describe("private qualification inspectors", () => {
  it("requires a proven present state before cleanup", () => {
    const evidence = privateArtifactStorageEvidence({
      artifactId: "artifact-123",
      rowCount: 1,
      objects: [{ key: "artifacts/artifact-123/source" }],
      expectation: "present",
    });

    expect(evidence).toMatchObject({
      expected_state: "present",
      metadata_row_present: true,
      stored_object_count: 1,
    });
    expect(JSON.stringify(evidence)).not.toContain("artifact-123");
  });

  it("fails an absent-state check while any private data remains", () => {
    expect(() => privateArtifactStorageEvidence({
      artifactId: "artifact-123",
      rowCount: 0,
      objects: [{ key: "artifacts/artifact-123/derived-text" }],
      expectation: "absent",
    })).toThrow("did not match the expected absent state");
  });

  it("rejects truncated or prefix-unsafe R2 evidence", () => {
    expect(() => privateArtifactStorageEvidence({
      artifactId: "artifact-123",
      rowCount: 0,
      objects: [],
      expectation: "absent",
      truncated: true,
    })).toThrow("truncated");
    expect(() => privateArtifactStorageEvidence({
      artifactId: "artifact-123",
      rowCount: 1,
      objects: [{ key: "artifacts/a-different-artifact/source" }],
      expectation: "present",
    })).toThrow("ignored the private artifact object prefix");
  });

  it("emits only a redacted public identity digest and exact counts", () => {
    const evidence = publicResourceIdentityEvidence({
      databases: [{ uuid: "d1-secret-id", name: "lordebuilds-artifacts-share" }],
      buckets: [{ name: "lordebuilds-artifacts-share" }],
      scripts: [{ id: "lordebuilds-artifacts-share" }],
      accessApps: [{ id: "access-secret-id", domain: "artifactpass.com" }],
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence.resource_counts).toEqual({ d1: 1, r2: 1, workers: 1, access: 1 });
    expect(serialized).not.toContain("d1-secret-id");
    expect(serialized).not.toContain("access-secret-id");
    expect(serialized).not.toContain("lordebuilds-artifacts-share");
  });

  it("fails when any expected public identity is missing", () => {
    expect(() => publicResourceIdentityEvidence({
      databases: [],
      buckets: [{ name: "lordebuilds-artifacts-share" }],
      scripts: [{ id: "lordebuilds-artifacts-share" }],
      accessApps: [{ domain: "artifactpass.com" }],
    })).toThrow("Expected 1 public d1 resource but found 0");
  });
});
