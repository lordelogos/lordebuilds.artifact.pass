CREATE TABLE deployment_metadata (
  deployment_id TEXT PRIMARY KEY NOT NULL,
  manifest_digest TEXT NOT NULL,
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  service_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE device_authorizations ADD COLUMN device_key_id TEXT;
ALTER TABLE device_authorizations ADD COLUMN device_public_key TEXT;
ALTER TABLE device_authorizations ADD COLUMN agent_name TEXT;
ALTER TABLE device_authorizations ADD COLUMN workspace_identity TEXT;

CREATE TABLE device_signing_keys (
  key_id TEXT PRIMARY KEY NOT NULL,
  public_key TEXT NOT NULL,
  agent_token_id TEXT,
  workspace_identity TEXT NOT NULL,
  deployment_origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX device_signing_keys_agent_token_id_idx
  ON device_signing_keys (agent_token_id);

CREATE INDEX device_signing_keys_revoked_at_idx
  ON device_signing_keys (revoked_at)
  WHERE revoked_at IS NOT NULL;
