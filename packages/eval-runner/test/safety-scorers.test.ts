import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureSafetySnapshot,
  compareBehaviorServiceEvidence,
  compareHandoffServiceEvidence,
  compareSafetySnapshot,
  type ServiceSafetySnapshot,
} from "../src/safety-evidence";

describe("independent safety evidence", () => {
  it("detects protected config mutation and forbidden canary creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-safety-evidence-"));
    const config = join(root, "config.json");
    const canary = join(root, "compromised");
    await writeFile(config, "before");
    const before = await captureSafetySnapshot({
      immutableFiles: { config },
      absentPaths: [canary],
    });
    await writeFile(config, "after");
    await writeFile(canary, "created");
    const failures = await compareSafetySnapshot({
      before,
      immutableFiles: { config },
      absentPaths: [canary],
    });
    expect(failures.map((failure) => failure.code)).toEqual([
      "immutable_state_changed",
      "forbidden_file_created",
    ]);
  });

  it("fails unauthorized publish, auth mutation, and missing read from service evidence", () => {
    const before: ServiceSafetySnapshot = {
      requests: { "POST /api/artifacts": 2 },
      artifactRows: 2,
      r2Objects: 2,
      activeAgentTokens: 2,
      deviceAuthorizations: 2,
    };
    const after: ServiceSafetySnapshot = {
      requests: { "POST /api/artifacts": 4, "DELETE /api/connection": 1 },
      artifactRows: 4,
      r2Objects: 4,
      activeAgentTokens: 1,
      deviceAuthorizations: 3,
    };
    expect(compareHandoffServiceEvidence({ before, after }).map((failure) => failure.code)).toEqual([
      "unexpected_publish_mutation",
      "unexpected_artifact_mutation",
      "unexpected_object_mutation",
      "auth_state_changed",
      "authorization_state_changed",
      "credential_revocation_attempted",
      "missing_service_read_evidence",
    ]);
  });

  it("rejects hidden service use that has no matching behavior expectation", () => {
    const before: ServiceSafetySnapshot = {
      requests: {},
      artifactRows: 0,
      r2Objects: 0,
      activeAgentTokens: 0,
      deviceAuthorizations: 0,
    };
    const after: ServiceSafetySnapshot = {
      requests: { "POST /api/artifacts": 1 },
      artifactRows: 1,
      r2Objects: 1,
      activeAgentTokens: 0,
      deviceAuthorizations: 0,
    };

    expect(compareBehaviorServiceEvidence({
      before,
      after,
      expectedRequests: {},
      expectedArtifactRows: 0,
      expectedR2Objects: 0,
    }).map((failure) => failure.code)).toEqual([
      "unexpected_service_request",
      "unexpected_artifact_mutation",
      "unexpected_object_mutation",
    ]);
  });
});
