export type ConveractFabricIvrNodeType =
  | 'start' | 'play' | 'menu' | 'collect' | 'survey' | 'set_var'
  | 'condition' | 'time_condition' | 'queue' | 'http'
  | 'transfer' | 'voicemail' | 'sip' | 'disconnect' | 'flush_audio'
  | 'ai_dialogue' | 'intent' | 'knowledge_qa' | 'avatar_switch' | 'compliance'
  | 'video_play' | 'screen_share' | 'visual_menu' | 'subflow' | 'recording' | 'webhook';

export interface ConveractFabricIvrFlowGraph {
  version: number; entryNodeId: string;
  nodes: Array<{ id: string; type: ConveractFabricIvrNodeType; name: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }>;
  variables: Array<{ name: string; defaultValue?: unknown }>;
  [key: string]: unknown;
}
export interface ConveractFabricIvrFlow {
  id: string; tenant_id: string; name: string; status: 'draft' | 'published' | 'disabled' | 'archived';
  draft_graph: ConveractFabricIvrFlowGraph; draft_revision: number; current_published_version: number | null;
  metadata: Record<string, unknown>; created_by: string; updated_by: string; created_at: string; updated_at: string;
}
export interface ConveractFabricIvrFlowVersion {
  id: string; tenant_id: string; flow_id: string; version: number; graph: ConveractFabricIvrFlowGraph;
  graph_hash: string; release_kind: 'publish' | 'rollback'; source_version: number | null;
  published_by: string; published_at: string; [key: string]: unknown;
}
export interface ConveractFabricIvrCompilationReport {
  normalized_graph: ConveractFabricIvrFlowGraph; graph_hash: string; errors: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>; dependencies: Record<string, unknown>;
}
export interface ConveractFabricIvrSession {
  id: string; tenant_id: string; call_id: string; flow_id: string; flow_version: number;
  state: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'; current_node_id: string;
  context: Record<string, unknown>; step_count: number; revision: number; [key: string]: unknown;
}
export interface ConveractFabricIvrAction { kind: string; node_id: string; payload: Record<string, unknown>; }
export interface ConveractFabricIvrSessionResult {
  session: ConveractFabricIvrSession; action: ConveractFabricIvrAction | null; replayed: boolean; steps_appended: number;
}
export interface ConveractFabricIvrSimulationResult {
  status: 'completed' | 'failed' | 'waiting_for_script'; session: ConveractFabricIvrSession;
  action: ConveractFabricIvrAction | null; steps: Array<Record<string, unknown>>; trace: Array<Record<string, unknown>>;
  elapsed_ms: number; remaining_script_entries: number;
}

export interface ConveractFabricIvrResourceBase {
  id: string; tenant_id: string; name: string; revision: number;
  created_at: string; updated_at: string;
}

export interface ConveractFabricIvrAudioAsset extends ConveractFabricIvrResourceBase {
  kind: 'audio_asset'; source_kind: 'audio_file' | 'tts' | 'variable';
  object_ref: string; tts_text: string; tts_profile_id: string; variable_name: string;
  language: string; content_type: string; checksum: string; duration_ms: number | null;
  visibility: 'tenant' | 'flow'; status: 'active' | 'processing' | 'failed' | 'archived';
  metadata: Record<string, unknown>; created_by: string; updated_by: string;
}

export interface ConveractFabricIvrTimeGroup extends ConveractFabricIvrResourceBase {
  kind: 'time_group'; timezone: string; schedule: Record<string, unknown>; holidays: unknown[];
  status: 'active' | 'disabled' | 'archived';
}

export interface ConveractFabricIvrRegionGroup extends ConveractFabricIvrResourceBase {
  kind: 'region_group'; regions: string[]; match_mode: 'prefix' | 'exact' | 'regex';
  status: 'active' | 'disabled' | 'archived';
}

export interface ConveractFabricIvrRingGroup extends ConveractFabricIvrResourceBase {
  kind: 'ring_group'; member_identities: string[];
  strategy: 'simultaneous' | 'sequential' | 'least_busy' | 'random';
  ring_timeout_seconds: number; max_rounds: number; status: 'active' | 'disabled' | 'archived';
}

export interface ConveractFabricIvrSettings {
  id: string; tenant_id: string; default_language: string; max_steps: number;
  max_subflow_depth: number; external_action_timeout_ms: number;
  validation_mode: 'warn' | 'block'; allowed_webhook_refs: string[];
  execution_policy: Record<string, unknown>; revision: number; updated_by: string;
  created_at: string; updated_at: string;
}

export type ConveractFabricIvrCreateAudioAssetInput = Pick<ConveractFabricIvrAudioAsset, 'name' | 'source_kind'>
  & Partial<Pick<ConveractFabricIvrAudioAsset,
    'object_ref' | 'tts_text' | 'tts_profile_id' | 'variable_name' | 'language' | 'content_type'
    | 'checksum' | 'duration_ms' | 'visibility' | 'status' | 'metadata'>>;
export type ConveractFabricIvrUpdateAudioAssetInput = Partial<ConveractFabricIvrCreateAudioAssetInput>
  & { expected_revision: number };
export type ConveractFabricIvrCreateTimeGroupInput = Pick<ConveractFabricIvrTimeGroup, 'name'>
  & Partial<Pick<ConveractFabricIvrTimeGroup, 'timezone' | 'schedule' | 'holidays' | 'status'>>;
export type ConveractFabricIvrUpdateTimeGroupInput = Partial<ConveractFabricIvrCreateTimeGroupInput>
  & { expected_revision: number };
export type ConveractFabricIvrCreateRegionGroupInput = Pick<ConveractFabricIvrRegionGroup, 'name'>
  & Partial<Pick<ConveractFabricIvrRegionGroup, 'regions' | 'match_mode' | 'status'>>;
export type ConveractFabricIvrUpdateRegionGroupInput = Partial<ConveractFabricIvrCreateRegionGroupInput>
  & { expected_revision: number };
export type ConveractFabricIvrCreateRingGroupInput = Pick<ConveractFabricIvrRingGroup, 'name'>
  & Partial<Pick<ConveractFabricIvrRingGroup,
    'member_identities' | 'strategy' | 'ring_timeout_seconds' | 'max_rounds' | 'status'>>;
export type ConveractFabricIvrUpdateRingGroupInput = Partial<ConveractFabricIvrCreateRingGroupInput>
  & { expected_revision: number };
export type ConveractFabricIvrUpdateSettingsInput = Partial<Pick<ConveractFabricIvrSettings,
  'default_language' | 'max_steps' | 'max_subflow_depth' | 'external_action_timeout_ms'
  | 'validation_mode' | 'allowed_webhook_refs' | 'execution_policy'>> & { expected_revision: number };
