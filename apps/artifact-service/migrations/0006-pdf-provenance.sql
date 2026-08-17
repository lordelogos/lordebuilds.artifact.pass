ALTER TABLE artifacts ADD COLUMN legacy_derived_object_key TEXT;
ALTER TABLE artifacts ADD COLUMN pdf_trust_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE artifacts ADD COLUMN pdf_trust_reason TEXT;
ALTER TABLE artifacts ADD COLUMN pdf_provenance_receipt TEXT;

UPDATE artifacts
SET legacy_derived_object_key = derived_object_key,
    derived_object_key = NULL,
    extraction_status = 'unavailable',
    extractor = NULL,
    extractor_version = NULL,
    page_count = NULL,
    extraction_reason = 'Legacy PDF extraction is not agent-readable.',
    pdf_trust_status = 'human_only',
    pdf_trust_reason = 'legacy'
WHERE mime_type = 'application/pdf';
