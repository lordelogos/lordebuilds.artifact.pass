CREATE TABLE device_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  code_challenge TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  poll_attempts INTEGER NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  identity_subject TEXT,
  identity_email TEXT,
  approved_at INTEGER,
  consumed_at INTEGER
);

CREATE INDEX device_authorizations_expires_at_idx
  ON device_authorizations (expires_at);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  identity_subject TEXT NOT NULL,
  identity_email TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'artifact:create'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX agent_tokens_expires_at_idx
  ON agent_tokens (expires_at);

