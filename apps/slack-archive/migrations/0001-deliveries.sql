CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('transferring', 'succeeded', 'failed', 'needs-review')),
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  claim_id TEXT NOT NULL,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX deliveries_status_updated ON deliveries (status, updated_at);
