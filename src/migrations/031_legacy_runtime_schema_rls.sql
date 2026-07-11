-- Move the remaining constructor-created tenant tables under PostgreSQL
-- migration ownership before runtime DDL is disabled for the non-owner role.

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan_code TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_tenant ON billing_subscriptions(tenant_id);

CREATE TABLE IF NOT EXISTS billing_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  ai_minutes_used REAL NOT NULL DEFAULT 0,
  tool_calls_used INTEGER NOT NULL DEFAULT 0,
  seats_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_period ON billing_usage(tenant_id, period);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  document_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  chunks TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'indexed',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kd_kb ON knowledge_documents(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kd_tenant ON knowledge_documents(tenant_id);

CREATE TABLE IF NOT EXISTS qm_evaluations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id TEXT NOT NULL,
  evaluator TEXT NOT NULL DEFAULT 'llm',
  scores TEXT NOT NULL DEFAULT '{}',
  violations TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  overall_score REAL NOT NULL DEFAULT 0,
  evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_qm_evaluations_tenant ON qm_evaluations(tenant_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_qm_evaluations_session ON qm_evaluations(call_session_id);

CREATE TABLE IF NOT EXISTS wfm_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_seat_id TEXT NOT NULL,
  date TEXT NOT NULL,
  shift_start TEXT NOT NULL,
  shift_end TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wfm_tenant_date ON wfm_schedules(tenant_id, date);

CREATE TABLE IF NOT EXISTS wfm_forecasts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  predicted_volume REAL NOT NULL DEFAULT 0,
  actual_volume REAL,
  model_version TEXT NOT NULL DEFAULT 'ses_v1',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_forecast_tenant_date ON wfm_forecasts(tenant_id, date);

CREATE TABLE IF NOT EXISTS white_label_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  brand_name TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  primary_color TEXT NOT NULL DEFAULT '#3b82f6',
  custom_domain TEXT UNIQUE,
  email_from_name TEXT NOT NULL DEFAULT '',
  email_from_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'billing_subscriptions',
    'billing_usage',
    'knowledge_bases',
    'knowledge_documents',
    'qm_evaluations',
    'wfm_forecasts',
    'wfm_schedules',
    'white_label_configs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
       WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant())',
      table_name
    );
  END LOOP;
END
$$;
