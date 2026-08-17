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

const migrations = [migration1, migration2, migration3, migration4, migration5] as const;

describe("deployment migrations", () => {
  beforeEach(async () => reset());

  it("produce every table and column used by the current Worker", async () => {
    for (const source of migrations) {
      const statements = source.split(";").map((statement) => statement.trim()).filter(Boolean);
      await env.ARTIFACT_DB.batch(statements.map((statement) => env.ARTIFACT_DB.prepare(statement)));
    }

    const tables = await env.ARTIFACT_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ readonly name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "agent_tokens",
      "artifacts",
      "device_authorizations",
      "request_rate_limits",
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
    ]));

    const publicationIndex = await env.ARTIFACT_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).bind("artifacts_publisher_attempt_unique").first<{ readonly sql: string }>();
    expect(publicationIndex?.sql).toContain(
      "WHERE publisher_id IS NOT NULL AND publication_attempt IS NOT NULL",
    );
    expect(
      getTableConfig(artifacts).indexes.find(
        (candidate) => candidate.config.name === "artifacts_publisher_attempt_unique",
      )?.config.where,
    ).toBeDefined();
  });
});
