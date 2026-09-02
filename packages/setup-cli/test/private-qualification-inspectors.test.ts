import { describe, expect, it } from "vitest";

import { privateArtifactStorageEvidence } from "../../../scripts/inspect-private-artifact-cleanup";
import {
  assertCompletePage,
  publicResourceIdentityEvidence,
  publicResourceMutableEvidence,
} from "../../../scripts/inspect-public-resource-inventory";

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

  it("binds public mutable configuration to a redacted digest", () => {
    const evidence = publicResourceMutableEvidence({
      identities: {
        databases: [{ uuid: "d1-secret-id", name: "lordebuilds-artifacts-share" }],
        buckets: [{ name: "lordebuilds-artifacts-share" }],
        scripts: [{ id: "lordebuilds-artifacts-share" }],
        accessApps: [{ id: "access-secret-id", domain: "artifactpass.com" }],
      },
      workerSettings: { bindings: [{ name: "ARTIFACT_DB", type: "d1" }] },
      workerDomains: [{ hostname: "artifactpass.com", service: "lordebuilds-artifacts-share" }],
      d1Schema: [{ name: "artifacts", type: "table", sql: "CREATE TABLE artifacts" }],
      r2Lifecycle: { rules: [] },
      r2Objects: [{ key: "public-object", etag: "etag" }],
      accessPolicies: [{ name: "Artifact Share uploaders", decision: "allow" }],
      dnsRecords: [{ name: "artifactpass.com", type: "A", content: "192.0.2.1" }],
      grantedScopes: ["workers-scripts.write", "d1.write"],
      expectedScopes: ["d1.write", "workers-scripts.write"],
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence.mutable_state_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.oauth_client_mutation_scope_present).toBe(false);
    expect(serialized).not.toContain("d1-secret-id");
    expect(serialized).not.toContain("public-object");
  });

  it("rejects incomplete Cloudflare pages and unproven OAuth scope authority", () => {
    const identities = {
      databases: [{ name: "lordebuilds-artifacts-share" }],
      buckets: [{ name: "lordebuilds-artifacts-share" }],
      scripts: [{ id: "lordebuilds-artifacts-share" }],
      accessApps: [{ domain: "artifactpass.com" }],
    };
    const base = {
      identities,
      workerSettings: {},
      workerDomains: [],
      d1Schema: [],
      r2Lifecycle: {},
      accessPolicies: [],
      dnsRecords: [],
    };
    expect(() => assertCompletePage("public R2 object", {
      result: [],
      resultInfo: { cursor: "next-page", is_truncated: true },
    }, 1000)).toThrow("truncated");
    expect(() => publicResourceMutableEvidence({
      ...base,
      r2Objects: [],
      grantedScopes: [],
      expectedScopes: ["workers-scripts.write"],
    })).toThrow("approved profile");
    expect(() => publicResourceMutableEvidence({
      ...base,
      r2Objects: [],
      grantedScopes: ["workers-scripts.write", "unknown.write"],
      expectedScopes: ["workers-scripts.write"],
    })).toThrow("approved profile");
  });

  it("treats Access policy ordering as mutable state", () => {
    const input = {
      identities: {
        databases: [{ name: "lordebuilds-artifacts-share" }],
        buckets: [{ name: "lordebuilds-artifacts-share" }],
        scripts: [{ id: "lordebuilds-artifacts-share" }],
        accessApps: [{ domain: "artifactpass.com" }],
      },
      workerSettings: {},
      workerDomains: [],
      d1Schema: [],
      r2Lifecycle: {},
      r2Objects: [],
      accessPolicies: [{ id: "first" }, { id: "second" }],
      dnsRecords: [],
      grantedScopes: ["workers-scripts.write"],
      expectedScopes: ["workers-scripts.write"],
    } as const;

    const original = publicResourceMutableEvidence(input);
    const reordered = publicResourceMutableEvidence({
      ...input,
      accessPolicies: [...input.accessPolicies].reverse(),
    });

    expect(reordered.mutable_state_digest).not.toBe(original.mutable_state_digest);
  });
});
