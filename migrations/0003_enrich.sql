-- Derived enrichment fields (description text itself is never stored).
-- Rows ingested before this migration have role_family NULL until next ingest re-enriches them.
ALTER TABLE jobs ADD COLUMN country_set TEXT NOT NULL DEFAULT '';           -- ',US,GB,' sorted ISO2, '' if unknown
ALTER TABLE jobs ADD COLUMN remote INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN sponsorship TEXT NOT NULL DEFAULT 'unknown';    -- offers | no | unknown
ALTER TABLE jobs ADD COLUMN role_family TEXT;
ALTER TABLE jobs ADD COLUMN seniority TEXT;
ALTER TABLE jobs ADD COLUMN grad_window_start TEXT;                         -- YYYY-MM
ALTER TABLE jobs ADD COLUMN grad_window_end TEXT;
ALTER TABLE jobs ADD COLUMN employment_type TEXT;

CREATE INDEX idx_jobs_status_first_seen ON jobs (status, first_seen_at);
CREATE INDEX idx_jobs_role_seniority ON jobs (role_family, seniority);
