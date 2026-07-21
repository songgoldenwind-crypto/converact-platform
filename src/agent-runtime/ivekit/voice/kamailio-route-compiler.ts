import type { ComponentNodeStateSnapshot } from '../placement/component-node-admission.js';
import {
  type KamailioRouteNodeState,
  type KamailioRouteSnapshotBody,
  type KamailioRouteSnapshotNode,
  validateKamailioRouteSnapshotBody
} from './kamailio-route-snapshot.js';

export interface KamailioRustPbxRouteSource {
  node_id: string;
  sip_uri: string;
  pin_set_id: number;
  priority: number;
  safe_capacity_fallback: number;
  state: ComponentNodeStateSnapshot | null;
}

export interface KamailioRoutePoolSource {
  pool_id: number;
  profile_id: string;
  capacity_dimension: string;
  nodes: KamailioRustPbxRouteSource[];
}

export interface KamailioRouteCompileInput {
  sequence: number;
  region_id: string;
  zone_id: string;
  cell_id: string;
  cell_lease_epoch: number;
  generated_at: string;
  ttl_ms: number;
  edge_replica_count: number;
  degraded_weight_factor?: number;
  pools: KamailioRoutePoolSource[];
}

export function compileKamailioRouteSnapshotBody(
  input: KamailioRouteCompileInput
): KamailioRouteSnapshotBody {
  const generatedMs = Date.parse(input.generated_at);
  if (!Number.isFinite(generatedMs) || new Date(generatedMs).toISOString() !== input.generated_at) {
    throw new Error('Kamailio route generated_at must be canonical ISO time');
  }
  if (!Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1_000 || input.ttl_ms > 300_000) {
    throw new Error('Kamailio route TTL must be between 1 and 300 seconds');
  }
  const degradedFactor = boundedFactor(input.degraded_weight_factor ?? 0.5);
  if (!Array.isArray(input.pools)) throw new Error('Kamailio route pools are required');

  const pools = [...input.pools]
    .sort((left, right) => left.pool_id - right.pool_id || left.profile_id.localeCompare(right.profile_id))
    .map((pool) => {
      if (!/^[a-z][a-z0-9_.]{2,127}$/.test(pool.capacity_dimension)) {
        throw new Error(`Kamailio route capacity dimension is invalid for pool ${pool.pool_id}`);
      }
      if (!Array.isArray(pool.nodes)) throw new Error(`Kamailio route nodes are invalid for pool ${pool.pool_id}`);
      const nodes = pool.nodes
        .map((source) => projectNode(source, pool.capacity_dimension, input, generatedMs))
        .sort((left, right) => left.node_id.localeCompare(right.node_id));
      applyRelativeWeights(nodes, degradedFactor);
      return {
        pool_id: pool.pool_id,
        profile_id: pool.profile_id,
        nodes
      };
    });

  const body: KamailioRouteSnapshotBody = {
    schema_version: '1.0.0',
    sequence: input.sequence,
    region_id: input.region_id,
    zone_id: input.zone_id,
    cell_id: input.cell_id,
    cell_lease_epoch: input.cell_lease_epoch,
    generated_at: input.generated_at,
    expires_at: new Date(generatedMs + input.ttl_ms).toISOString(),
    edge_replica_count: input.edge_replica_count,
    pools
  };
  validateKamailioRouteSnapshotBody(body);
  return body;
}

export function renderKamailioDispatcherList(
  body: KamailioRouteSnapshotBody,
  options: { accept_new_calls?: boolean } = {}
): string {
  validateKamailioRouteSnapshotBody(body);
  const newCallLines: string[] = [];
  const pinLines: string[] = [];
  const pools = [...body.pools].sort((left, right) => left.pool_id - right.pool_id);
  for (const pool of pools) {
    const nodes = [...pool.nodes].sort((left, right) => left.node_id.localeCompare(right.node_id));
    for (const node of nodes) {
      if (options.accept_new_calls !== false && isEligibleForNewCalls(node)) {
        newCallLines.push(dispatcherLine({
          set_id: pool.pool_id,
          node,
          flags: 8,
          attrs: [
            `duid=${node.node_id}`,
            `rweight=${node.routing_weight}`,
            `pinset=${node.pin_set_id}`,
            `node=${node.node_id}`
          ]
        }));
      }
      pinLines.push(dispatcherLine({
        set_id: node.pin_set_id,
        node,
        flags: node.state === 'offline' ? 9 : 8,
        attrs: [
          `duid=${node.node_id}-pin`,
          `node=${node.node_id}`
        ]
      }));
    }
  }
  const lines = [...newCallLines, ...pinLines];
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function projectNode(
  source: KamailioRustPbxRouteSource,
  dimensionName: string,
  input: KamailioRouteCompileInput,
  generatedMs: number
): KamailioRouteSnapshotNode {
  if (!source.state) {
    return {
      node_id: source.node_id,
      sip_uri: source.sip_uri,
      pin_set_id: source.pin_set_id,
      state: 'offline',
      safe_capacity: source.safe_capacity_fallback,
      used: source.safe_capacity_fallback,
      reserved: 0,
      routing_weight: 1,
      priority: source.priority
    };
  }
  const state = source.state;
  if (state.component !== 'rustpbx' ||
      state.region_id !== input.region_id ||
      state.zone_id !== input.zone_id ||
      state.cell_id !== input.cell_id ||
      state.node_id !== source.node_id) {
    throw new Error(`Kamailio route topology mismatch for node ${source.node_id}`);
  }
  if (state.cell_lease_epoch !== input.cell_lease_epoch) {
    throw new Error(`Kamailio route Cell lease epoch mismatch for node ${source.node_id}`);
  }
  const dimension = state.dimensions[dimensionName];
  if (!dimension) {
    throw new Error(`Kamailio route capacity dimension ${dimensionName} is missing for node ${source.node_id}`);
  }
  const leaseExpiresMs = Date.parse(state.lease_expires_at);
  const effectiveState: KamailioRouteNodeState = !state.lease_fresh ||
    state.recovery_pending || !Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= generatedMs
    ? 'offline'
    : state.state;
  return {
    node_id: source.node_id,
    sip_uri: source.sip_uri,
    pin_set_id: source.pin_set_id,
    state: effectiveState,
    safe_capacity: dimension.safe_capacity,
    used: dimension.used,
    reserved: dimension.reserved,
    routing_weight: 1,
    priority: source.priority
  };
}

function applyRelativeWeights(
  nodes: KamailioRouteSnapshotNode[],
  degradedFactor: number
): void {
  const eligible = nodes.filter(isEligibleForNewCalls);
  const maximumHeadroom = eligible.reduce(
    (maximum, node) => Math.max(maximum, headroom(node)),
    0
  );
  for (const node of nodes) {
    if (!isEligibleForNewCalls(node) || maximumHeadroom <= 0) {
      node.routing_weight = node.state === 'offline' ? 1 : 100;
      if (headroom(node) <= 0) node.routing_weight = 1;
      continue;
    }
    const normalized = Math.round(100 * headroom(node) / maximumHeadroom);
    const adjusted = node.state === 'degraded'
      ? Math.round(normalized * degradedFactor)
      : normalized;
    node.routing_weight = Math.max(1, Math.min(100, adjusted));
  }
}

function isEligibleForNewCalls(node: KamailioRouteSnapshotNode): boolean {
  return (node.state === 'accepting' || node.state === 'degraded') && headroom(node) > 0;
}

function headroom(node: KamailioRouteSnapshotNode): number {
  return node.safe_capacity - node.used - node.reserved;
}

function dispatcherLine(input: {
  set_id: number;
  node: KamailioRouteSnapshotNode;
  flags: number;
  attrs: string[];
}): string {
  return [
    input.set_id,
    input.node.sip_uri,
    input.flags,
    input.node.priority,
    input.attrs.join(';')
  ].join(' ');
}

function boundedFactor(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('Kamailio degraded weight factor must be greater than zero and at most one');
  }
  return value;
}
