CREATE TABLE IF NOT EXISTS collaboration_message_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file', 'screen_recording')),
  storage_url TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  checksum TEXT NOT NULL DEFAULT '',
  processing_status TEXT NOT NULL DEFAULT 'ready' CHECK (processing_status IN ('pending', 'ready', 'failed')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_collab_attachments_message ON collaboration_message_attachments(message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_collab_attachments_session ON collaboration_message_attachments(session_id, created_at);

ALTER TABLE collaboration_message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_message_attachments;
CREATE POLICY tenant_isolation ON collaboration_message_attachments FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
