ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'text';

ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS source_ref_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS attachment_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS finding_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS collaboration_policy_findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('text', 'ocr', 'asr', 'ai')),
  source_ref_id TEXT NOT NULL DEFAULT '',
  policy_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  matched_text_hash TEXT NOT NULL CHECK (char_length(matched_text_hash) = 64),
  fingerprint TEXT NOT NULL UNIQUE CHECK (char_length(fingerprint) = 64),
  action TEXT NOT NULL DEFAULT 'review',
  confidence DOUBLE PRECISION,
  rationale TEXT NOT NULL DEFAULT '',
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'confirmed', 'false_positive', 'resolved', 'escalated')),
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ,
  review_note TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_collaboration_policy_findings_session
  ON collaboration_policy_findings(tenant_id, session_id, review_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_collaboration_policy_findings_message
  ON collaboration_policy_findings(tenant_id, message_id, source, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_policy_finding_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL REFERENCES collaboration_policy_findings(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  note_hash TEXT NOT NULL CHECK (char_length(note_hash) = 64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_collaboration_policy_finding_reviews_finding
  ON collaboration_policy_finding_reviews(tenant_id, finding_id, created_at ASC);

ALTER TABLE collaboration_policy_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_policy_findings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_policy_findings;
CREATE POLICY tenant_isolation ON collaboration_policy_findings FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_policy_finding_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_policy_finding_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_policy_finding_reviews;
CREATE POLICY tenant_isolation ON collaboration_policy_finding_reviews FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
