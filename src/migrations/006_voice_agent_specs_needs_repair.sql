-- Allow IVR flow repair lifecycle status on Postgres (SQLite migrates via db.ts).
ALTER TABLE voice_agent_specs DROP CONSTRAINT IF EXISTS voice_agent_specs_status_check;
ALTER TABLE voice_agent_specs ADD CONSTRAINT voice_agent_specs_status_check
  CHECK (status IN ('draft', 'published', 'needs_repair'));
