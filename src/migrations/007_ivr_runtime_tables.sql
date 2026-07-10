-- IVR runtime tables (sessions, settings, audio library, flow history).
-- SQLite tests: migrateIvrRuntimeTables() in db-migrations/ivr-runtime-schema.ts

CREATE TABLE IF NOT EXISTS ivr_sessions (
  call_session_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  step_count INTEGER NOT NULL DEFAULT 0,
  terminated INTEGER NOT NULL DEFAULT 0,
  last_action_json TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ivr_sessions_tenant ON ivr_sessions(tenant_id);

CREATE TABLE IF NOT EXISTS ivr_session_steps (
  id BIGSERIAL PRIMARY KEY,
  call_session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  node_id TEXT,
  action_kind TEXT NOT NULL,
  action_json TEXT NOT NULL,
  branch_taken TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ivr_session_steps_call ON ivr_session_steps(call_session_id);

CREATE TABLE IF NOT EXISTS audio_library (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'enterprise' CHECK (scope IN ('public', 'enterprise')),
  tenant_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT,
  entry_type TEXT NOT NULL DEFAULT 'tts' CHECK (entry_type IN ('tts', 'audio_file', 'audio_var')),
  tts_text TEXT,
  tts_engine TEXT,
  audio_url TEXT,
  variable_name TEXT,
  language TEXT DEFAULT 'zh',
  duration_sec DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audio_library_scope ON audio_library(scope);
CREATE INDEX IF NOT EXISTS idx_audio_library_tenant ON audio_library(tenant_id);

CREATE TABLE IF NOT EXISTS ivr_time_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT '{}',
  holidays TEXT,
  timezone TEXT DEFAULT 'Asia/Shanghai',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ivr_region_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  regions TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ivr_group_call_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  member_seat_ids TEXT NOT NULL DEFAULT '[]',
  strategy TEXT NOT NULL DEFAULT 'simultaneous',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ivr_flow_history (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  graph TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ivr_flow_history ON ivr_flow_history(flow_id, version);
