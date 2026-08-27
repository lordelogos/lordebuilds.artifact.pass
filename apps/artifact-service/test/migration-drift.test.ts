import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import { artifacts } from "../src/server/db/schema";
import migration1 from "../migrations/0001-artifacts.sql?raw";
import migration2 from "../migrations/0002-identity.sql?raw";
import migration3 from "../migrations/0003-request-rate-limits.sql?raw";
import migration4 from "../migrations/0004-device-token-replay.sql?raw";
import migration5 from "../migrations/0005-publication-idempotency.sql?raw";
import migration6 from "../migrations/0006-pdf-provenance.sql?raw";
import migration7 from "../migrations/0007-public-auth.sql?raw";

const migrations = [migration1, migration2, migration3, migration4, migration5] as const;

describe("deployment migrations", () => {
  beforeEach(async () => reset());

  it("produce every table and column used by the current Worker", async () => {
    for (const source of migrations) {
      const statements = source.split(";").map((statement) => statement.trim()).filter(Boolean);
      await env.ARTIFACT_DB.batch(statements.map((statement) => env.ARTIFACT_DB.prepare(statement)));
    }
    await env.ARTIFACT_DB.prepare(
      "INSERT INTO artifacts (id, status, object_key, derived_object_key, filename, mime_type, " +
      "byte_size, sha256, share_token_hash, created_at, expires_at, extraction_status) " +
      "VALUES (?, 'active', ?, ?, ?, 'application/pdf', 1, ?, ?, 1, 2, 'best_effort')",
    ).bind("legacy-pdf", "objects/legacy", "derived/legacy", "legacy.pdf", "a".repeat(64), "b".repeat(64)).run();
    for (const statement of `${migration6}\n${migration7}`.split(";").map((candidate) => candidate.trim()).filter(Boolean)) {
      await env.ARTIFACT_DB.prepare(statement).run();
    }

    const tables = await env.ARTIFACT_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ readonly name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "agent_tokens",
      "artifacts",
      "device_authorizations",
      "request_rate_limits",
      "oauth_transactions",
      "web_sessions",
    ]));

    const deviceColumns = await env.ARTIFACT_DB.prepare(
      "PRAGMA table_info(device_authorizations)",
    ).all<{ readonly name: string }>();
    expect(deviceColumns.results.map((row) => row.name)).toContain("agent_token_id");

    const artifactColumns = await env.ARTIFACT_DB.prepare(
      "PRAGMA table_info(artifacts)",
    ).all<{ readonly name: string }>();
    expect(artifactColumns.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "publisher_id",
      "publication_attempt",
      "payload_commitment",
      "legacy_derived_object_key",
      "pdf_trust_status",
      "pdf_trust_reason",
      "pdf_provenance_receipt",
    ]));

    await expect(env.ARTIFACT_DB.prepare(
      "SELECT derived_object_key, legacy_derived_object_key, extraction_status, pdf_trust_status, pdf_trust_reason " +
      "FROM artifacts WHERE id = ?",
    ).bind("legacy-pdf").first()).resolves.toEqual({
      derived_object_key: null,
      legacy_derived_object_key: "derived/legacy",
      extraction_status: "unavailable",
      pdf_trust_status: "human_only",
      pdf_trust_reason: "legacy",
    });

    const publicationIndex = await env.ARTIFACT_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).bind("artifacts_publisher_attempt_unique").first<{ readonly sql: string }>();
    expect(publicationIndex?.sql).toContain(
      "WHERE publisher_id IS NOT NULL AND publication_attempt IS NOT NULL",
    );
    const revokedSessionIndex = await env.ARTIFACT_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).bind("web_sessions_revoked_at_idx").first<{ readonly sql: string }>();
    expect(revokedSessionIndex?.sql).toContain("WHERE revoked_at IS NOT NULL");
    expect(
      getTableConfig(artifacts).indexes.find(
        (candidate) => candidate.config.name === "artifacts_publisher_attempt_unique",
      )?.config.where,
    ).toBeDefined();
  });
});
