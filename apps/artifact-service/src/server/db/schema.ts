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

export const ARTIFACT_SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'cleanup_pending')), object_key TEXT NOT NULL UNIQUE, derived_object_key TEXT, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK (byte_size >= 0), sha256 TEXT NOT NULL, share_token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, extraction_status TEXT NOT NULL, extractor TEXT, extractor_version TEXT, page_count INTEGER, extraction_reason TEXT, cleanup_attempts INTEGER NOT NULL DEFAULT 0, last_cleanup_error TEXT);",
  "CREATE INDEX IF NOT EXISTS artifacts_status_expires_at_idx ON artifacts (status, expires_at);",
].join("\n");
