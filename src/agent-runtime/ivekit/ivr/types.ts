export type {
  GlobalShortcut,
  IvrEdge,
  IvrFlowGraph,
  IvrNodeBase,
  IvrNodeType,
  IvrVariable
} from './graph-types.js';

import type { IvrFlowGraph } from './graph-types.js';

export type IvrSessionState = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

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
  dependencies: Record<string, unknown>;
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
}

export interface IvrAction {
  kind:
    | 'play'
    | 'collect'
    | 'queue'
    | 'transfer'
    | 'record'
    | 'webhook'
    | 'media'
    | 'hangup'
    | 'wait';
  node_id: string;
  payload: Record<string, unknown>;
}
