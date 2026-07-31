export type IveKitIvrNodeType =
  | 'start' | 'play' | 'menu' | 'collect' | 'survey' | 'set_var'
  | 'condition' | 'time_condition' | 'queue' | 'http'
  | 'transfer' | 'voicemail' | 'sip' | 'disconnect' | 'flush_audio'
  | 'ai_dialogue' | 'intent' | 'knowledge_qa' | 'avatar_switch' | 'compliance'
  | 'video_play' | 'screen_share' | 'visual_menu' | 'subflow' | 'recording' | 'webhook';

export interface IveKitIvrFlowGraph {
  version: number; entryNodeId: string;
  nodes: Array<{ id: string; type: IveKitIvrNodeType; name: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }>;
  variables: Array<{ name: string; defaultValue?: unknown }>;
  [key: string]: unknown;
}
export interface IveKitIvrFlow {
  id: string; tenant_id: string; name: string; status: 'draft' | 'published' | 'disabled' | 'archived';
  draft_graph: IveKitIvrFlowGraph; draft_revision: number; current_published_version: number | null;
  metadata: Record<string, unknown>; created_by: string; updated_by: string; created_at: string; updated_at: string;
}
export interface IveKitIvrFlowVersion {
  id: string; tenant_id: string; flow_id: string; version: number; graph: IveKitIvrFlowGraph;
  graph_hash: string; release_kind: 'publish' | 'rollback'; source_version: number | null;
  published_by: string; published_at: string; [key: string]: unknown;
}
export interface IveKitIvrCompilationReport {
  normalized_graph: IveKitIvrFlowGraph; graph_hash: string; errors: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>; dependencies: Record<string, unknown>;
}
export interface IveKitIvrSession {
  id: string; tenant_id: string; call_id: string; flow_id: string; flow_version: number;
  state: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'; current_node_id: string;
  context: Record<string, unknown>; step_count: number; revision: number; [key: string]: unknown;
}
export interface IveKitIvrAction { kind: string; node_id: string; payload: Record<string, unknown>; }
export interface IveKitIvrSessionResult {
  session: IveKitIvrSession; action: IveKitIvrAction | null; replayed: boolean; steps_appended: number;
}
export interface IveKitIvrSimulationResult {
  status: 'completed' | 'failed' | 'waiting_for_script'; session: IveKitIvrSession;
  action: IveKitIvrAction | null; steps: Array<Record<string, unknown>>; trace: Array<Record<string, unknown>>;
  elapsed_ms: number; remaining_script_entries: number;
}

export interface IveKitIvrResourceBase {
  id: string; tenant_id: string; name: string; revision: number;
  created_at: string; updated_at: string;
}

export interface IveKitIvrAudioAsset extends IveKitIvrResourceBase {
  kind: 'audio_asset'; source_kind: 'audio_file' | 'tts' | 'variable';
  object_ref: string; tts_text: string; tts_profile_id: string; variable_name: string;
  language: string; content_type: string; checksum: string; duration_ms: number | null;
  visibility: 'tenant' | 'flow'; status: 'active' | 'processing' | 'failed' | 'archived';
  metadata: Record<string, unknown>; created_by: string; updated_by: string;
}

export interface IveKitIvrTimeGroup extends IveKitIvrResourceBase {
  kind: 'time_group'; timezone: string; schedule: Record<string, unknown>; holidays: unknown[];
  status: 'active' | 'disabled' | 'archived';
}

export interface IveKitIvrRegionGroup extends IveKitIvrResourceBase {
  kind: 'region_group'; regions: string[]; match_mode: 'prefix' | 'exact' | 'regex';
  status: 'active' | 'disabled' | 'archived';
}

export interface IveKitIvrRingGroup extends IveKitIvrResourceBase {
  kind: 'ring_group'; member_identities: string[];
  strategy: 'simultaneous' | 'sequential' | 'least_busy' | 'random';
  ring_timeout_seconds: number; max_rounds: number; status: 'active' | 'disabled' | 'archived';
}

export interface IveKitIvrSettings {
  id: string; tenant_id: string; default_language: string; max_steps: number;
  max_subflow_depth: number; external_action_timeout_ms: number;
  validation_mode: 'warn' | 'block'; allowed_webhook_refs: string[];
  execution_policy: Record<string, unknown>; revision: number; updated_by: string;
  created_at: string; updated_at: string;
}

export type IveKitIvrCreateAudioAssetInput = Pick<IveKitIvrAudioAsset, 'name' | 'source_kind'>
  & Partial<Pick<IveKitIvrAudioAsset,
    'object_ref' | 'tts_text' | 'tts_profile_id' | 'variable_name' | 'language' | 'content_type'
    | 'checksum' | 'duration_ms' | 'visibility' | 'status' | 'metadata'>>;
export type IveKitIvrUpdateAudioAssetInput = Partial<IveKitIvrCreateAudioAssetInput>
  & { expected_revision: number };
export type IveKitIvrCreateTimeGroupInput = Pick<IveKitIvrTimeGroup, 'name'>
  & Partial<Pick<IveKitIvrTimeGroup, 'timezone' | 'schedule' | 'holidays' | 'status'>>;
export type IveKitIvrUpdateTimeGroupInput = Partial<IveKitIvrCreateTimeGroupInput>
  & { expected_revision: number };
export type IveKitIvrCreateRegionGroupInput = Pick<IveKitIvrRegionGroup, 'name'>
  & Partial<Pick<IveKitIvrRegionGroup, 'regions' | 'match_mode' | 'status'>>;
export type IveKitIvrUpdateRegionGroupInput = Partial<IveKitIvrCreateRegionGroupInput>
  & { expected_revision: number };
export type IveKitIvrCreateRingGroupInput = Pick<IveKitIvrRingGroup, 'name'>
  & Partial<Pick<IveKitIvrRingGroup,
    'member_identities' | 'strategy' | 'ring_timeout_seconds' | 'max_rounds' | 'status'>>;
export type IveKitIvrUpdateRingGroupInput = Partial<IveKitIvrCreateRingGroupInput>
  & { expected_revision: number };
export type IveKitIvrUpdateSettingsInput = Partial<Pick<IveKitIvrSettings,
  'default_language' | 'max_steps' | 'max_subflow_depth' | 'external_action_timeout_ms'
  | 'validation_mode' | 'allowed_webhook_refs' | 'execution_policy'>> & { expected_revision: number };
