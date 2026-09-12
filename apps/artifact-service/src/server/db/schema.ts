import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: ["staging", "active", "cleanup_pending"] }).notNull(),
    objectKey: text("object_key").notNull(),
    derivedObjectKey: text("derived_object_key"),
    legacyDerivedObjectKey: text("legacy_derived_object_key"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    shareTokenHash: text("share_token_hash").notNull(),
    publisherId: text("publisher_id"),
    publicationAttempt: text("publication_attempt"),
    payloadCommitment: text("payload_commitment"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    extractionStatus: text("extraction_status").notNull(),
    extractor: text("extractor"),
    extractorVersion: text("extractor_version"),
    pageCount: integer("page_count"),
    extractionReason: text("extraction_reason"),
    pdfTrustStatus: text("pdf_trust_status", { enum: ["not_applicable", "human_only", "controlled"] }).notNull().default("not_applicable"),
    pdfTrustReason: text("pdf_trust_reason"),
    pdfProvenanceReceipt: text("pdf_provenance_receipt"),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    lastCleanupError: text("last_cleanup_error"),
  },
  (table) => [
    uniqueIndex("artifacts_object_key_unique").on(table.objectKey),
    uniqueIndex("artifacts_share_token_hash_unique").on(table.shareTokenHash),
    uniqueIndex("artifacts_publisher_attempt_unique").on(
      table.publisherId,
      table.publicationAttempt,
    ).where(sql`${table.publisherId} IS NOT NULL AND ${table.publicationAttempt} IS NOT NULL`),
    index("artifacts_status_expires_at_idx").on(table.status, table.expiresAt),
    index("artifacts_legacy_derived_object_key_idx").on(sql`1`)
      .where(sql`${table.legacyDerivedObjectKey} IS NOT NULL`),
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
    agentTokenId: text("agent_token_id"),
    deviceKeyId: text("device_key_id"),
    devicePublicKey: text("device_public_key"),
    agentName: text("agent_name"),
    workspaceIdentity: text("workspace_identity"),
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
    index("agent_tokens_revoked_at_idx").on(table.revokedAt)
      .where(sql`${table.revokedAt} IS NOT NULL`),
  ],
);

export const requestRateLimits = sqliteTable("request_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  requestCount: integer("request_count").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const oauthTransactions = sqliteTable("oauth_transactions", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider", { enum: ["google", "github"] }).notNull(),
  returnTo: text("return_to").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const webSessions = sqliteTable("web_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  identitySubject: text("identity_subject").notNull(),
  identityEmail: text("identity_email").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const deploymentMetadata = sqliteTable("deployment_metadata", {
  deploymentId: text("deployment_id").primaryKey(),
  manifestDigest: text("manifest_digest").notNull(),
  accountId: text("account_id").notNull(),
  zoneId: text("zone_id").notNull(),
  hostname: text("hostname").notNull(),
  serviceName: text("service_name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const deviceSigningKeys = sqliteTable(
  "device_signing_keys",
  {
    keyId: text("key_id").primaryKey(),
    publicKey: text("public_key").notNull(),
    agentTokenId: text("agent_token_id"),
    workspaceIdentity: text("workspace_identity").notNull(),
    deploymentOrigin: text("deployment_origin").notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("device_signing_keys_agent_token_id_idx").on(table.agentTokenId),
    index("device_signing_keys_revoked_at_idx").on(table.revokedAt),
  ],
);

export const ARTIFACT_SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'cleanup_pending')), object_key TEXT NOT NULL UNIQUE, derived_object_key TEXT, legacy_derived_object_key TEXT, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK (byte_size >= 0), sha256 TEXT NOT NULL, share_token_hash TEXT NOT NULL UNIQUE, publisher_id TEXT, publication_attempt TEXT, payload_commitment TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, extraction_status TEXT NOT NULL, extractor TEXT, extractor_version TEXT, page_count INTEGER, extraction_reason TEXT, pdf_trust_status TEXT NOT NULL DEFAULT 'not_applicable', pdf_trust_reason TEXT, pdf_provenance_receipt TEXT, cleanup_attempts INTEGER NOT NULL DEFAULT 0, last_cleanup_error TEXT);",
  "CREATE INDEX IF NOT EXISTS artifacts_status_expires_at_idx ON artifacts (status, expires_at);",
  "CREATE INDEX IF NOT EXISTS artifacts_legacy_derived_object_key_idx ON artifacts ((1)) WHERE legacy_derived_object_key IS NOT NULL;",
  "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_publisher_attempt_unique ON artifacts (publisher_id, publication_attempt) WHERE publisher_id IS NOT NULL AND publication_attempt IS NOT NULL;",
  "CREATE TABLE IF NOT EXISTS device_authorizations (id TEXT PRIMARY KEY NOT NULL, device_code_hash TEXT NOT NULL UNIQUE, user_code_hash TEXT NOT NULL UNIQUE, code_challenge TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, next_poll_at INTEGER NOT NULL, poll_attempts INTEGER NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0), identity_subject TEXT, identity_email TEXT, approved_at INTEGER, consumed_at INTEGER, agent_token_id TEXT, device_key_id TEXT, device_public_key TEXT, agent_name TEXT, workspace_identity TEXT);",
  "CREATE INDEX IF NOT EXISTS device_authorizations_expires_at_idx ON device_authorizations (expires_at);",
  "CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL UNIQUE, identity_subject TEXT NOT NULL, identity_email TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope = 'artifact:create'), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);",
  "CREATE INDEX IF NOT EXISTS agent_tokens_expires_at_idx ON agent_tokens (expires_at);",
  "CREATE INDEX IF NOT EXISTS agent_tokens_revoked_at_idx ON agent_tokens (revoked_at) WHERE revoked_at IS NOT NULL;",
  "CREATE TABLE IF NOT EXISTS request_rate_limits (bucket_key TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, request_count INTEGER NOT NULL CHECK (request_count >= 0), expires_at INTEGER NOT NULL);",
  "CREATE INDEX IF NOT EXISTS request_rate_limits_expires_at_idx ON request_rate_limits (expires_at);",
  "CREATE TABLE IF NOT EXISTS oauth_transactions (state_hash TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('google', 'github')), return_to TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);",
  "CREATE INDEX IF NOT EXISTS oauth_transactions_expires_at_idx ON oauth_transactions (expires_at);",
  "CREATE TABLE IF NOT EXISTS web_sessions (token_hash TEXT PRIMARY KEY NOT NULL, identity_subject TEXT NOT NULL, identity_email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);",
  "CREATE INDEX IF NOT EXISTS web_sessions_expires_at_idx ON web_sessions (expires_at);",
  "CREATE INDEX IF NOT EXISTS web_sessions_revoked_at_idx ON web_sessions (revoked_at) WHERE revoked_at IS NOT NULL;",
  "CREATE TABLE IF NOT EXISTS deployment_metadata (deployment_id TEXT PRIMARY KEY NOT NULL, manifest_digest TEXT NOT NULL, account_id TEXT NOT NULL, zone_id TEXT NOT NULL, hostname TEXT NOT NULL, service_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS device_signing_keys (key_id TEXT PRIMARY KEY NOT NULL, public_key TEXT NOT NULL, agent_token_id TEXT, workspace_identity TEXT NOT NULL, deployment_origin TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);",
  "CREATE INDEX IF NOT EXISTS device_signing_keys_agent_token_id_idx ON device_signing_keys (agent_token_id);",
  "CREATE INDEX IF NOT EXISTS device_signing_keys_revoked_at_idx ON device_signing_keys (revoked_at) WHERE revoked_at IS NOT NULL;",
].join("\n");
