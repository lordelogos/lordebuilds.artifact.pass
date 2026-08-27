CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX oauth_transactions_expires_at_idx
  ON oauth_transactions (expires_at);

CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  identity_subject TEXT NOT NULL,
  identity_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX web_sessions_expires_at_idx
  ON web_sessions (expires_at);

CREATE INDEX web_sessions_revoked_at_idx
  ON web_sessions (revoked_at)
  WHERE revoked_at IS NOT NULL;
