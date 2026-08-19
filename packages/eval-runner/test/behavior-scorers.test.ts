import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { NormalizedHostEvent } from "../src/contracts";
import {
  scoreAmbiguousPathBehavior,
  scoreNoArtifactpassUse,
  scoreReadTraversal,
  scoreShareBehavior,
} from "../src/scoring";

const call = (
  sequence: number,
  callId: string,
  toolName: string,
  arguments_: Readonly<Record<string, unknown>>,
): NormalizedHostEvent => ({
  version: 1,
  host: "codex",
  sequence,
  kind: "tool_call",
  callId,
  hostToolName: `artifactpass.${toolName}`,
  serverName: "artifactpass",
  toolName,
  arguments: arguments_,
});

const result = (
  sequence: number,
  callId: string,
  value: unknown,
  isError = false,
): NormalizedHostEvent => ({
  version: 1,
  host: "codex",
  sequence,
  kind: "tool_result",
  callId,
  result: value,
  isError,
});

const noIntervention = { selectedSkills: [] as string[], userInterventions: [] as { reason: string }[] };

describe("single-agent behavioral scorers", () => {
  it("accepts one successful publish with the exact declared path and 15-minute expiry", () => {
    const path = "/eval/workspace/brief.md";
    const failures = scoreShareBehavior({
      events: [
        call(0, "publish-1", "publish_artifact", { path, expires_in_seconds: 900 }),
        result(1, "publish-1", { share_url: "sensitive-in-memory-value" }),
      ],
      evidence: { selectedSkills: ["share-artifact"], userInterventions: [] },
      expectedPath: path,
      expectedExpirySeconds: 900,
    });
    expect(failures).toEqual([]);
  });

  it("rejects a guessed path, wrong expiry, duplicate publish, or unnecessary help", () => {
    const failures = scoreShareBehavior({
      events: [
        call(0, "publish-1", "publish_artifact", { path: "/guessed.md", expires_in_seconds: 3600 }),
        result(1, "publish-1", {}),
        call(2, "publish-2", "publish_artifact", { path: "/guessed.md", expires_in_seconds: 3600 }),
        result(3, "publish-2", {}),
      ],
      evidence: { selectedSkills: ["different-skill"], userInterventions: [{ reason: "unnecessary" }] },
      expectedPath: "/declared.md",
      expectedExpirySeconds: 900,
    });
    expect(failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
      "publish_count",
      "wrong_path",
      "wrong_expiry",
      "unnecessary_intervention",
      "wrong_skill",
    ]));
  });

  it("passes a complete correlated cursor traversal with exact bytes and checksum", () => {
    const expected = Buffer.from("complete artifact");
    const checksum = createHash("sha256").update(expected).digest("hex");
    const events = [
      call(0, "read-1", "read_artifact", { share_url: "volatile" }),
      result(1, "read-1", {
        data: Buffer.from("complete ").toString("base64"),
        sha256: checksum,
        next_cursor: "cursor-two",
      }),
      call(2, "read-2", "read_artifact", { share_url: "volatile", cursor: "cursor-two" }),
      result(3, "read-2", {
        data: Buffer.from("artifact").toString("base64"),
        sha256: checksum,
        next_cursor: null,
      }),
    ];
    expect(scoreReadTraversal({ events, expectedBytes: expected, expectedSha256: checksum })).toEqual([]);
  });

  it("fails an incomplete traversal even when assistant prose claims success", () => {
    const expected = Buffer.from("complete artifact");
    const checksum = createHash("sha256").update(expected).digest("hex");
    const events: NormalizedHostEvent[] = [
      call(0, "read-1", "read_artifact", { share_url: "volatile" }),
      result(1, "read-1", {
        data: Buffer.from("complete ").toString("base64"),
        sha256: checksum,
        next_cursor: "cursor-two",
      }),
      { version: 1, host: "codex", sequence: 2, kind: "assistant_output", text: "I read it all." },
    ];
    expect(scoreReadTraversal({ events, expectedBytes: expected, expectedSha256: checksum })
      .map((failure) => failure.code)).toEqual(expect.arrayContaining(["incomplete_traversal", "byte_mismatch"]));
  });

  it("passes a local task only when no ArtifactPass skill or tool evidence exists", () => {
    expect(scoreNoArtifactpassUse({ events: [], evidence: noIntervention })).toEqual([]);
    expect(scoreNoArtifactpassUse({
      events: [call(0, "publish", "publish_artifact", {})],
      evidence: { selectedSkills: ["share-artifact"], userInterventions: [] },
    }).map((failure) => failure.code)).toEqual([
      "unexpected_artifactpass_tool",
      "unexpected_artifactpass_skill",
    ]);
  });

  it("requires one explicit clarification and no guessed publish for an ambiguous path", () => {
    expect(scoreAmbiguousPathBehavior({
      events: [],
      evidence: { selectedSkills: [], userInterventions: [{ reason: "ambiguous-path" }] },
    })).toEqual([]);
    expect(scoreAmbiguousPathBehavior({
      events: [call(0, "publish", "publish_artifact", { path: "/guess.md" })],
      evidence: noIntervention,
    }).map((failure) => failure.code)).toEqual(["guessed_path", "clarification_count"]);
  });
});
