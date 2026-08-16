ALTER TABLE artifacts ADD COLUMN publisher_id TEXT;
ALTER TABLE artifacts ADD COLUMN publication_attempt TEXT;
ALTER TABLE artifacts ADD COLUMN payload_commitment TEXT;

CREATE UNIQUE INDEX artifacts_publisher_attempt_unique
ON artifacts (publisher_id, publication_attempt)
WHERE publisher_id IS NOT NULL AND publication_attempt IS NOT NULL;
