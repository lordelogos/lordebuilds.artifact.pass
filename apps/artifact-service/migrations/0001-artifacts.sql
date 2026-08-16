CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'cleanup_pending')),
  object_key TEXT NOT NULL UNIQUE,
  derived_object_key TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL,
  share_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  extraction_status TEXT NOT NULL,
  extractor TEXT,
  extractor_version TEXT,
  page_count INTEGER,
  extraction_reason TEXT,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  last_cleanup_error TEXT
);

CREATE INDEX artifacts_status_expires_at_idx ON artifacts (status, expires_at);

