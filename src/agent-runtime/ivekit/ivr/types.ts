export type {
  GlobalShortcut,
  IvrEdge,
  IvrFlowGraph,
  IvrNodeBase,
  IvrNodeType,
  IvrVariable
} from './graph-types.js';

import type { IvrFlowGraph } from './graph-types.js';
import type { IvrDependencyManifest } from './dependencies.js';

export type IvrSessionState = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type IvrFlowStatus = 'draft' | 'published' | 'disabled' | 'archived';
export type IvrReleaseKind = 'publish' | 'rollback';

export interface IvrFlow {
  id: string;
  tenant_id: string;
  name: string;
  status: IvrFlowStatus;
  draft_graph: IvrFlowGraph;
  draft_revision: number;
  current_published_version: number | null;
  metadata: Record<string, unknown>;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export type IvrPendingActionState =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

export interface IvrFlowVersion {
  id: string;
  tenant_id: string;
  flow_id: string;
  version: number;
  schema_version: number;
  graph: IvrFlowGraph;
  graph_hash: string;
  dependencies: IvrDependencyManifest;
  release_kind: IvrReleaseKind;
  source_version: number | null;
  publication_key: string;
  publication_payload_hash: string;
  release_metadata: Record<string, unknown>;
  published_by: string;
  published_at: string;
}

export interface IvrSession {
  id: string;
  tenant_id: string;
  call_id: string;
  flow_id: string;
  flow_version: number;
  state: IvrSessionState;
  current_node_id: string;
  context: Record<string, unknown>;
  step_count: number;
  revision: number;
  waiting_reason: string;
  termination_reason: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  provider_profile_id: string | null;
  provider_session_id: string | null;
  last_event_sequence: number;
  last_event_payload_hash: string;
  last_action_revision: number;
  last_action: Record<string, unknown>;
  provider_metadata: Record<string, unknown>;
  trace_id: string;
}

export interface IvrAction {
  kind:
    | 'play'
    | 'collect'
    | 'flush'
    | 'queue'
    | 'transfer'
    | 'record'
    | 'webhook'
    | 'knowledge'
    | 'ai'
    | 'media'
    | 'hangup'
    | 'wait';
  node_id: string;
  payload: Record<string, unknown>;
}

export interface IvrSessionStep {
  id: string;
  tenant_id: string;
  session_id: string;
  step_index: number;
  flow_id: string;
  flow_version: number;
  node_id: string;
  action: IvrAction;
  branch_taken: string;
  duration_ms: number;
  error_code: string;
  created_at: string;
}

export type IvrActionDispatchMode = 'worker' | 'provider_exchange';

export interface IvrPendingAction {
  id: string;
  tenant_id: string;
  session_id: string;
  step_index: number;
  node_id: string;
  action_kind: IvrAction['kind'];
  state: IvrPendingActionState;
  dispatch_mode: IvrActionDispatchMode;
  idempotency_key: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  provider_profile_id: string;
  provider_action_id: string;
  error_code: string;
  error_message: string;
  trace_id: string;
  reconciliation_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
