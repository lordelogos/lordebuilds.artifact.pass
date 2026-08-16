CREATE TABLE request_rate_limits (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  expires_at INTEGER NOT NULL
);

CREATE INDEX request_rate_limits_expires_at_idx
  ON request_rate_limits (expires_at);
