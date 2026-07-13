ALTER TABLE collaboration_quality_review_jobs
  ADD COLUMN IF NOT EXISTS automatic BOOLEAN NOT NULL DEFAULT TRUE;
