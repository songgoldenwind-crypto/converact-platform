PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  plan_code TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenant_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role_code TEXT NOT NULL CHECK (role_code IN ('owner', 'admin', 'operator', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant_user ON tenant_members(tenant_id, user_id, status);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code TEXT NOT NULL CHECK (role_code IN ('owner', 'admin', 'operator', 'viewer')),
  permission TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_code, permission)
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL DEFAULT 'system',
  decision_type TEXT NOT NULL CHECK (decision_type IN ('rbac', 'approval', 'quota', 'risk')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'approval_required', 'warn')),
  reason TEXT NOT NULL DEFAULT '',
  tool_id TEXT NOT NULL DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT '',
  required_permissions TEXT NOT NULL DEFAULT '[]',
  workflow_run_id TEXT,
  agent_run_id TEXT,
  tool_call_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_tenant ON policy_decisions(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS tenant_quota_limits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quota_key TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('daily', 'monthly', 'lifetime')),
  hard_limit INTEGER NOT NULL CHECK (hard_limit >= 0),
  soft_limit INTEGER NOT NULL DEFAULT 0 CHECK (soft_limit >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, quota_key, period)
);

CREATE INDEX IF NOT EXISTS idx_tenant_quota_limits ON tenant_quota_limits(tenant_id, quota_key, status);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quota_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  period_key TEXT NOT NULL,
  workflow_run_id TEXT,
  agent_run_id TEXT,
  tool_call_id TEXT,
  model_call_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_key ON usage_ledger(tenant_id, quota_key, period_key);

CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT,
  agent_run_id TEXT,
  tool_call_id TEXT,
  model_call_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trace_events_tenant_trace ON trace_events(tenant_id, trace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trace_events_workflow ON trace_events(tenant_id, workflow_run_id, created_at);

CREATE TABLE IF NOT EXISTS provider_health_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  integration_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  adapter_type TEXT NOT NULL DEFAULT '',
  adapter_status TEXT NOT NULL DEFAULT '',
  config_status TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ready', 'healthy', 'configured', 'configured_planned_adapter', 'degraded', 'planned', 'not_configured', 'reference_only')),
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_health_snapshots_tenant ON provider_health_snapshots(tenant_id, workspace_id, integration_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS tenant_provider_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  use_case TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  capability TEXT NOT NULL DEFAULT '',
  preferred_integration_ids TEXT NOT NULL DEFAULT '[]',
  blocked_integration_ids TEXT NOT NULL DEFAULT '[]',
  allow_fallback INTEGER NOT NULL DEFAULT 0 CHECK (allow_fallback IN (0, 1)),
  min_stability INTEGER,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_provider_policies_tenant ON tenant_provider_policies(tenant_id, workspace_id, status, use_case, category);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform_code TEXT NOT NULL,
  platform_name TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'Global',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  monthly_budget REAL NOT NULL DEFAULT 0,
  target_goal TEXT NOT NULL DEFAULT 'lead',
  default_score INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_channels_tenant ON channels(tenant_id, status);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  goal TEXT NOT NULL DEFAULT 'lead',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, status);

CREATE TABLE IF NOT EXISTS lead_acquisition_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  goal TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  target_customer_profile TEXT NOT NULL DEFAULT '',
  source_strategy TEXT NOT NULL DEFAULT '',
  lead_count_target INTEGER NOT NULL DEFAULT 0 CHECK (lead_count_target >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'blocked', 'archived')),
  current_stage TEXT NOT NULL DEFAULT 'goal_created' CHECK (current_stage IN (
    'goal_created',
    'lead_discovery_ready',
    'lead_scored',
    'script_ready',
    'followup_queue_ready',
    'calling_or_followup_running',
    'outcomes_collected',
    'review_ready',
    'completed',
    'blocked_needs_user_input'
  )),
  summary TEXT NOT NULL DEFAULT '',
  next_recommended_action TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lead_acquisition_runs_tenant ON lead_acquisition_runs(tenant_id, workspace_id, status, updated_at);

CREATE TABLE IF NOT EXISTS lead_acquisition_run_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (object_type IN ('lead', 'task', 'voice_call_session', 'voice_call_log')),
  object_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_acquisition_run_items_run ON lead_acquisition_run_items(tenant_id, run_id, object_type);

CREATE TABLE IF NOT EXISTS feedback_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'tighten_lead_scoring',
    'refresh_script_angles',
    'prioritize_verified_channels',
    'prepare_next_batch'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'verified', 'dismissed', 'superseded')),
  source_stage TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  metrics TEXT NOT NULL DEFAULT '{}',
  applied_by TEXT NOT NULL DEFAULT '',
  application_result TEXT NOT NULL DEFAULT '{}',
  applied_at TEXT,
  verification_result TEXT NOT NULL DEFAULT '',
  verification_metrics TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_actions_run
  ON feedback_actions(tenant_id, lead_acquisition_run_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_actions_workflow
  ON feedback_actions(tenant_id, workflow_run_id, status);

CREATE TABLE IF NOT EXISTS context_compression_traces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT NOT NULL DEFAULT '',
  lead_acquisition_run_id TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL,
  max_chars INTEGER NOT NULL DEFAULT 0,
  total_before_chars INTEGER NOT NULL DEFAULT 0,
  total_after_chars INTEGER NOT NULL DEFAULT 0,
  retained_count INTEGER NOT NULL DEFAULT 0,
  discarded_count INTEGER NOT NULL DEFAULT 0,
  retained_categories TEXT NOT NULL DEFAULT '[]',
  discarded_categories TEXT NOT NULL DEFAULT '[]',
  retained_ids TEXT NOT NULL DEFAULT '[]',
  discarded_ids TEXT NOT NULL DEFAULT '[]',
  critical_open_loops_retained INTEGER NOT NULL DEFAULT 1 CHECK (critical_open_loops_retained IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_context_compression_traces_tenant
  ON context_compression_traces(tenant_id, workflow_run_id, phase, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_compression_traces_run
  ON context_compression_traces(tenant_id, lead_acquisition_run_id, phase, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_run_particle_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_acquisition_run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
  particle_key TEXT NOT NULL CHECK (particle_key IN (
    'human_feedback_calibration_packet',
    'source_quality_benchmark',
    'mission_autoplay_guard',
    'multi_channel_followup_pack',
    'feedback_action_application_packet',
    'prospect_outreach_writeback_packet',
    'next_batch_learning_profile',
    'next_batch_seed_queue',
    'prospect_outreach_channel_adapter_receipt',
    'prospect_outreach_live_demo_acceptance',
    'public_source_discover_job',
    'writeback_confirmation_packet',
    'discovery_mission_packet',
    'public_source_adapter_packet',
    'generation_state_packet',
    'weekly_founder_brief_packet',
    'founder_decision_writeback_packet',
    'execution_state_machine_snapshot',
    'non_phone_receipt_writeback',
    'wechat_local_import_packet',
    'lead_list_import_packet',
    'ai_script_generation_job'
  )),
  particle_version TEXT NOT NULL DEFAULT 'v1',
  source_stage TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  quality_status TEXT NOT NULL DEFAULT 'info' CHECK (quality_status IN ('pass', 'warn', 'fail', 'info')),
  writeback_status TEXT NOT NULL DEFAULT 'generated' CHECK (writeback_status IN ('generated', 'applied', 'verified', 'captured')),
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  write_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, lead_acquisition_run_id, particle_key, source_stage, source_ref, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_latest
  ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, particle_key, write_order DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_run_particle_snapshots_status
  ON lead_run_particle_snapshots(tenant_id, lead_acquisition_run_id, writeback_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS source_tags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  region TEXT NOT NULL DEFAULT 'Global',
  channel_type TEXT NOT NULL,
  platform TEXT NOT NULL,
  entry_point TEXT NOT NULL,
  integration_mode TEXT NOT NULL DEFAULT 'manual',
  priority_tier TEXT NOT NULL DEFAULT 'P1' CHECK (priority_tier IN ('P0', 'P1', 'P2')),
  utm_source TEXT NOT NULL,
  utm_medium TEXT NOT NULL,
  utm_campaign TEXT NOT NULL DEFAULT 'default',
  utm_content TEXT NOT NULL DEFAULT '',
  tracking_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_source_tags_tenant_platform ON source_tags(tenant_id, platform);

CREATE TABLE IF NOT EXISTS landing_pages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_tag_id TEXT REFERENCES source_tags(id) ON DELETE SET NULL,
  lead_acquisition_run_id TEXT REFERENCES lead_acquisition_runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  headline TEXT NOT NULL,
  subheadline TEXT NOT NULL DEFAULT '',
  cta_text TEXT NOT NULL DEFAULT '提交咨询',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_landing_pages_tenant_status ON landing_pages(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_landing_pages_run ON landing_pages(lead_acquisition_run_id);

CREATE TABLE IF NOT EXISTS raw_inquiries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_tag_id TEXT REFERENCES source_tags(id) ON DELETE SET NULL,
  landing_page_id TEXT REFERENCES landing_pages(id) ON DELETE SET NULL,
  lead_acquisition_run_id TEXT REFERENCES lead_acquisition_runs(id) ON DELETE SET NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  platform_account TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'raw_inquiry' CHECK (status IN ('raw_inquiry', 'normalized', 'duplicate', 'filtered_out', 'lead_created', 'lead_scored')),
  source_payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inquiries_tenant_status ON raw_inquiries(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_inquiries_source ON raw_inquiries(source_tag_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_run ON raw_inquiries(lead_acquisition_run_id);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  platform_account TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_tenant_email ON contacts(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone ON contacts(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_platform ON contacts(tenant_id, platform_account);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  raw_inquiry_id TEXT NOT NULL REFERENCES raw_inquiries(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('captured_lead', 'qualified_lead', 'opportunity', 'nurturing', 'disqualified', 'contacted', 'booked', 'won', 'lost')),
  score_total INTEGER NOT NULL DEFAULT 0,
  score_breakdown TEXT NOT NULL DEFAULT '{}',
  score_reason TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_inquiry ON leads(raw_inquiry_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'won', 'lost')),
  value_estimate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_opportunities_tenant_status ON opportunities(tenant_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  due_at TEXT,
  completion_result TEXT NOT NULL DEFAULT '',
  completion_reason TEXT NOT NULL DEFAULT '',
  next_step_type TEXT NOT NULL DEFAULT '',
  next_step_due_at TEXT,
  script_metadata TEXT NOT NULL DEFAULT '',
  followup_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status_priority ON tasks(tenant_id, status, priority);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  source_tag_id TEXT REFERENCES source_tags(id) ON DELETE SET NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_tenant_name_time ON events(tenant_id, event_name, created_at);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_tag_id);

CREATE TABLE IF NOT EXISTS scheduled_triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'heartbeat' CHECK (trigger_type IN ('heartbeat', 'cron', 'event')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  playbook_id TEXT,
  intent TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (interval_seconds > 0),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  input TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_triggers_due ON scheduled_triggers(tenant_id, status, next_run_at);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scheduled_trigger_id TEXT NOT NULL REFERENCES scheduled_triggers(id) ON DELETE CASCADE,
  workflow_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'running', 'completed', 'failed')),
  started_at TEXT,
  finished_at TEXT,
  result TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduler_runs_trigger ON scheduler_runs(tenant_id, scheduled_trigger_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS agent_manifests (
  agent_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  manifest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE IF NOT EXISTS agent_playbooks (
  playbook_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  playbook TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_playbooks_agent ON agent_playbooks(agent_id, status);

CREATE TABLE IF NOT EXISTS tenant_agent_subscriptions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_override TEXT NOT NULL DEFAULT '{}',
  quota_override TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tenant_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  skill_id TEXT NOT NULL,
  source_skill_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  applicable_agents TEXT NOT NULL DEFAULT '[]',
  inputs TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  quality_checks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'active', 'deprecated', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_skills_tenant ON tenant_skills(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS tenant_skill_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  proposed_skill_id TEXT NOT NULL,
  source_skill_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  applicable_agents TEXT NOT NULL DEFAULT '[]',
  inputs TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  quality_checks TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'rejected', 'archived')),
  proposed_by TEXT NOT NULL DEFAULT 'system',
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_skill_candidates_tenant ON tenant_skill_candidates(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  session_key TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web_app',
  sandbox_scope TEXT NOT NULL CHECK (sandbox_scope IN ('tenant', 'workspace', 'agent', 'workflow', 'business_object', 'session')),
  dm_scope TEXT NOT NULL CHECK (dm_scope IN ('main', 'per_user', 'per_channel_user', 'per_channel_thread', 'per_business_object')),
  business_object_type TEXT NOT NULL DEFAULT 'tenant',
  business_object_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, session_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_tenant_channel ON agent_sessions(tenant_id, workspace_id, channel, status);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL DEFAULT 'api',
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'planning', 'running', 'awaiting_human_approval', 'completed', 'completed_with_concerns', 'failed', 'cancelled')),
  dag TEXT NOT NULL DEFAULT '{}',
  cost_summary TEXT NOT NULL DEFAULT '{}',
  risk_summary TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant_status ON workflow_runs(tenant_id, status);

CREATE TABLE IF NOT EXISTS workflow_dag_nodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN ('tool', 'artifact', 'condition', 'playbook')),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'ready', 'running', 'waiting_approval', 'completed',
    'failed_retryable', 'failed_terminal', 'skipped', 'cancelled'
  )),
  definition TEXT NOT NULL DEFAULT '{}',
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workflow_run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_dag_nodes_run ON workflow_dag_nodes(tenant_id, workflow_run_id, status);

CREATE TABLE IF NOT EXISTS workflow_dag_edges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'success' CHECK (condition IN ('success', 'failure', 'approval_required', 'always')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workflow_run_id, from_node_id, to_node_id, condition)
);

CREATE INDEX IF NOT EXISTS idx_workflow_dag_edges_run ON workflow_dag_edges(tenant_id, workflow_run_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  playbook_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'created', 'input_validating', 'planning', 'running', 'tool_calling', 'quality_checking',
    'artifact_committed', 'completed', 'completed_with_concerns', 'awaiting_user_input',
    'awaiting_human_approval', 'failed_retryable', 'failed_blocked', 'failed_policy_denied',
    'failed_quota_exceeded', 'failed_quality_gate', 'cancelled', 'expired'
  )),
  input TEXT NOT NULL DEFAULT '{}',
  context_pack TEXT NOT NULL DEFAULT '{}',
  output_summary TEXT NOT NULL DEFAULT '',
  error TEXT,
  cost TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_agent ON agent_runs(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_workflow ON agent_runs(workflow_run_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'blocked_pending_approval', 'policy_denied', 'running', 'success', 'failed')),
  risk_level TEXT NOT NULL,
  approval_request_id TEXT,
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  idempotency_key TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant_tool ON tool_calls(tenant_id, tool_id);

CREATE TABLE IF NOT EXISTS external_side_effects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  tool_call_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  external_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed', 'failed', 'unknown', 'compensation_required', 'compensated')),
  compensation_status TEXT NOT NULL DEFAULT 'not_required' CHECK (compensation_status IN ('not_required', 'required', 'manual_required', 'completed')),
  compensation TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_external_side_effects_run ON external_side_effects(tenant_id, workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_external_side_effects_tool_call ON external_side_effects(tenant_id, tool_call_id);

CREATE TABLE IF NOT EXISTS tenant_model_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  purpose TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_tenant_model_configs_tenant ON tenant_model_configs(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK (status IN ('created', 'running', 'success', 'failed')),
  prompt_hash TEXT NOT NULL DEFAULT '',
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  usage TEXT NOT NULL DEFAULT '{}',
  cost TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_model_calls_run ON model_calls(tenant_id, workflow_run_id, agent_run_id);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'published', 'archived', 'rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL DEFAULT '{}',
  quality_score REAL,
  parent_artifact_id TEXT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_type ON agent_artifacts(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON agent_artifacts(agent_run_id);

CREATE TABLE IF NOT EXISTS artifact_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'publish', 'archive', 'request_changes')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL CHECK (to_status IN ('draft', 'pending_approval', 'approved', 'published', 'archived', 'rejected')),
  review_notes TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_artifact_reviews_tenant ON artifact_reviews(tenant_id, artifact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  tool_call_id TEXT,
  action_type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  reason TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT NOT NULL DEFAULT 'system',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_approval_tenant_status ON approval_requests(tenant_id, status);

CREATE TABLE IF NOT EXISTS integration_secret_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  integration_id TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  env_var_name TEXT NOT NULL DEFAULT '',
  secret_fingerprint TEXT NOT NULL DEFAULT '',
  redacted_preview TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotating', 'revoked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, integration_id, secret_key)
);

CREATE INDEX IF NOT EXISTS idx_integration_secret_refs_tenant ON integration_secret_refs(tenant_id, workspace_id, integration_id, status);

CREATE TABLE IF NOT EXISTS tenant_integration_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'configured', 'disabled', 'error')),
  config TEXT NOT NULL DEFAULT '{}',
  secret_ref_ids TEXT NOT NULL DEFAULT '[]',
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'error')),
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, integration_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_integration_configs_tenant ON tenant_integration_configs(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS tenant_mcp_servers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  server_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http', 'sse', 'stdio', 'websocket')),
  endpoint TEXT NOT NULL DEFAULT '',
  toolsets TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  secret_ref_ids TEXT NOT NULL DEFAULT '[]',
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'configured', 'active', 'degraded', 'disabled', 'archived')),
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'error', 'not_configured')),
  last_checked_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_mcp_servers_tenant ON tenant_mcp_servers(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS tenant_mcp_server_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  server_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'error', 'not_configured', 'planned')),
  details TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_mcp_server_snapshots_tenant ON tenant_mcp_server_snapshots(tenant_id, workspace_id, server_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS tenant_search_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider_integration_id TEXT NOT NULL DEFAULT '',
  search_mode TEXT NOT NULL DEFAULT 'balanced' CHECK (search_mode IN ('speed', 'balanced', 'quality')),
  source_modes TEXT NOT NULL DEFAULT '["web"]',
  domain_filters TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  last_query_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_search_sessions_tenant ON tenant_search_sessions(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS tenant_notebooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  notebook_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider_integration_id TEXT NOT NULL DEFAULT '',
  source_refs TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  last_query_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, notebook_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_notebooks_tenant ON tenant_notebooks(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS tenant_search_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL DEFAULT '',
  notebook_id TEXT NOT NULL DEFAULT '',
  query_text TEXT NOT NULL,
  provider_integration_id TEXT NOT NULL DEFAULT '',
  provider_category TEXT NOT NULL DEFAULT 'ai_search',
  search_mode TEXT NOT NULL DEFAULT 'balanced' CHECK (search_mode IN ('speed', 'balanced', 'quality')),
  summary TEXT NOT NULL DEFAULT '',
  citations TEXT NOT NULL DEFAULT '[]',
  result_payload TEXT NOT NULL DEFAULT '{}',
  artifact_id TEXT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_search_runs_tenant ON tenant_search_runs(tenant_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_search_runs_session ON tenant_search_runs(tenant_id, workspace_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_search_runs_notebook ON tenant_search_runs(tenant_id, workspace_id, notebook_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  area_hint TEXT NOT NULL DEFAULT '',
  search_query TEXT NOT NULL DEFAULT '',
  provider_integration_id TEXT NOT NULL DEFAULT '',
  filters TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_sessions_tenant ON tenant_geo_sessions(tenant_id, workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_places (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL DEFAULT '',
  place_key TEXT NOT NULL,
  external_place_id TEXT NOT NULL DEFAULT '',
  provider_integration_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  business_type TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  emails TEXT NOT NULL DEFAULT '[]',
  social_profiles TEXT NOT NULL DEFAULT '[]',
  opening_hours TEXT NOT NULL DEFAULT '[]',
  rating REAL,
  review_count INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'qualified', 'rejected')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, place_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_places_tenant ON tenant_geo_places(tenant_id, workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_geo_places_session ON tenant_geo_places(tenant_id, workspace_id, session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_place_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  place_id TEXT NOT NULL REFERENCES tenant_geo_places(id) ON DELETE CASCADE,
  review_key TEXT NOT NULL,
  external_review_id TEXT NOT NULL DEFAULT '',
  rating REAL,
  author_name TEXT NOT NULL DEFAULT '',
  language_code TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, place_id, review_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_place_reviews_place ON tenant_geo_place_reviews(tenant_id, place_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_place_insights (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  place_id TEXT NOT NULL REFERENCES tenant_geo_places(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  pain_signals TEXT NOT NULL DEFAULT '[]',
  source_review_ids TEXT NOT NULL DEFAULT '[]',
  model_call_id TEXT REFERENCES model_calls(id) ON DELETE SET NULL,
  artifact_id TEXT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_place_insights_place ON tenant_geo_place_insights(tenant_id, place_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_outreach_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  place_id TEXT NOT NULL REFERENCES tenant_geo_places(id) ON DELETE CASCADE,
  insight_id TEXT REFERENCES tenant_geo_place_insights(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp', 'call_script', 'sms')),
  product_offer TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  personalization_points TEXT NOT NULL DEFAULT '[]',
  model_call_id TEXT REFERENCES model_calls(id) ON DELETE SET NULL,
  artifact_id TEXT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'approved', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_outreach_drafts_place ON tenant_geo_outreach_drafts(tenant_id, place_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_territories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  territory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  business_type TEXT NOT NULL DEFAULT '',
  priority_tier TEXT NOT NULL DEFAULT 'P1' CHECK (priority_tier IN ('P0', 'P1', 'P2', 'P3')),
  queue_route_id TEXT NOT NULL DEFAULT 'geo-followup',
  voice_route_id TEXT NOT NULL DEFAULT 'default',
  default_channel TEXT NOT NULL DEFAULT 'call_script',
  default_owner_user_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, territory_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_territories_tenant ON tenant_geo_territories(tenant_id, workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_rep_coverages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  coverage_id TEXT NOT NULL,
  territory_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'any',
  queue_route_id TEXT NOT NULL DEFAULT 'geo-followup',
  voice_route_id TEXT NOT NULL DEFAULT 'default',
  priority_weight INTEGER NOT NULL DEFAULT 100,
  daily_capacity INTEGER NOT NULL DEFAULT 0,
  active_assignments INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  notes TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, coverage_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_rep_coverages_territory ON tenant_geo_rep_coverages(tenant_id, workspace_id, territory_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_routing_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL DEFAULT 'default',
  maintenance_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (maintenance_scope IN ('tenant', 'territory')),
  interval_seconds INTEGER NOT NULL DEFAULT 3600,
  dry_run INTEGER NOT NULL DEFAULT 0,
  territory_status TEXT NOT NULL DEFAULT 'active',
  territory_include_ids TEXT NOT NULL DEFAULT '[]',
  territory_exclude_ids TEXT NOT NULL DEFAULT '[]',
  auto_bootstrap INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  paused_until TEXT,
  pause_reason TEXT NOT NULL DEFAULT '',
  last_rollout_at TEXT,
  last_rollout_snapshot TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_routing_policies_tenant ON tenant_geo_routing_policies(tenant_id, workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_routing_policy_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL DEFAULT 'default',
  override_kind TEXT NOT NULL DEFAULT 'policy_override' CHECK (override_kind IN ('policy_override', 'policy_rollback')),
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'rolled_back')),
  source_override_id TEXT REFERENCES tenant_geo_routing_policy_overrides(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  requested_patch TEXT NOT NULL DEFAULT '{}',
  before_policy TEXT NOT NULL DEFAULT '{}',
  after_policy TEXT NOT NULL DEFAULT '{}',
  before_preview TEXT NOT NULL DEFAULT '{}',
  after_preview TEXT NOT NULL DEFAULT '{}',
  diff_summary TEXT NOT NULL DEFAULT '{}',
  rollout_result TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_routing_policy_overrides_policy
  ON tenant_geo_routing_policy_overrides(tenant_id, workspace_id, policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_routing_policy_review_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL DEFAULT 'default',
  review_key TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_status TEXT NOT NULL DEFAULT 'acknowledged' CHECK (item_status IN ('open', 'acknowledged')),
  source_type TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, policy_id, review_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_routing_policy_review_states_policy
  ON tenant_geo_routing_policy_review_states(tenant_id, workspace_id, policy_id, item_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_routing_policy_action_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL DEFAULT 'default',
  review_key TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'blocked_pending_approval', 'failed')),
  executed_by TEXT NOT NULL DEFAULT 'system',
  note TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '{}',
  item_snapshot TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_routing_policy_action_history_policy
  ON tenant_geo_routing_policy_action_history(tenant_id, workspace_id, policy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_routing_policy_action_history_review
  ON tenant_geo_routing_policy_action_history(tenant_id, workspace_id, policy_id, review_key, action_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_routing_policy_batch_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL DEFAULT 'default',
  plan_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  items TEXT NOT NULL DEFAULT '[]',
  selection_summary TEXT NOT NULL DEFAULT '{}',
  preview TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_routing_policy_batch_plans_policy
  ON tenant_geo_routing_policy_batch_plans(tenant_id, workspace_id, policy_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_handoff_packets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  place_id TEXT NOT NULL REFERENCES tenant_geo_places(id) ON DELETE CASCADE,
  insight_id TEXT REFERENCES tenant_geo_place_insights(id) ON DELETE SET NULL,
  draft_id TEXT REFERENCES tenant_geo_outreach_drafts(id) ON DELETE SET NULL,
  territory_id TEXT REFERENCES tenant_geo_territories(id) ON DELETE SET NULL,
  coverage_id TEXT REFERENCES tenant_geo_rep_coverages(id) ON DELETE SET NULL,
  artifact_id TEXT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
  handoff_type TEXT NOT NULL DEFAULT 'crm_voice_followup',
  priority_tier TEXT NOT NULL DEFAULT 'P1' CHECK (priority_tier IN ('P0', 'P1', 'P2', 'P3')),
  recommended_channel TEXT NOT NULL DEFAULT 'call_script',
  recommended_next_action TEXT NOT NULL DEFAULT 'create_crm_task',
  owner_user_id TEXT,
  queue_route_id TEXT NOT NULL DEFAULT 'geo-followup',
  voice_route_id TEXT NOT NULL DEFAULT 'default',
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'queued', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_geo_handoff_packets_place ON tenant_geo_handoff_packets(tenant_id, workspace_id, place_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_geo_handoff_packets_owner ON tenant_geo_handoff_packets(tenant_id, workspace_id, owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_call_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'rustpbx',
  lead_id TEXT NOT NULL DEFAULT '',
  phone_redacted TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued', 'completed', 'failed', 'cancelled')),
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  script TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '{}',
  external_call_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_call_logs_tenant_status ON voice_call_logs(tenant_id, status);

CREATE TABLE IF NOT EXISTS voice_call_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'rustpbx',
  call_log_id TEXT REFERENCES voice_call_logs(id) ON DELETE SET NULL,
  lead_id TEXT NOT NULL DEFAULT '',
  customer_id TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  route_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'queued', 'ringing', 'active', 'completed', 'failed', 'cancelled')),
  phone_redacted TEXT NOT NULL DEFAULT '',
  rustpbx_call_id TEXT NOT NULL DEFAULT '',
  sip_endpoint TEXT NOT NULL DEFAULT '',
  webrtc_session_id TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'audio',
  livekit_room_name TEXT NOT NULL DEFAULT '',
  livekit_room_sid TEXT NOT NULL DEFAULT '',
  transfer_chain TEXT NOT NULL DEFAULT '[]',
  ai_handled INTEGER NOT NULL DEFAULT 0,
  transferred INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_tenant_status ON voice_call_sessions(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_rustpbx ON voice_call_sessions(tenant_id, rustpbx_call_id);

CREATE TABLE IF NOT EXISTS voice_agent_presence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'busy', 'wrap_up', 'away')),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 0),
  active_call_count INTEGER NOT NULL DEFAULT 0 CHECK (active_call_count >= 0),
  skills TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_agent_presence_tenant_status ON voice_agent_presence(tenant_id, workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS voice_skill_queues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  queue_id TEXT NOT NULL,
  name TEXT NOT NULL,
  skill_tags TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 50,
  max_wait_seconds INTEGER NOT NULL DEFAULT 300,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, queue_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_skill_queues_tenant_status ON voice_skill_queues(tenant_id, workspace_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS voice_queue_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  queue_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  priority INTEGER NOT NULL DEFAULT 50,
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, queue_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_queue_memberships_queue ON voice_queue_memberships(tenant_id, workspace_id, queue_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS voice_routing_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  route_id TEXT NOT NULL DEFAULT 'default',
  queue_id TEXT NOT NULL DEFAULT '',
  selected_agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'assigned', 'overflow', 'blocked')),
  payload TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_routing_snapshots_tenant ON voice_routing_snapshots(tenant_id, workspace_id, route_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_voice_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL DEFAULT 'default',
  require_outbound_consent INTEGER NOT NULL DEFAULT 0 CHECK (require_outbound_consent IN (0, 1)),
  recording_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (recording_mode IN ('disabled', 'consent_required', 'always')),
  recording_retention_days INTEGER NOT NULL DEFAULT 30,
  consent_ttl_days INTEGER NOT NULL DEFAULT 365,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_voice_policies_tenant ON tenant_voice_policies(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS voice_call_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  subject_type TEXT NOT NULL DEFAULT 'lead' CHECK (subject_type IN ('lead', 'customer', 'phone')),
  subject_id TEXT NOT NULL,
  phone_redacted TEXT NOT NULL DEFAULT '',
  consent_type TEXT NOT NULL DEFAULT 'outbound_call' CHECK (consent_type IN ('outbound_call', 'recording')),
  status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked', 'expired')),
  evidence TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  granted_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_call_consents_subject ON voice_call_consents(tenant_id, workspace_id, subject_type, subject_id, consent_type, status);

CREATE TABLE IF NOT EXISTS voice_recordings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'rustpbx',
  provider_recording_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'processing', 'archived', 'deleted', 'expired')),
  recording_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (recording_mode IN ('disabled', 'consent_required', 'always')),
  consent_id TEXT REFERENCES voice_call_consents(id) ON DELETE SET NULL,
  phone_redacted TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  recording_url TEXT NOT NULL DEFAULT '',
  retention_until TEXT,
  captured_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_recordings_call_session ON voice_recordings(tenant_id, call_session_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_recordings_retention ON voice_recordings(tenant_id, retention_until, status);

CREATE TABLE IF NOT EXISTS voice_media_storage_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL DEFAULT 'default',
  storage_provider TEXT NOT NULL DEFAULT 'opc-native-webrtc',
  archive_url_base TEXT NOT NULL DEFAULT '',
  retention_tiers TEXT NOT NULL DEFAULT '[]',
  purge_mode TEXT NOT NULL DEFAULT 'archive_before_delete' CHECK (purge_mode IN ('archive_before_delete', 'delete_only', 'manual_review')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_media_storage_policies_tenant ON voice_media_storage_policies(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS voice_runtime_deployment_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'degraded' CHECK (status IN ('ready', 'degraded', 'not_configured')),
  payload TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_runtime_deployments_tenant ON voice_runtime_deployment_snapshots(tenant_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_credential_rotations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  integration_id TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  secret_ref_id TEXT REFERENCES integration_secret_refs(id) ON DELETE SET NULL,
  previous_secret_fingerprint TEXT NOT NULL DEFAULT '',
  next_secret_fingerprint TEXT NOT NULL DEFAULT '',
  previous_env_var_name TEXT NOT NULL DEFAULT '',
  next_env_var_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'rotated' CHECK (status IN ('rotated', 'archived')),
  reason TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_credential_rotations_tenant ON voice_credential_rotations(tenant_id, workspace_id, integration_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_webrtc_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
  endpoint_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized', 'offer_created', 'answer_received', 'connected', 'ended', 'expired')),
  token_hash TEXT NOT NULL DEFAULT '',
  ice_servers TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_webrtc_sessions_tenant_status ON voice_webrtc_sessions(tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS voice_webrtc_signals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webrtc_session_id TEXT NOT NULL REFERENCES voice_webrtc_sessions(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('offer', 'answer', 'ice_candidate', 'hangup')),
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_webrtc_signals_session ON voice_webrtc_signals(tenant_id, webrtc_session_id, created_at);

CREATE TABLE IF NOT EXISTS scope_locks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  owner_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scope_locks_tenant_scope ON scope_locks(tenant_id, scope_key, status);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'workspace', 'campaign', 'lead', 'customer', 'agent', 'skill', 'workflow', 'task', 'call', 'lead_acquisition_run')),
  scope_id TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'preference', 'learning', 'skill', 'summary', 'condition', 'open_loop', 'profile')),
  content TEXT NOT NULL,
  entity_key TEXT NOT NULL DEFAULT '',
  fact_key TEXT NOT NULL DEFAULT '',
  evidence_object_type TEXT NOT NULL DEFAULT '',
  evidence_object_id TEXT NOT NULL DEFAULT '',
  source_refs TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'contradicted', 'superseded', 'archived')),
  occurred_at TEXT,
  known_at TEXT,
  valid_from TEXT,
  valid_to TEXT,
  supersedes_memory_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
  superseded_by_memory_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
  contradiction_group_id TEXT NOT NULL DEFAULT '',
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at TEXT,
  importance_score REAL NOT NULL DEFAULT 0.5,
  protected INTEGER NOT NULL DEFAULT 0,
  summary_parent_id TEXT NOT NULL DEFAULT '',
  effective_known_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(tenant_id, scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_type_status ON memory_entries(tenant_id, status, memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_entries(tenant_id, status, importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_memory_summary_parent ON memory_entries(tenant_id, summary_parent_id);

CREATE TABLE IF NOT EXISTS memory_recall_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  recalled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  query_text TEXT,
  context_run_id TEXT
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transcript_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  session_key TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system', 'approval', 'event')),
  content_type TEXT NOT NULL CHECK (content_type IN ('text', 'tool_call', 'tool_result', 'artifact_ref', 'approval_decision', 'event', 'model_result', 'context_pack')),
  content_redacted TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL DEFAULT '',
  pii_classes TEXT NOT NULL DEFAULT '[]',
  channel TEXT NOT NULL DEFAULT '',
  business_object_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_entries(tenant_id, session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_transcript_run ON transcript_entries(tenant_id, workflow_run_id, agent_run_id);

CREATE TABLE IF NOT EXISTS transcript_summaries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  source_entry_ids TEXT NOT NULL DEFAULT '[]',
  created_by_agent_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transcript_summaries_session ON transcript_summaries(tenant_id, session_key, created_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('workflow', 'agent', 'tool', 'artifact', 'tool_failure')),
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
  artifact_id TEXT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  state_hash TEXT NOT NULL DEFAULT '',
  recoverable INTEGER NOT NULL DEFAULT 1 CHECK (recoverable IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_workflow ON checkpoints(tenant_id, workflow_run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_checkpoints_agent ON checkpoints(tenant_id, agent_run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_checkpoints_tool ON checkpoints(tenant_id, tool_call_id, sequence);
CREATE INDEX IF NOT EXISTS idx_checkpoints_artifact ON checkpoints(tenant_id, artifact_id, sequence);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  entity_key TEXT NOT NULL DEFAULT '',
  fact_key TEXT NOT NULL DEFAULT '',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'rejected', 'stale')),
  source TEXT NOT NULL DEFAULT 'agent_proposed',
  occurred_at TEXT,
  known_at TEXT,
  valid_from TEXT,
  valid_to TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope ON memory_candidates(tenant_id, scope_type, scope_id, status);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL DEFAULT 'document',
  title TEXT NOT NULL,
  uri TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id, workspace_id, status);

CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'concept',
  summary TEXT NOT NULL DEFAULT '',
  content_markdown TEXT NOT NULL DEFAULT '',
  source_ids TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'stale', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_tenant_category ON wiki_pages(tenant_id, workspace_id, category, status);

CREATE TABLE IF NOT EXISTS wiki_page_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  from_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  to_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'related',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, workspace_id, from_page_id, to_page_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_wiki_links_from ON wiki_page_links(tenant_id, from_page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_links_to ON wiki_page_links(tenant_id, to_page_id);

CREATE TABLE IF NOT EXISTS wiki_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL CHECK (event_type IN ('ingest', 'page_upsert', 'query', 'lint', 'index_build', 'synthesis_draft', 'diff_proposal', 'contradiction_review')),
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wiki_events_tenant ON wiki_events(tenant_id, workspace_id, created_at);

CREATE TABLE IF NOT EXISTS wiki_index_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  content_markdown TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wiki_index_tenant ON wiki_index_snapshots(tenant_id, workspace_id, created_at);

CREATE TABLE IF NOT EXISTS completion_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  playbook_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'completed_with_concerns', 'blocked_missing_context', 'blocked_waiting_approval', 'failed_quality_gate', 'failed_policy', 'cancelled')),
  summary TEXT NOT NULL DEFAULT '',
  required_artifacts TEXT NOT NULL DEFAULT '[]',
  produced_artifacts TEXT NOT NULL DEFAULT '[]',
  quality_results TEXT NOT NULL DEFAULT '[]',
  concerns TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_completion_reports_run ON completion_reports(tenant_id, agent_run_id);

CREATE TABLE IF NOT EXISTS integration_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('open_source', 'mcp_server', 'skill', 'commercial_api', 'internal')),
  license TEXT NOT NULL DEFAULT '',
  maturity TEXT NOT NULL CHECK (maturity IN ('production', 'stable', 'active', 'experimental', 'research')),
  stability_score INTEGER NOT NULL DEFAULT 50,
  default_risk_level TEXT NOT NULL DEFAULT 'R1',
  deployment_modes TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  recommended_use TEXT NOT NULL DEFAULT '',
  caution_notes TEXT NOT NULL DEFAULT '',
  adapter_status TEXT NOT NULL DEFAULT 'planned' CHECK (adapter_status IN ('native', 'mcp', 'http_adapter', 'planned', 'manual_reference')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_integration_catalog_category ON integration_catalog(category, maturity);

CREATE TABLE IF NOT EXISTS tenant_integrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'enabled', 'disabled', 'error', 'archived')),
  config TEXT NOT NULL DEFAULT '{}',
  secrets_ref TEXT NOT NULL DEFAULT '',
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'down')),
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_integrations_tenant ON tenant_integrations(tenant_id, status);

-- Script variant efficacy tracking for template learning (P21)
CREATE TABLE IF NOT EXISTS script_variant_efficacy (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES lead_acquisition_runs(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  total_uses INTEGER NOT NULL DEFAULT 0 CHECK (total_uses >= 0),
  converted_count INTEGER NOT NULL DEFAULT 0 CHECK (converted_count >= 0),
  conversion_rate REAL NOT NULL DEFAULT 0,
  sample_size_note TEXT NOT NULL DEFAULT '',
  last_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_script_variant_efficacy_run ON script_variant_efficacy(tenant_id, run_id, period_start);
CREATE INDEX IF NOT EXISTS idx_script_variant_efficacy_key ON script_variant_efficacy(tenant_id, variant_key, period_start);

-- A/B Testing framework for AI vs Template comparison
CREATE TABLE IF NOT EXISTS ab_test_results (
  test_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  assignment_variant TEXT NOT NULL CHECK(assignment_variant IN ('ai_generated', 'template')),
  call_count INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, assignment_variant)
);

CREATE INDEX IF NOT EXISTS idx_ab_test_variant ON ab_test_results(assignment_variant, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_ab_test_run ON ab_test_results(run_id);

-- Prompt version tracking for performance optimization (MEDIUM TERM)
CREATE TABLE IF NOT EXISTS prompt_versions (
  version_id TEXT PRIMARY KEY,
  version_number INTEGER UNIQUE,
  version_hash TEXT UNIQUE,
  prompt_hash TEXT UNIQUE,
  system_prompt TEXT,
  user_prompt TEXT,
  prompt_text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  industry_specific TEXT,
  learning_phase TEXT CHECK(learning_phase IN ('baseline', 'optimized', 'refined')) DEFAULT 'baseline',
  dominant_style TEXT,
  recommended_source TEXT CHECK(recommended_source IN ('ai_generated', 'template', 'hybrid')),
  expected_improvement REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prompt_usage_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(version_hash) REFERENCES prompt_versions(version_hash)
);

CREATE TABLE IF NOT EXISTS prompt_version_efficacy (
  version_hash TEXT PRIMARY KEY,
  total_scripts_generated INTEGER NOT NULL DEFAULT 0,
  total_calls INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prompt_usage_run ON prompt_usage_log(run_id);
CREATE INDEX IF NOT EXISTS idx_prompt_usage_version ON prompt_usage_log(version_hash);
CREATE INDEX IF NOT EXISTS idx_prompt_efficacy_rate ON prompt_version_efficacy(conversion_rate DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_efficacy_updated ON prompt_version_efficacy(last_updated DESC);

-- Fine-tuning dataset preparation (LONG TERM research)
CREATE TABLE IF NOT EXISTS finetuning_examples (
  id TEXT PRIMARY KEY,
  script_variant_id TEXT NOT NULL,
  script_content TEXT NOT NULL,
  lead_profile TEXT NOT NULL,
  conversion_rate REAL NOT NULL,
  quality_signal TEXT NOT NULL CHECK(quality_signal IN ('excellent', 'good', 'fair', 'poor')),
  call_outcomes TEXT NOT NULL,
  route_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_finetuning_quality ON finetuning_examples(quality_signal, conversion_rate DESC);
CREATE INDEX IF NOT EXISTS idx_finetuning_created ON finetuning_examples(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finetuning_route ON finetuning_examples(route_type, conversion_rate DESC);

-- Iterative refinement tracking (LONG TERM research)
CREATE TABLE IF NOT EXISTS refinement_suggestions (
  id TEXT PRIMARY KEY,
  current_rate REAL NOT NULL,
  target_rate REAL NOT NULL,
  weak_areas TEXT NOT NULL,
  improvements TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('high', 'medium', 'low')),
  estimated_impact REAL NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refinement_priority ON refinement_suggestions(priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refinement_impact ON refinement_suggestions(estimated_impact DESC);

-- Auto-learning insights and prompt evolution (LONG TERM research)
CREATE TABLE IF NOT EXISTS learning_insights (
  id TEXT PRIMARY KEY,
  insight_type TEXT NOT NULL CHECK(insight_type IN ('opening_pattern', 'closing_pattern', 'value_prop', 'objection_handler', 'proof_element')),
  route_type TEXT NOT NULL,
  industry TEXT NOT NULL,
  pattern_snippet TEXT NOT NULL,
  frequency_in_top_10pct REAL NOT NULL,
  conversion_impact REAL NOT NULL,
  confidence_score REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prompt_evolution (
  id TEXT PRIMARY KEY,
  base_prompt_hash TEXT NOT NULL,
  learned_prompt_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  learning_phase TEXT NOT NULL,
  applied_insights TEXT NOT NULL,
  expected_improvement REAL NOT NULL,
  actual_improvement REAL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'testing', 'validated', 'rolled_back')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_learning_insights_type ON learning_insights(insight_type, confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_learning_insights_route ON learning_insights(route_type, industry);
CREATE INDEX IF NOT EXISTS idx_prompt_evolution_status ON prompt_evolution(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_evolution_improvement ON prompt_evolution(expected_improvement DESC);

-- Optimization Statistics & Monitoring (for metrics endpoints)
CREATE TABLE IF NOT EXISTS optimization_stats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  stat_type TEXT NOT NULL CHECK(stat_type IN ('cache', 'ab_test', 'cost', 'learning', 'prompt', 'token_budget', 'token_budget_warning')),
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  note TEXT,
  context_json TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_optimization_stats_tenant_type 
  ON optimization_stats(tenant_id, stat_type, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_optimization_stats_metric 
  ON optimization_stats(tenant_id, metric_name, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_optimization_stats_date 
  ON optimization_stats(DATE(recorded_at), stat_type);

-- PHASE 5B: Script Cache Layer (65-75% cost reduction)
CREATE TABLE IF NOT EXISTS script_cache (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  industry TEXT NOT NULL,
  target_profile_hash TEXT NOT NULL,
  script_content TEXT NOT NULL,
  variant_source TEXT NOT NULL CHECK(variant_source IN ('ai_generated', 'template')),
  model TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  avg_efficacy REAL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_script_cache_tenant_key 
  ON script_cache(tenant_id, cache_key, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_script_cache_industry_profile 
  ON script_cache(tenant_id, industry, target_profile_hash, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_script_cache_expiry 
  ON script_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_script_cache_efficacy 
  ON script_cache(avg_efficacy DESC);

-- PHASE 5B: Efficacy Data Externalization (Manus Pattern 3)
-- Store efficacy reference data separately for token efficiency
CREATE TABLE IF NOT EXISTS efficacy_archive (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  efficacy_data_hash TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  access_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_efficacy_archive_tenant_run 
  ON efficacy_archive(tenant_id, run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_efficacy_archive_hash 
  ON efficacy_archive(efficacy_data_hash);
CREATE INDEX IF NOT EXISTS idx_efficacy_archive_accessed 
  ON efficacy_archive(accessed_at DESC);

-- PHASE 5D: Cost analytics uses optimization_stats / script_cache only.
-- (circuit_breaker_* tables removed — see migration 008_drop_circuit_breaker.sql)

-- PHASE 6: A/B Testing Framework
-- AB Test Configuration and Results
CREATE TABLE IF NOT EXISTS ab_tests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  test_name TEXT,
  variant_a_id TEXT NOT NULL,
  variant_b_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed', 'paused')),
  p_value REAL,
  winner TEXT CHECK(winner IS NULL OR winner IN ('variant_a', 'variant_b', 'tie')),
  min_sample_size INTEGER NOT NULL DEFAULT 30,
  confidence_level REAL NOT NULL DEFAULT 0.95,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  winner_determined_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ab_tests_tenant_status
  ON ab_tests(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ab_tests_variants
  ON ab_tests(variant_a_id, variant_b_id);

-- Script Variants (for A/B Testing)
CREATE TABLE IF NOT EXISTS script_variants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  content TEXT NOT NULL,
  variant_source TEXT CHECK(variant_source IN ('ai_generated', 'template', 'user_custom')),
  source TEXT CHECK(source IN ('ai_generated', 'template', 'user_custom')),
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  style_classification TEXT CHECK(style_classification IN ('formal', 'casual', 'consultative', 'social', 'product_led', 'standard', 'aggressive', 'professional', 'neutral')),
  avg_conversion_rate REAL DEFAULT 0,
  efficacy_conversion_rate REAL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deprecated_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_script_variants_tenant_variant_source
  ON script_variants(tenant_id, variant_source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_script_variants_tenant_source
  ON script_variants(tenant_id, source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_script_variants_style
  ON script_variants(style_classification, avg_conversion_rate DESC);

-- A/B Test Outcomes (Results Recording)
CREATE TABLE IF NOT EXISTS ab_test_outcomes (
  id TEXT PRIMARY KEY,
  ab_test_id TEXT,
  test_id TEXT NOT NULL,
  run_id TEXT,
  assigned_variant TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('connected', 'converted', 'no_answer', 'rejected', 'not_converted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ab_test_id) REFERENCES ab_tests(id) ON DELETE CASCADE,
  FOREIGN KEY (test_id) REFERENCES ab_tests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ab_test_outcomes_test
  ON ab_test_outcomes(test_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ab_test_outcomes_ab_test
  ON ab_test_outcomes(ab_test_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ab_test_outcomes_outcome
  ON ab_test_outcomes(assigned_variant, outcome);

-- ============================================================
-- GEO Acquisition Intelligence Layer — Phase 1: Brand KB
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_brand_entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  entity_type TEXT NOT NULL CHECK(entity_type IN ('brand','product','service','team','credential','pricing','channel')),
  entity_name TEXT NOT NULL,
  entity_description TEXT,
  entity_metadata TEXT NOT NULL DEFAULT '{}',
  source_url TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_brand_entities_tenant ON tenant_brand_entities(tenant_id, workspace_id, entity_type);

CREATE TABLE IF NOT EXISTS tenant_brand_fact_cards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  fact_type TEXT NOT NULL CHECK(fact_type IN ('definition','data_point','comparison','how_to','case_result','credential')),
  fact_content TEXT NOT NULL,
  fact_evidence TEXT,
  source_url TEXT,
  citability_score REAL NOT NULL DEFAULT 0.5,
  verified INTEGER NOT NULL DEFAULT 0,
  entity_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_brand_fact_cards_tenant ON tenant_brand_fact_cards(tenant_id, workspace_id, fact_type, citability_score DESC);

CREATE TABLE IF NOT EXISTS tenant_brand_cases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  case_title TEXT NOT NULL,
  customer_profile TEXT,
  problem_description TEXT,
  solution_description TEXT,
  outcome_metrics TEXT NOT NULL DEFAULT '{}',
  outcome_quote TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_brand_cases_tenant ON tenant_brand_cases(tenant_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_brand_faq_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  objection_type TEXT NOT NULL DEFAULT 'other' CHECK(objection_type IN ('price','trust','competitor','timing','need','other')),
  call_outcome_source_id TEXT,
  times_asked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_brand_faq_tenant ON tenant_brand_faq_entries(tenant_id, workspace_id, objection_type, times_asked DESC);

CREATE TABLE IF NOT EXISTS tenant_brand_kb_completeness (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  entity_score REAL NOT NULL DEFAULT 0,
  fact_card_score REAL NOT NULL DEFAULT 0,
  case_score REAL NOT NULL DEFAULT 0,
  faq_score REAL NOT NULL DEFAULT 0,
  overall_score REAL NOT NULL DEFAULT 0,
  missing_items TEXT NOT NULL DEFAULT '[]',
  last_scored_at TEXT,
  UNIQUE(tenant_id, workspace_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ② GEO Content Intelligence
CREATE TABLE IF NOT EXISTS tenant_geo_intent_packs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  platform_targets TEXT NOT NULL DEFAULT '[]',
  question_clusters TEXT NOT NULL DEFAULT '[]',
  content_opportunity_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geo_intent_packs_tenant ON tenant_geo_intent_packs(tenant_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_content_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  intent_pack_id TEXT,
  content_type TEXT NOT NULL CHECK(content_type IN ('explainer','comparison','ranking','faq_expansion','how_to')),
  target_questions TEXT NOT NULL DEFAULT '[]',
  kb_source_refs TEXT NOT NULL DEFAULT '[]',
  competitor_refs TEXT NOT NULL DEFAULT '[]',
  word_count_target INTEGER NOT NULL DEFAULT 1000,
  heading_count_target INTEGER NOT NULL DEFAULT 6,
  evidence_blocks_required TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'p1' CHECK(priority IN ('p0','p1','p2')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geo_content_plans_tenant ON tenant_geo_content_plans(tenant_id, workspace_id, priority, status);

CREATE TABLE IF NOT EXISTS tenant_geo_article_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  content_plan_id TEXT,
  title TEXT NOT NULL,
  markdown_content TEXT NOT NULL DEFAULT '',
  schema_org_json TEXT NOT NULL DEFAULT '{}',
  llms_txt_entry TEXT NOT NULL DEFAULT '',
  og_meta TEXT NOT NULL DEFAULT '{}',
  geo_quality_score TEXT NOT NULL DEFAULT '{}',
  publish_status TEXT NOT NULL DEFAULT 'draft' CHECK(publish_status IN ('draft','review','approved','published')),
  geoflow_push_status TEXT,
  geoflow_article_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geo_article_drafts_tenant ON tenant_geo_article_drafts(tenant_id, workspace_id, publish_status, created_at DESC);

-- ③ GEO Visibility Monitor
CREATE TABLE IF NOT EXISTS tenant_geo_monitoring_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  task_type TEXT NOT NULL CHECK(task_type IN ('brand','industry','competitor','intent')),
  query_text TEXT NOT NULL,
  target_platforms TEXT NOT NULL DEFAULT '["deepseek","doubao","qianwen","kimi","yuanbao"]',
  sampling_count INTEGER NOT NULL DEFAULT 3,
  schedule_cron TEXT NOT NULL DEFAULT '0 0 * * 1',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geo_monitoring_tasks_tenant ON tenant_geo_monitoring_tasks(tenant_id, workspace_id, active, task_type);

CREATE TABLE IF NOT EXISTS tenant_geo_visibility_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  monitoring_task_id TEXT,
  platform TEXT NOT NULL,
  query_text TEXT NOT NULL,
  cited INTEGER NOT NULL DEFAULT 0,
  citation_position INTEGER,
  citation_excerpt TEXT,
  cited_url TEXT,
  competitor_citations TEXT NOT NULL DEFAULT '{}',
  sampled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geo_visibility_snapshots_tenant ON tenant_geo_visibility_snapshots(tenant_id, workspace_id, platform, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_geo_visibility_snapshots_cited ON tenant_geo_visibility_snapshots(tenant_id, cited, sampled_at DESC);

CREATE TABLE IF NOT EXISTS tenant_geo_fact_correction_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  snapshot_id TEXT,
  platform TEXT,
  ai_stated_fact TEXT NOT NULL,
  correct_fact_ref TEXT,
  discrepancy_type TEXT NOT NULL CHECK(discrepancy_type IN ('wrong_number','wrong_claim','outdated','missing')),
  correction_status TEXT NOT NULL DEFAULT 'pending' CHECK(correction_status IN ('pending','content_created','resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geo_fact_correction_tenant ON tenant_geo_fact_correction_queue(tenant_id, workspace_id, correction_status, created_at DESC);

-- ④ Flywheel Connector
CREATE TABLE IF NOT EXISTS tenant_geo_flywheel_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  triggered_at TEXT NOT NULL DEFAULT 'manual' CHECK(triggered_at IN ('run_end','weekly_heartbeat','monitoring_complete','manual')),
  source_ref TEXT,
  outbound_to_geo_signals TEXT NOT NULL DEFAULT '[]',
  geo_to_outbound_signals TEXT NOT NULL DEFAULT '[]',
  kb_gap_tasks TEXT NOT NULL DEFAULT '[]',
  flywheel_health_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_geo_flywheel_reviews_tenant ON tenant_geo_flywheel_reviews(tenant_id, workspace_id, created_at DESC);

-- ===== Call Center (RustPBX + LiveKit) =====

CREATE TABLE IF NOT EXISTS livekit_rooms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL UNIQUE,
  room_sid TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL CHECK (purpose IN ('ai_outbound', 'video_service', 'screen_share', 'conference', 'pstn_bridge')),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'active', 'closed')),
  call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_livekit_rooms_tenant_status ON livekit_rooms(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_livekit_rooms_call_session ON livekit_rooms(call_session_id);

CREATE TABLE IF NOT EXISTS livekit_participants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL,
  identity TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'unknown' CHECK (role IN ('agent', 'customer', 'supervisor', 'ai', 'sip', 'unknown')),
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'left')),
  metadata TEXT NOT NULL DEFAULT '{}',
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TEXT,
  UNIQUE(room_name, identity)
);
CREATE INDEX IF NOT EXISTS idx_livekit_participants_room ON livekit_participants(room_name, status, joined_at);
CREATE INDEX IF NOT EXISTS idx_livekit_participants_tenant ON livekit_participants(tenant_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS call_recordings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
  business_ref_type TEXT NOT NULL DEFAULT '',
  business_ref_id TEXT NOT NULL DEFAULT '',
  business_ref_metadata TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL CHECK (source IN ('livekit_egress', 'rustpbx_sipflow')),
  format TEXT NOT NULL CHECK (format IN ('mp4', 'webm', 'wav', 'ogg')),
  storage_url TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  file_size_bytes INTEGER,
  has_video INTEGER NOT NULL DEFAULT 0,
  recording_mode TEXT NOT NULL DEFAULT 'room_composite' CHECK (recording_mode IN ('track', 'track_composite', 'room_composite')),
  egress_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('starting', 'pending', 'recording', 'stopping', 'stopped', 'completed', 'failed', 'deleted')),
  retention_until TEXT,
  object_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (object_status IN ('unchecked', 'readable', 'missing_storage_url', 'not_found', 'forbidden', 'unsupported', 'fetch_failed', 'deleted', 'delete_failed')),
  object_checked_at TEXT,
  failure_code TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_call_recordings_session ON call_recordings(call_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_recordings_business ON call_recordings(tenant_id, business_ref_type, business_ref_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_recordings_retention ON call_recordings(tenant_id, retention_until, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_egress_id ON call_recordings(egress_id) WHERE egress_id != '';

CREATE TABLE IF NOT EXISTS livekit_egress_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  job_sequence INTEGER NOT NULL CHECK (job_sequence >= 1),
  room_name TEXT NOT NULL,
  recording_mode TEXT NOT NULL CHECK (recording_mode IN ('track', 'track_composite', 'room_composite')),
  track_id TEXT NOT NULL DEFAULT '',
  track_kind TEXT NOT NULL DEFAULT '',
  track_source TEXT NOT NULL DEFAULT '',
  audio_track_id TEXT NOT NULL DEFAULT '',
  video_track_id TEXT NOT NULL DEFAULT '',
  storage_url TEXT NOT NULL,
  egress_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'pending', 'recording', 'stopping', 'stopped', 'completed', 'failed')),
  failure_code TEXT NOT NULL DEFAULT '',
  reservation_id TEXT NOT NULL DEFAULT '',
  owner_epoch TEXT,
  duration_ms INTEGER,
  file_size_bytes INTEGER,
  object_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (object_status IN ('unchecked', 'readable', 'missing_storage_url', 'not_found', 'forbidden', 'unsupported', 'fetch_failed', 'deleted', 'delete_failed')),
  object_checked_at TEXT,
  provider_observed_at TEXT,
  provider_missing_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_missing_count >= 0),
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  reconcile_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reconcile_lease_until TEXT,
  reconcile_worker_id TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(recording_id, id),
  UNIQUE(recording_id, job_sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_egress_jobs_provider_id
  ON livekit_egress_jobs(egress_id) WHERE egress_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_egress_jobs_track
  ON livekit_egress_jobs(recording_id, track_id)
  WHERE recording_mode = 'track';
CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_recording
  ON livekit_egress_jobs(tenant_id, recording_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_active
  ON livekit_egress_jobs(tenant_id, status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_reconcile
  ON livekit_egress_jobs(tenant_id, reconcile_after, reconcile_lease_until, updated_at, id)
  WHERE status IN ('starting', 'recording', 'stopping');

CREATE TABLE IF NOT EXISTS ai_conversation_turns (
  id TEXT PRIMARY KEY,
  call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'ai', 'system', 'agent')),
  content TEXT NOT NULL,
  stt_confidence REAL,
  intent_score REAL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_conversation_turns_session ON ai_conversation_turns(call_session_id, turn_index);

CREATE TABLE IF NOT EXISTS agent_seats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'idle', 'busy', 'break')),
  skills TEXT NOT NULL DEFAULT '[]',
  current_call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
  livekit_identity TEXT NOT NULL DEFAULT '',
  rustpbx_extension TEXT NOT NULL DEFAULT '',
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_seats_tenant_status ON agent_seats(tenant_id, status, last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS outbound_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL DEFAULT '',
  phone_number TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('pstn_voice', 'video_link_sms', 'video_link_wechat')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dialing', 'connected', 'completed', 'failed', 'cancelled')),
  strategy TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  priority INTEGER NOT NULL DEFAULT 5,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  result TEXT NOT NULL DEFAULT '{}',
  call_session_id TEXT REFERENCES voice_call_sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outbound_tasks_pick ON outbound_tasks(tenant_id, status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_outbound_tasks_phone ON outbound_tasks(tenant_id, phone_number, created_at DESC);

-- ===== RustDesk Remote Desktop Gateway =====

CREATE TABLE IF NOT EXISTS rustdesk_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  rustdesk_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  runtime_status TEXT NOT NULL DEFAULT 'unknown' CHECK (runtime_status IN ('unknown', 'online', 'offline')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  last_seen_actor TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rustdesk_devices_tenant_rustdesk
  ON rustdesk_devices(tenant_id, rustdesk_id)
  WHERE deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rustdesk_devices_business_ref
  ON rustdesk_devices(tenant_id, business_ref_type, business_ref_id, created_at DESC)
  WHERE deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rustdesk_devices_runtime_status
  ON rustdesk_devices(tenant_id, runtime_status, last_seen_at DESC)
  WHERE deactivated_at IS NULL;

CREATE TABLE IF NOT EXISTS rustdesk_gateway_sessions (
  external_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  target_type TEXT NOT NULL DEFAULT 'device',
  target_id TEXT NOT NULL,
  target_display_name TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  actor_identity TEXT NOT NULL DEFAULT '',
  launch_url TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMPTZ,
  ended_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_gateway_sessions_tenant_created
  ON rustdesk_gateway_sessions(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rustdesk_gateway_events (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  event_type TEXT NOT NULL,
  actor_identity TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_gateway_events_session_time
  ON rustdesk_gateway_events(external_id, occurred_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_rustdesk_gateway_events_tenant_time
  ON rustdesk_gateway_events(tenant_id, occurred_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rustdesk_gateway_events_idempotency
  ON rustdesk_gateway_events(external_id, idempotency_key)
  WHERE idempotency_key <> '';

CREATE TABLE IF NOT EXISTS rustdesk_device_commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES rustdesk_devices(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE CASCADE,
  command_type TEXT NOT NULL DEFAULT 'disconnect_session'
    CHECK (command_type = 'disconnect_session'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
  requested_by TEXT NOT NULL,
  requested_reason TEXT NOT NULL
    CHECK (requested_reason IN ('consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended')),
  emergency_fallback_authorized BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_fallback_reason TEXT NOT NULL DEFAULT '',
  emergency_fallback_authorized_by TEXT NOT NULL DEFAULT '',
  emergency_fallback_authorized_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  claimed_by TEXT,
  claim_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  execution_method TEXT
    CHECK (execution_method IS NULL OR execution_method IN ('session_adapter', 'service_restart')),
  exit_code INTEGER,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  stdout_bytes INTEGER CHECK (stdout_bytes IS NULL OR stdout_bytes >= 0),
  stderr_bytes INTEGER CHECK (stderr_bytes IS NULL OR stderr_bytes >= 0),
  stdout_sha256 TEXT,
  stderr_sha256 TEXT,
  result_metadata TEXT NOT NULL DEFAULT '{}',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, external_id, command_type)
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_device_commands_claim
  ON rustdesk_device_commands(tenant_id, device_id, status, next_attempt_at, requested_at);

-- ===== Revision 4 SIP effect authority (SQLite/dev projection) =====
-- "Oracle" in the machine schema id means a fact arbiter, not Oracle Database.
-- PostgreSQL authority: migrations 107 (v1 base), 113 (v2 expand),
-- 115 (stale nonterminal recovery), and 116 (Native Call recovery fence).
-- All uint64 authority values stay canonical decimal TEXT in this projection.

CREATE TABLE IF NOT EXISTS ivekit_sip_effect_schema_registry (
  schema_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64),
  compatibility_slot TEXT NOT NULL CHECK (compatibility_slot IN ('N', 'N+1')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  activation_receipt_id TEXT,
  activated_at TEXT,
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    enabled = 0 OR
    (activation_receipt_id IS NOT NULL AND activated_at IS NOT NULL)
  ),
  PRIMARY KEY (schema_id, schema_version),
  UNIQUE (schema_id, schema_version, schema_hash),
  UNIQUE (schema_id, compatibility_slot)
);

CREATE TABLE IF NOT EXISTS ivekit_sip_effect_writer_registry (
  writer_identity TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  activation_receipt_id TEXT,
  activated_at TEXT,
  minimum_schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (minimum_schema_version IN (1, 2)),
  maximum_schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (
      maximum_schema_version IN (1, 2) AND
      maximum_schema_version >= minimum_schema_version
    ),
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    enabled = 0 OR
    (activation_receipt_id IS NOT NULL AND activated_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS ivekit_sip_effect_session_fences (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  protocol_session_id TEXT NOT NULL CHECK (
    length(protocol_session_id) BETWEEN 1 AND 200
  ),
  owner_epoch_high_watermark TEXT NOT NULL,
  generation_high_watermark TEXT NOT NULL,
  revision_high_watermark TEXT,
  last_recovery_request_sha256 TEXT CHECK (
    last_recovery_request_sha256 IS NULL OR
    length(last_recovery_request_sha256) = 64
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, protocol_session_id)
);

CREATE TABLE IF NOT EXISTS ivekit_sip_capability_recovery_receipts (
  recovery_request_sha256 TEXT NOT NULL CHECK (
    length(recovery_request_sha256) = 64
  ),
  tenant_id TEXT NOT NULL,
  protocol_session_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL CHECK (
    length(provider_call_id) BETWEEN 1 AND 200
  ),
  predecessor_binding_sha256 TEXT NOT NULL CHECK (
    length(predecessor_binding_sha256) = 64
  ),
  transaction_key_sha256 TEXT NOT NULL CHECK (
    length(transaction_key_sha256) = 64
  ),
  previous_owner_epoch TEXT NOT NULL,
  previous_generation TEXT NOT NULL,
  previous_revision TEXT NOT NULL,
  successor_owner_epoch TEXT NOT NULL,
  successor_generation TEXT NOT NULL,
  successor_revision TEXT NOT NULL,
  cancel_ok_effect_id TEXT NOT NULL,
  invite_terminated_effect_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('no_visible_effect', 'visible_or_ambiguous')
  ),
  successor_fence_receipt_sha256 TEXT NOT NULL CHECK (
    length(successor_fence_receipt_sha256) = 64
  ),
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, recovery_request_sha256),
  UNIQUE (
    tenant_id,
    protocol_session_id,
    successor_owner_epoch,
    successor_generation,
    successor_revision
  ),
  FOREIGN KEY (tenant_id, protocol_session_id)
    REFERENCES ivekit_sip_effect_session_fences(
      tenant_id, protocol_session_id
    ) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ivekit_sip_protocol_effects (
  protocol_effect_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  protocol_session_id TEXT NOT NULL,
  protocol_session_generation TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  command_id TEXT NOT NULL,
  adapter_identity TEXT NOT NULL,
  adapter_identity_hash TEXT NOT NULL CHECK (length(adapter_identity_hash) = 64),
  wire_bytes_hash TEXT NOT NULL CHECK (length(wire_bytes_hash) = 64),
  wire_length_bytes INTEGER NOT NULL CHECK (
    wire_length_bytes BETWEEN 1 AND 65535
  ),
  canonical_wire_bytes BLOB NOT NULL,
  route_binding TEXT NOT NULL,
  route_binding_hash TEXT NOT NULL CHECK (length(route_binding_hash) = 64),
  wire_attempt_facts TEXT NOT NULL,
  wire_attempt_facts_hash TEXT NOT NULL CHECK (
    length(wire_attempt_facts_hash) = 64
  ),
  wire_freeze_sha256 TEXT NOT NULL CHECK (length(wire_freeze_sha256) = 64),
  effect_identity_hash TEXT NOT NULL CHECK (length(effect_identity_hash) = 64),
  owner_epoch TEXT NOT NULL,
  command_sequence TEXT NOT NULL,
  schema_id TEXT NOT NULL CHECK (schema_id = 'ivekit.sip-effect-oracle'),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64),
  writer_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'durable_decision', 'send_attempted',
              'transport_accepted', 'transport_completed',
              'protocol_observed', 'failed', 'unknown') AND
    (schema_version <> 1 OR state <> 'transport_completed')
  ),
  revision TEXT NOT NULL DEFAULT '1',
  unknown_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
  last_receipt_id TEXT,
  last_receipt_hash TEXT,
  last_receipt_repair_delay_ms INTEGER CHECK (
    last_receipt_repair_delay_ms IS NULL OR
    last_receipt_repair_delay_ms BETWEEN 0 AND 86400000
  ),
  failure_code TEXT NOT NULL DEFAULT '',
  repair_due_at TEXT,
  repair_owner_id TEXT,
  repair_owner_epoch TEXT,
  repair_epoch_high_watermark TEXT NOT NULL DEFAULT '0',
  repair_claim_token TEXT CHECK (
    repair_claim_token IS NULL OR
    length(repair_claim_token) BETWEEN 1 AND 512
  ),
  repair_claim_revision TEXT,
  repair_lease_until TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK (repair_attempts BETWEEN 0 AND 8),
  repair_exhausted_at TEXT,
  repair_exhaustion_receipt_hash TEXT,
  operator_attention_required INTEGER NOT NULL DEFAULT 0
    CHECK (operator_attention_required IN (0, 1)),
  repair_compacted_at TEXT,
  retention_reference_count INTEGER NOT NULL DEFAULT 0
    CHECK (retention_reference_count >= 0),
  rollback_reference_count INTEGER NOT NULL DEFAULT 0
    CHECK (rollback_reference_count >= 0),
  audit_until TEXT NOT NULL,
  payload_retained INTEGER NOT NULL DEFAULT 1 CHECK (payload_retained IN (0, 1)),
  terminal_tombstone_id TEXT,
  terminal_tombstone_hash TEXT,
  terminal_at TEXT,
  prepared_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, protocol_effect_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    payload_retained = 0 OR length(canonical_wire_bytes) = wire_length_bytes
  ),
  CHECK (
    (
      terminal_tombstone_id IS NULL AND
      terminal_tombstone_hash IS NULL AND
      terminal_at IS NULL AND
      state NOT IN ('transport_completed', 'protocol_observed', 'failed')
    ) OR (
      terminal_tombstone_id IS NOT NULL AND
      terminal_tombstone_hash IS NOT NULL AND
      terminal_at IS NOT NULL AND
      state IN ('transport_completed', 'protocol_observed', 'failed') AND
      terminal_tombstone_id = last_receipt_id AND
      terminal_tombstone_hash = last_receipt_hash
    )
  )
);

CREATE TABLE IF NOT EXISTS ivekit_sip_effect_receipts (
  receipt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  protocol_effect_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  command_id TEXT NOT NULL,
  wire_bytes_hash TEXT NOT NULL,
  effect_identity_hash TEXT NOT NULL CHECK (length(effect_identity_hash) = 64),
  owner_epoch TEXT NOT NULL,
  command_sequence TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  level TEXT NOT NULL CHECK (
    level IN (
      'durable_decision', 'send_attempted', 'transport_accepted',
      'transport_completed', 'protocol_observed', 'failed', 'unknown'
    ) AND
    (schema_version <> 1 OR level <> 'transport_completed')
  ),
  from_state TEXT NOT NULL CHECK (
    from_state IN (
      'prepared', 'durable_decision', 'send_attempted',
      'transport_accepted', 'unknown'
    )
  ),
  failure_code TEXT NOT NULL DEFAULT '',
  repair_delay_ms INTEGER CHECK (
    repair_delay_ms IS NULL OR repair_delay_ms BETWEEN 0 AND 86400000
  ),
  observed_at TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL,
  writer_identity TEXT NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id, protocol_effect_id)
    REFERENCES ivekit_sip_protocol_effects(tenant_id, protocol_effect_id)
    ON DELETE RESTRICT,
  CHECK (
    (level = 'durable_decision' AND from_state = 'prepared') OR
    (level = 'send_attempted' AND from_state = 'durable_decision') OR
    (level = 'transport_accepted' AND from_state = 'send_attempted') OR
    (
      level = 'transport_completed' AND
      schema_version = 2 AND
      from_state = 'transport_accepted'
    ) OR
    (
      level = 'protocol_observed' AND
      from_state IN ('send_attempted', 'transport_accepted', 'unknown')
    ) OR
    (
      level = 'failed' AND
      from_state IN (
        'prepared', 'durable_decision', 'send_attempted',
        'transport_accepted', 'unknown'
      )
    ) OR
    (
      level = 'unknown' AND
      from_state IN ('send_attempted', 'transport_accepted', 'unknown')
    )
  )
);

CREATE TABLE IF NOT EXISTS ivekit_sip_durable_boundaries (
  boundary_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  boundary_kind TEXT NOT NULL CHECK (
    boundary_kind IN ('call_admission', 'media_generation', 'bridge_head', 'recording')
  ),
  decision_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  facts_hash TEXT NOT NULL,
  boundary_hash TEXT NOT NULL,
  owner_epoch TEXT NOT NULL,
  command_sequence TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL,
  writer_identity TEXT NOT NULL,
  PRIMARY KEY (tenant_id, boundary_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ivekit_sip_durable_boundary_facts (
  tenant_id TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision TEXT NOT NULL,
  fact_hash TEXT NOT NULL,
  fact_payload TEXT NOT NULL CHECK (
    json_valid(fact_payload) AND
    json_type(fact_payload) = 'object' AND
    length(CAST(fact_payload AS BLOB)) <= 65536
  ),
  created_at TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL,
  writer_identity TEXT NOT NULL,
  PRIMARY KEY (tenant_id, boundary_id, fact_type),
  UNIQUE (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id, boundary_id)
    REFERENCES ivekit_sip_durable_boundaries(tenant_id, boundary_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_repair_due
  ON ivekit_sip_protocol_effects(
    tenant_id, repair_due_at, repair_epoch_high_watermark, protocol_effect_id
  )
  WHERE state = 'unknown' AND operator_attention_required = 0;

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_stale_nonterminal
  ON ivekit_sip_protocol_effects(
    tenant_id,
    protocol_session_id,
    protocol_session_generation,
    updated_at,
    protocol_effect_id
  )
  WHERE state IN ('send_attempted', 'transport_accepted');

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_operator_attention
  ON ivekit_sip_protocol_effects(
    tenant_id, repair_exhausted_at, protocol_effect_id
  )
  WHERE operator_attention_required = 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_sip_effect_active_repair_token
  ON ivekit_sip_protocol_effects(tenant_id, repair_claim_token)
  WHERE repair_claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_terminal_retention
  ON ivekit_sip_protocol_effects(tenant_id, audit_until, protocol_effect_id)
  WHERE terminal_at IS NOT NULL AND payload_retained = 1;

-- ===== Converact AI outbound (Rust/PostgreSQL authority; SQLite development mirror) =====

CREATE TABLE IF NOT EXISTS converact_agent_releases (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('published', 'retired')),
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  components TEXT NOT NULL CHECK (json_valid(components) AND json_type(components) = 'object'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS converact_outbound_dial_policy_revisions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  caller_id TEXT,
  timeout_secs INTEGER NOT NULL CHECK (timeout_secs BETWEEN 1 AND 120),
  trunk TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, content_hash)
);

CREATE TABLE IF NOT EXISTS converact_outbound_campaigns (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  audience_id TEXT NOT NULL,
  dial_policy_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'scheduled', 'running', 'paused', 'draining',
    'completed', 'cancelled', 'archived'
  )),
  schedule TEXT NOT NULL CHECK (json_valid(schedule) AND json_type(schedule) = 'object'),
  active_attempts INTEGER NOT NULL DEFAULT 0 CHECK (active_attempts >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, dial_policy_revision)
    REFERENCES converact_outbound_dial_policy_revisions(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_outbound_campaign_contacts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  external_contact_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  recording_mode TEXT NOT NULL CHECK (
    recording_mode IN ('disabled', 'always', 'after_disclosure', 'on_demand')
  ),
  retention_until TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'active', 'completed', 'suppressed', 'cancelled')
  ),
  scheduled_for TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, campaign_id, external_contact_id),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES converact_outbound_campaigns(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS converact_outbound_call_attempts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_contact_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  previous_attempt_id TEXT,
  interaction_id TEXT NOT NULL,
  call_id TEXT,
  channel_agent_session_id TEXT,
  agent_release_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  compliance_reason TEXT,
  consent_id TEXT NOT NULL,
  recording_mode TEXT NOT NULL CHECK (
    recording_mode IN ('disabled', 'always', 'after_disclosure', 'on_demand')
  ),
  retention_until TEXT NOT NULL,
  dial_policy_revision TEXT,
  dial_policy_content_hash TEXT CHECK (
    dial_policy_content_hash IS NULL OR length(dial_policy_content_hash) = 64
  ),
  dial_destination TEXT,
  dial_caller_id TEXT,
  dial_timeout_secs INTEGER CHECK (dial_timeout_secs BETWEEN 1 AND 120),
  dial_trunk TEXT,
  disclosure_completed INTEGER NOT NULL DEFAULT 0 CHECK (
    disclosure_completed IN (0, 1)
  ),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '' CHECK (
    lease_token_hash = '' OR length(lease_token_hash) = 64
  ),
  lease_expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  scheduled_for TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  terminal_at TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, campaign_contact_id, attempt_number),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES converact_outbound_campaigns(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, campaign_contact_id)
    REFERENCES converact_outbound_campaign_contacts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, previous_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, dial_policy_revision, dial_policy_content_hash)
    REFERENCES converact_outbound_dial_policy_revisions(tenant_id, id, content_hash)
    ON DELETE RESTRICT,
  CHECK (
    (dial_policy_revision IS NULL AND dial_policy_content_hash IS NULL AND dial_destination IS NULL AND
      dial_caller_id IS NULL AND dial_timeout_secs IS NULL AND dial_trunk IS NULL) OR
    (dial_policy_revision IS NOT NULL AND dial_policy_content_hash IS NOT NULL AND
      dial_destination IS NOT NULL AND
      dial_timeout_secs BETWEEN 1 AND 120)
  ),
  CHECK (
    (state IN ('conversing', 'handoff_pending', 'human_active', 'ai_resuming', 'finalizing', 'completed') AND disclosure_completed = 1) OR
    (state IN (
      'planned', 'claimed', 'compliance_approved', 'compliance_blocked',
      'agent_capacity_reserved', 'dialing', 'ringing', 'answered', 'agent_connecting',
      'busy', 'no_answer', 'rejected', 'failed_before_answer'
    ) AND disclosure_completed = 0) OR
    state IN ('disclosure_pending', 'failed_after_answer', 'cancelled', 'outcome_unknown', 'reconcile_required')
  )
);

CREATE TABLE IF NOT EXISTS converact_outbound_attempt_events (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, call_attempt_id, idempotency_key),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_outbound_admin_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (command_kind IN (
    'publish_agent', 'create_campaign', 'import_contacts', 'transition_campaign'
  )),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('agent_release', 'campaign')),
  resource_id TEXT NOT NULL,
  result_state TEXT NOT NULL,
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  result_count INTEGER NOT NULL CHECK (result_count BETWEEN 0 AND 500),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_converact_outbound_attempt_claim
  ON converact_outbound_call_attempts (tenant_id, scheduled_for, id)
  WHERE state = 'planned';

CREATE INDEX IF NOT EXISTS idx_converact_outbound_attempt_events_order
  ON converact_outbound_attempt_events (
    tenant_id, call_attempt_id, execution_generation, occurred_at, event_id
  );

-- ===== Converact Tool Action authority (SQLite development mirror) =====

CREATE TABLE IF NOT EXISTS converact_tool_actions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  agent_release_id TEXT NOT NULL,
  tool_revision_id TEXT NOT NULL,
  tool_schema_hash TEXT NOT NULL CHECK (length(tool_schema_hash) = 64),
  arguments_hash TEXT NOT NULL CHECK (length(arguments_hash) = 64),
  proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
  arguments TEXT NOT NULL CHECK (json_valid(arguments)),
  effect_class TEXT NOT NULL CHECK (effect_class IN ('query', 'mutation')),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'high')),
  action_capability TEXT NOT NULL,
  policy_decision TEXT NOT NULL CHECK (
    policy_decision IN ('allowed', 'approval_required')
  ),
  approval_id TEXT,
  approval_expires_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'state_observed')),
  resolution TEXT CHECK (resolution IN ('applied', 'not_applied')),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 255
  ),
  accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  state_observed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, tool_call_id),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'reconcile_required' AND last_error_code IS NOT NULL) OR
    (state <> 'reconcile_required' AND last_error_code IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS converact_tool_action_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  stage TEXT NOT NULL CHECK (stage IN ('accepted', 'completed', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  resolution TEXT CHECK (resolution IN ('applied', 'not_applied')),
  result_hash TEXT,
  result_payload TEXT CHECK (result_payload IS NULL OR json_valid(result_payload)),
  failure_code TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, tool_call_id, stage),
  FOREIGN KEY (tenant_id, tool_call_id)
    REFERENCES converact_tool_actions(tenant_id, tool_call_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_tool_action_outbox (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  state_observed_receipt_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'published', 'dead_letter')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, tool_call_id),
  FOREIGN KEY (tenant_id, tool_call_id)
    REFERENCES converact_tool_actions(tenant_id, tool_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, state_observed_receipt_id)
    REFERENCES converact_tool_action_receipts(tenant_id, receipt_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_converact_tool_action_reconcile_claim
  ON converact_tool_actions (tenant_id, accepted_at, tool_call_id)
  WHERE state = 'accepted';

CREATE INDEX IF NOT EXISTS idx_converact_tool_action_outbox_claim
  ON converact_tool_action_outbox (tenant_id, available_at, outbox_id)
  WHERE state = 'pending';

-- ===== Converact AI/Human Handoff authority (SQLite development mirror) =====

CREATE TABLE IF NOT EXISTS converact_agent_handoff_context_packets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  context_packet_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  source_execution_generation INTEGER NOT NULL CHECK (source_execution_generation > 0),
  context_revision INTEGER NOT NULL CHECK (context_revision > 0),
  context_packet_digest TEXT NOT NULL CHECK (length(context_packet_digest) = 64),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, context_packet_id),
  UNIQUE (tenant_id, interaction_id, context_revision),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_agent_handoffs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handoff_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  context_packet_id TEXT NOT NULL,
  context_packet_digest TEXT NOT NULL CHECK (length(context_packet_digest) = 64),
  target TEXT NOT NULL CHECK (json_valid(target) AND json_type(target) = 'object'),
  state TEXT NOT NULL CHECK (state IN (
    'requested', 'prepared', 'human_leg_dialing', 'human_leg_answered',
    'committed', 'human_active', 'ai_resume_preparing', 'ai_resumed',
    'aborted', 'reconcile_required'
  )),
  reconcile_from TEXT,
  control_owner TEXT NOT NULL CHECK (control_owner IN ('ai', 'human')),
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_ai_session_id TEXT NOT NULL,
  current_ai_session_id TEXT NOT NULL,
  human_leg_id TEXT,
  terminal_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, handoff_id),
  FOREIGN KEY (tenant_id, context_packet_id)
    REFERENCES converact_agent_handoff_context_packets(tenant_id, context_packet_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_converact_agent_handoff_active_interaction
  ON converact_agent_handoffs (tenant_id, interaction_id)
  WHERE state NOT IN ('ai_resumed', 'aborted');

CREATE TABLE IF NOT EXISTS converact_agent_handoff_commands (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  command_state TEXT NOT NULL CHECK (command_state IN ('prepared', 'state_observed')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('applied', 'not_applied')),
  failure_code TEXT,
  target_revision INTEGER,
  target_generation INTEGER,
  target_state TEXT,
  target_owner TEXT,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  prepared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state_observed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, command_id),
  FOREIGN KEY (tenant_id, handoff_id)
    REFERENCES converact_agent_handoffs(tenant_id, handoff_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_agent_handoff_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('prepared', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('applied', 'not_applied')),
  failure_code TEXT,
  observed_revision INTEGER NOT NULL CHECK (observed_revision > 0),
  observed_generation INTEGER NOT NULL CHECK (observed_generation > 0),
  observed_state TEXT NOT NULL,
  observed_owner TEXT NOT NULL CHECK (observed_owner IN ('ai', 'human')),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, command_id, stage),
  FOREIGN KEY (tenant_id, command_id)
    REFERENCES converact_agent_handoff_commands(tenant_id, command_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, handoff_id)
    REFERENCES converact_agent_handoffs(tenant_id, handoff_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_converact_agent_handoff_applied_revision
  ON converact_agent_handoff_commands (tenant_id, handoff_id, target_revision)
  WHERE resolution = 'applied';

CREATE INDEX IF NOT EXISTS idx_converact_agent_handoff_reconcile_claim
  ON converact_agent_handoff_commands (tenant_id, prepared_at, command_id)
  WHERE command_state = 'prepared';

CREATE TABLE IF NOT EXISTS converact_conversation_transcript_segments (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  segment_sequence INTEGER NOT NULL CHECK (segment_sequence > 0),
  speaker TEXT NOT NULL,
  language TEXT NOT NULL,
  transcript_text TEXT NOT NULL,
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  end_offset_ms INTEGER NOT NULL CHECK (end_offset_ms >= start_offset_ms),
  observed_at TEXT NOT NULL,
  retention_policy_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, segment_id),
  UNIQUE (tenant_id, interaction_id, source_event_id),
  UNIQUE (tenant_id, interaction_id, execution_generation, segment_sequence)
);

CREATE TABLE IF NOT EXISTS converact_conversation_snapshots (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision > 0),
  transcript_snapshot_digest TEXT NOT NULL CHECK (length(transcript_snapshot_digest) = 64),
  segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
  max_execution_generation INTEGER NOT NULL CHECK (max_execution_generation > 0),
  call_terminal_observed INTEGER NOT NULL,
  agent_terminal_observed INTEGER NOT NULL,
  transcript_terminal_observed INTEGER NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  frozen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, snapshot_id),
  UNIQUE (tenant_id, interaction_id, snapshot_revision)
);

CREATE TABLE IF NOT EXISTS converact_conversation_results (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  outcome_schema_revision_id TEXT NOT NULL,
  transcript_snapshot_digest TEXT NOT NULL CHECK (length(transcript_snapshot_digest) = 64),
  summary_artifact_ref TEXT NOT NULL,
  intent_code TEXT NOT NULL,
  disposition_code TEXT NOT NULL,
  outcome_code TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  attributes TEXT NOT NULL CHECK (json_valid(attributes) AND json_type(attributes) = 'object'),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, result_id),
  UNIQUE (tenant_id, interaction_id, result_revision)
);

CREATE TABLE IF NOT EXISTS converact_conversation_evaluations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  evaluator_release_id TEXT NOT NULL,
  evaluation_rubric_revision_id TEXT NOT NULL,
  dimension_scores TEXT NOT NULL CHECK (json_valid(dimension_scores)),
  evidence_segment_ids TEXT NOT NULL CHECK (json_valid(evidence_segment_ids)),
  violation_codes TEXT NOT NULL CHECK (json_valid(violation_codes)),
  overall_score_bps INTEGER NOT NULL CHECK (overall_score_bps BETWEEN 0 AND 10000),
  quality_grade TEXT NOT NULL CHECK (quality_grade IN ('pass', 'warn', 'fail')),
  bad_case_reasons TEXT NOT NULL CHECK (json_valid(bad_case_reasons)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, evaluation_id),
  UNIQUE (tenant_id, result_id, evaluation_rubric_revision_id)
);

CREATE TABLE IF NOT EXISTS converact_conversation_bad_cases (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bad_case_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL,
  bad_case_reasons TEXT NOT NULL CHECK (json_valid(bad_case_reasons)),
  review_state TEXT NOT NULL CHECK (review_state IN ('pending', 'reviewed', 'dismissed')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, bad_case_id),
  UNIQUE (tenant_id, evaluation_id)
);

CREATE TABLE IF NOT EXISTS converact_conversation_projection_commands (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  expected_result_revision INTEGER,
  expected_execution_generation INTEGER NOT NULL,
  command_state TEXT NOT NULL CHECK (command_state IN ('prepared', 'state_observed')),
  resolution TEXT,
  failure_code TEXT,
  observed_entity_id TEXT,
  observed_payload_hash TEXT,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  prepared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state_observed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, command_id)
);

CREATE TABLE IF NOT EXISTS converact_conversation_projection_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('prepared', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  resolution TEXT,
  failure_code TEXT,
  observed_entity_id TEXT,
  observed_payload_hash TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, command_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_converact_conversation_transcript_order
  ON converact_conversation_transcript_segments (
    tenant_id, interaction_id, execution_generation, segment_sequence
  );
CREATE INDEX IF NOT EXISTS idx_converact_conversation_bad_case_queue
  ON converact_conversation_bad_cases (tenant_id, review_state, created_at, bad_case_id);
CREATE INDEX IF NOT EXISTS idx_converact_conversation_projection_claim
  ON converact_conversation_projection_commands (tenant_id, prepared_at, command_id)
  WHERE command_state = 'prepared';

-- ===== Converact durable post-call finalization (SQLite development mirror) =====

CREATE TABLE IF NOT EXISTS converact_post_call_finalization_jobs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  retention_policy_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'reconcile_required', 'completed')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('projected', 'incomplete')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  enqueued_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, call_attempt_id),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_post_call_finalization_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('enqueued', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('projected', 'incomplete')),
  observed_revision INTEGER NOT NULL CHECK (observed_revision > 0),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, job_id, stage),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES converact_post_call_finalization_jobs(tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_converact_post_call_finalization_claim
  ON converact_post_call_finalization_jobs (tenant_id, enqueued_at, job_id)
  WHERE state IN ('pending', 'claimed', 'reconcile_required');

-- ===== Converact durable conversation understanding (SQLite development mirror) =====

CREATE TABLE IF NOT EXISTS converact_conversation_understanding_records (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN (
    'intent_observation', 'emotion_observation', 'emotion_fusion',
    'customer_state_snapshot', 'dialogue_recommendation'
  )),
  domain TEXT NOT NULL CHECK (domain IN ('intent', 'emotion', 'customer_state', 'dialogue')),
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  call_id TEXT,
  agent_release_id TEXT NOT NULL,
  channel_agent_session_id TEXT,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  observed_at TEXT NOT NULL,
  retention_policy_ref TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, record_id),
  UNIQUE (
    tenant_id, record_id, domain, record_kind, interaction_id, call_attempt_id,
    execution_generation, turn_index, observed_at, payload_hash
  ),
  CHECK (
    (record_kind = 'intent_observation' AND domain = 'intent') OR
    (record_kind IN ('emotion_observation', 'emotion_fusion') AND domain = 'emotion') OR
    (record_kind = 'customer_state_snapshot' AND domain = 'customer_state') OR
    (record_kind = 'dialogue_recommendation' AND domain = 'dialogue')
  )
);

CREATE TABLE IF NOT EXISTS converact_conversation_understanding_heads (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  domain TEXT NOT NULL CHECK (domain IN ('intent', 'emotion', 'customer_state', 'dialogue')),
  head_revision INTEGER NOT NULL CHECK (head_revision > 0),
  record_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN (
    'intent_observation', 'emotion_fusion', 'customer_state_snapshot', 'dialogue_recommendation'
  )),
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  observed_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, interaction_id, call_attempt_id, execution_generation, domain),
  UNIQUE (tenant_id, record_id),
  FOREIGN KEY (
    tenant_id, record_id, domain, record_kind, interaction_id, call_attempt_id,
    execution_generation, turn_index, observed_at, payload_hash
  ) REFERENCES converact_conversation_understanding_records (
    tenant_id, record_id, domain, record_kind, interaction_id, call_attempt_id,
    execution_generation, turn_index, observed_at, payload_hash
  ) ON DELETE RESTRICT,
  CHECK (
    (record_kind = 'intent_observation' AND domain = 'intent') OR
    (record_kind = 'emotion_fusion' AND domain = 'emotion') OR
    (record_kind = 'customer_state_snapshot' AND domain = 'customer_state') OR
    (record_kind = 'dialogue_recommendation' AND domain = 'dialogue')
  )
);

CREATE INDEX IF NOT EXISTS idx_converact_understanding_attempt_records
  ON converact_conversation_understanding_records (
    tenant_id, call_attempt_id, execution_generation, domain, turn_index, observed_at
  );

CREATE INDEX IF NOT EXISTS idx_converact_understanding_attempt_heads
  ON converact_conversation_understanding_heads (
    tenant_id, call_attempt_id, execution_generation, domain
  );
