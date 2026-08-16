import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: ["staging", "active", "cleanup_pending"] }).notNull(),
    objectKey: text("object_key").notNull(),
    derivedObjectKey: text("derived_object_key"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    shareTokenHash: text("share_token_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    extractionStatus: text("extraction_status").notNull(),
    extractor: text("extractor"),
    extractorVersion: text("extractor_version"),
    pageCount: integer("page_count"),
    extractionReason: text("extraction_reason"),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    lastCleanupError: text("last_cleanup_error"),
  },
  (table) => [
    uniqueIndex("artifacts_object_key_unique").on(table.objectKey),
    uniqueIndex("artifacts_share_token_hash_unique").on(table.shareTokenHash),
    index("artifacts_status_expires_at_idx").on(table.status, table.expiresAt),
  ],
);

export const deviceAuthorizations = sqliteTable(
  "device_authorizations",
  {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCodeHash: text("user_code_hash").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    status: text("status", { enum: ["pending", "approved", "consumed"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    nextPollAt: integer("next_poll_at").notNull(),
    pollAttempts: integer("poll_attempts").notNull().default(0),
    identitySubject: text("identity_subject"),
    identityEmail: text("identity_email"),
    approvedAt: integer("approved_at"),
    consumedAt: integer("consumed_at"),
  },
  (table) => [
    uniqueIndex("device_authorizations_device_code_hash_unique").on(table.deviceCodeHash),
    uniqueIndex("device_authorizations_user_code_hash_unique").on(table.userCodeHash),
    index("device_authorizations_expires_at_idx").on(table.expiresAt),
  ],
);

export const agentTokens = sqliteTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    identitySubject: text("identity_subject").notNull(),
    identityEmail: text("identity_email").notNull(),
    scope: text("scope", { enum: ["artifact:create"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("agent_tokens_token_hash_unique").on(table.tokenHash),
    index("agent_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

export const ARTIFACT_SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'cleanup_pending')), object_key TEXT NOT NULL UNIQUE, derived_object_key TEXT, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK (byte_size >= 0), sha256 TEXT NOT NULL, share_token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, extraction_status TEXT NOT NULL, extractor TEXT, extractor_version TEXT, page_count INTEGER, extraction_reason TEXT, cleanup_attempts INTEGER NOT NULL DEFAULT 0, last_cleanup_error TEXT);",
  "CREATE INDEX IF NOT EXISTS artifacts_status_expires_at_idx ON artifacts (status, expires_at);",
  "CREATE TABLE IF NOT EXISTS device_authorizations (id TEXT PRIMARY KEY NOT NULL, device_code_hash TEXT NOT NULL UNIQUE, user_code_hash TEXT NOT NULL UNIQUE, code_challenge TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, next_poll_at INTEGER NOT NULL, poll_attempts INTEGER NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0), identity_subject TEXT, identity_email TEXT, approved_at INTEGER, consumed_at INTEGER);",
  "CREATE INDEX IF NOT EXISTS device_authorizations_expires_at_idx ON device_authorizations (expires_at);",
  "CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL UNIQUE, identity_subject TEXT NOT NULL, identity_email TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope = 'artifact:create'), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);",
  "CREATE INDEX IF NOT EXISTS agent_tokens_expires_at_idx ON agent_tokens (expires_at);",
].join("\n");
