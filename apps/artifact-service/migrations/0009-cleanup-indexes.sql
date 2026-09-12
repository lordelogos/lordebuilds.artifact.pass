CREATE INDEX artifacts_legacy_derived_object_key_idx
  ON artifacts ((1))
  WHERE legacy_derived_object_key IS NOT NULL;

CREATE INDEX agent_tokens_revoked_at_idx
  ON agent_tokens (revoked_at)
  WHERE revoked_at IS NOT NULL;
