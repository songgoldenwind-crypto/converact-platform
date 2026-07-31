CREATE TABLE IF NOT EXISTS collaboration_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  title TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_business ON collaboration_sessions(tenant_id, business_ref_type, business_ref_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_status ON collaboration_sessions(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_participants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  identity TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'agent', 'engineer', 'supervisor', 'ai', 'admin')),
  display_name TEXT NOT NULL DEFAULT '',
  user_ref_type TEXT NOT NULL DEFAULT '',
  user_ref_id TEXT NOT NULL DEFAULT '',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_collab_participants_session ON collaboration_participants(session_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_collab_participants_identity ON collaboration_participants(tenant_id, identity);

CREATE TABLE IF NOT EXISTS collaboration_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  sender_identity TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'video', 'file', 'system')),
  body TEXT NOT NULL DEFAULT '',
  original_language TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collab_messages_session ON collaboration_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS collaboration_message_translations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL,
  translated_body TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collab_translations_message ON collaboration_message_translations(message_id, target_language);

CREATE TABLE IF NOT EXISTS collaboration_chat_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_topic_id TEXT NOT NULL,
  provider_status TEXT NOT NULL DEFAULT 'bound',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, session_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_collab_chat_bindings_session ON collaboration_chat_bindings(session_id, provider);

CREATE TABLE IF NOT EXISTS collaboration_policy_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL DEFAULT '',
  policy_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  matched_text_hash TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'record',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collab_policy_session ON collaboration_policy_events(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_assistance_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collaboration_session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'active', 'ended')),
  mode TEXT NOT NULL CHECK (mode IN ('web_remote_assist', 'screen_share', 'third_party_remote_tool', 'platform_remote_control', 'remote_desktop_gateway')),
  adapter_provider TEXT NOT NULL DEFAULT 'external_link',
  started_by TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_remote_sessions_business ON remote_assistance_sessions(tenant_id, business_ref_type, business_ref_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_remote_sessions_collab ON remote_assistance_sessions(collaboration_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_consent_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  remote_session_id TEXT NOT NULL REFERENCES remote_assistance_sessions(id) ON DELETE CASCADE,
  actor_identity TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'granted', 'denied', 'revoked', 'expired')),
  scopes TEXT NOT NULL DEFAULT '[]',
  expires_at TIMESTAMPTZ,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_remote_consent_session ON remote_consent_events(remote_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_tool_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  remote_session_id TEXT NOT NULL REFERENCES remote_assistance_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  launch_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_by TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_remote_tool_sessions_remote ON remote_tool_sessions(remote_session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS remote_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  remote_session_id TEXT NOT NULL REFERENCES remote_assistance_sessions(id) ON DELETE CASCADE,
  actor_identity TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_remote_audit_session ON remote_audit_events(remote_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('audio_recording', 'video_recording', 'screen_recording', 'remote_control_log', 'consent_grant', 'consent_revocation', 'chat_export', 'file_snapshot')),
  storage_url TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  retention_until TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_evidence_business ON evidence_records(tenant_id, business_ref_type, business_ref_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence_records(session_id, created_at DESC);

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'tenant_id'
      AND table_name IN (
        'collaboration_sessions',
        'collaboration_participants',
        'collaboration_messages',
        'collaboration_message_translations',
        'collaboration_chat_bindings',
        'collaboration_policy_events',
        'remote_assistance_sessions',
        'remote_consent_events',
        'remote_tool_sessions',
        'remote_audit_events',
        'evidence_records'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
         WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant())',
      r.table_name
    );
  END LOOP;
END $$;
