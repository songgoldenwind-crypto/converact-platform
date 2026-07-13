export interface IveKitIvrFlowGraph {
  version: number; entryNodeId: string;
  nodes: Array<{ id: string; type: string; name: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }>;
  variables: Array<{ name: string; defaultValue?: unknown }>;
  [key: string]: unknown;
}
export interface IveKitIvrFlow {
  id: string; tenant_id: string; name: string; status: 'draft' | 'published' | 'archived';
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
