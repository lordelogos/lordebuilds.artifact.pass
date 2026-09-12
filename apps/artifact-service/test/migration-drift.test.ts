import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import { agentTokens, artifacts } from "../src/server/db/schema";
import migration1 from "../migrations/0001-artifacts.sql?raw";
import migration2 from "../migrations/0002-identity.sql?raw";
import migration3 from "../migrations/0003-request-rate-limits.sql?raw";
import migration4 from "../migrations/0004-device-token-replay.sql?raw";
import migration5 from "../migrations/0005-publication-idempotency.sql?raw";
import migration6 from "../migrations/0006-pdf-provenance.sql?raw";
import migration7 from "../migrations/0007-public-auth.sql?raw";
import migration8 from "../migrations/0008-private-deployment.sql?raw";
import migration9 from "../migrations/0009-cleanup-indexes.sql?raw";

const preBackfillMigrations = [migration1, migration2, migration3, migration4, migration5] as const;
const backfillAndLaterMigrations = [migration6, migration7, migration8, migration9] as const;

const applyMigrations = async (sources: readonly string[]): Promise<void> => {
  const statements = sources.flatMap((source) =>
    source.split(";").map((statement) => statement.trim()).filter(Boolean)
  );
  await env.ARTIFACT_DB.batch(statements.map((statement) => env.ARTIFACT_DB.prepare(statement)));
};

describe("deployment migrations", () => {
  beforeEach(async () => reset());

  it("produce every table and column used by the current Worker", async () => {
    await applyMigrations(preBackfillMigrations);
    await env.ARTIFACT_DB.prepare(
      "INSERT INTO artifacts (id, status, object_key, derived_object_key, filename, mime_type, " +
      "byte_size, sha256, share_token_hash, created_at, expires_at, extraction_status) " +
      "VALUES (?, 'active', ?, ?, ?, 'application/pdf', 1, ?, ?, 1, 2, 'best_effort')",
    ).bind("legacy-pdf", "objects/legacy", "derived/legacy", "legacy.pdf", "a".repeat(64), "b".repeat(64)).run();
    await applyMigrations(backfillAndLaterMigrations);

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
    const revokedAgentTokenIndex = await env.ARTIFACT_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).bind("agent_tokens_revoked_at_idx").first<{ readonly sql: string }>();
    expect(revokedAgentTokenIndex?.sql).toContain("WHERE revoked_at IS NOT NULL");
    const legacyArtifactIndex = await env.ARTIFACT_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).bind("artifacts_legacy_derived_object_key_idx").first<{ readonly sql: string }>();
    expect(legacyArtifactIndex?.sql).toContain("WHERE legacy_derived_object_key IS NOT NULL");

    const legacyPlan = await env.ARTIFACT_DB.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM artifacts WHERE legacy_derived_object_key IS NOT NULL LIMIT ?",
    ).bind(100).all<{ readonly detail: string }>();
    expect(legacyPlan.results.map((row) => row.detail).join("\n")).toContain(
      "USING INDEX artifacts_legacy_derived_object_key_idx",
    );
    expect(
      getTableConfig(artifacts).indexes.find(
        (candidate) => candidate.config.name === "artifacts_publisher_attempt_unique",
      )?.config.where,
    ).toBeDefined();
    expect(
      getTableConfig(artifacts).indexes.find(
        (candidate) => candidate.config.name === "artifacts_legacy_derived_object_key_idx",
      )?.config.where,
    ).toBeDefined();
    expect(
      getTableConfig(agentTokens).indexes.find(
        (candidate) => candidate.config.name === "agent_tokens_revoked_at_idx",
      )?.config.where,
    ).toBeDefined();
  });
});
