import { createHash } from 'node:crypto';

import type {
  AdmissionState,
  FlatCapacityState,
  InteractionKind
} from './types.js';
import type { ComponentNodeComponent } from './component-node-admission.js';

export interface AdmissionNodeConfig {
  node_id: string;
  endpoint: string;
  control_endpoint?: string;
  state: AdmissionState;
  profile_ids: string[];
  interaction_kinds: InteractionKind[];
  dimensions: FlatCapacityState;
}

export interface AdmissionNodePoolConfig {
  component: ComponentNodeComponent;
  node_id_prefix: string;
  replica_count: number;
  endpoint_template: string;
  control_endpoint_template: string;
  state: AdmissionState;
  profile_ids: string[];
  interaction_kinds: InteractionKind[];
  dimensions: FlatCapacityState;
}

export interface CellAdmissionTopology {
  profile_ids: readonly string[];
  interaction_kinds: readonly InteractionKind[];
  dimensions: FlatCapacityState;
  nodes: readonly AdmissionNodeConfig[];
}

const COMPONENT_BY_KIND: Record<InteractionKind, ComponentNodeComponent> = {
  tinode_im: 'tinode',
  sip_voice: 'rustpbx',
  livekit_av: 'livekit',
  livekit_screen: 'livekit',
  rustdesk_remote: 'rustdesk'
};

export function compileAdmissionNodePools(
  input: AdmissionNodePoolConfig[]
): AdmissionNodeConfig[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new Error('component node pools are invalid');
  }
  const nodes = new Map<string, AdmissionNodeConfig>();
  for (const raw of input) {
    const pool = checkedPool(raw);
    for (let ordinal = 0; ordinal < pool.replica_count; ordinal += 1) {
      const nodeId = checkedIdentifier(
        `${pool.node_id_prefix}-${ordinal}`,
        'component node ID'
      );
      if (nodes.has(nodeId)) {
        throw new Error('duplicate component node ID');
      }
      nodes.set(nodeId, {
        node_id: nodeId,
        endpoint: renderEndpoint(pool.endpoint_template, nodeId),
        control_endpoint: renderEndpoint(
          pool.control_endpoint_template,
          nodeId
        ),
        state: pool.state,
        profile_ids: [...pool.profile_ids],
        interaction_kinds: [...pool.interaction_kinds],
        dimensions: structuredClone(pool.dimensions)
      });
      if (nodes.size > 1_024) {
        throw new Error('component node topology is too large');
      }
    }
  }
  return [...nodes.values()].sort(
    (left, right) => left.node_id.localeCompare(right.node_id)
  );
}

export function validateAdmissionNodeCapacity(
  nodes: AdmissionNodeConfig[],
  cellDimensions: FlatCapacityState
): void {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('component node capacity requires nodes');
  }
  const cell = checkedDimensions(cellDimensions);
  const aggregate: FlatCapacityState = {};
  for (const node of nodes) {
    for (const [name, dimension] of Object.entries(
      checkedDimensions(node.dimensions)
    )) {
      const existing = aggregate[name];
      if (existing && existing.unit !== dimension.unit) {
        throw new Error('component node capacity unit mismatch');
      }
      aggregate[name] = {
        unit: dimension.unit,
        safe_capacity: (existing?.safe_capacity || 0) +
          dimension.safe_capacity,
        used: (existing?.used || 0) + dimension.used,
        reserved: (existing?.reserved || 0) + dimension.reserved
      };
    }
  }
  if (Object.keys(aggregate).length !== Object.keys(cell).length) {
    throw new Error('component node capacity does not cover Cell dimensions');
  }
  for (const [name, expected] of Object.entries(cell)) {
    const actual = aggregate[name];
    if (!actual ||
        actual.unit !== expected.unit ||
        actual.safe_capacity !== expected.safe_capacity ||
        actual.used !== expected.used ||
        actual.reserved !== expected.reserved) {
      throw new Error(`component node capacity mismatch for ${name}`);
    }
  }
}

export function cellAdmissionTopologySha256(
  input: CellAdmissionTopology
): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Cell admission topology is invalid');
  }
  const nodeIds = new Set<string>();
  const nodes = input.nodes.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Cell admission topology node is invalid');
    }
    const allowed = new Set([
      'node_id',
      'endpoint',
      'control_endpoint',
      'state',
      'profile_ids',
      'interaction_kinds',
      'dimensions'
    ]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) {
      throw new Error('Cell admission topology node contains unknown fields');
    }
    const nodeId = checkedIdentifier(raw.node_id, 'component node ID');
    if (nodeIds.has(nodeId)) {
      throw new Error('duplicate component node ID');
    }
    nodeIds.add(nodeId);
    return {
      node_id: nodeId,
      endpoint: checkedEndpoint(raw.endpoint),
      control_endpoint: raw.control_endpoint
        ? checkedEndpoint(raw.control_endpoint)
        : '',
      state: checkedState(raw.state),
      profile_ids: checkedProfiles([...raw.profile_ids]),
      interaction_kinds: checkedKinds([...raw.interaction_kinds]),
      dimensions: canonicalDimensions(checkedDimensions(raw.dimensions))
    };
  }).sort((left, right) => left.node_id.localeCompare(right.node_id));
  if (nodes.length === 0) {
    throw new Error('Cell admission topology requires nodes');
  }
  return createHash('sha256').update(JSON.stringify({
    schema_version: 1,
    profile_ids: checkedProfiles([...input.profile_ids]),
    interaction_kinds: checkedKinds([...input.interaction_kinds]),
    dimensions: canonicalDimensions(checkedDimensions(input.dimensions)),
    nodes
  })).digest('hex');
}

function checkedPool(raw: AdmissionNodePoolConfig): AdmissionNodePoolConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('component node pool is invalid');
  }
  const allowed = new Set([
    'component',
    'node_id_prefix',
    'replica_count',
    'endpoint_template',
    'control_endpoint_template',
    'state',
    'profile_ids',
    'interaction_kinds',
    'dimensions'
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error('component node pool contains unknown fields');
  }
  if (!['rustpbx', 'livekit', 'tinode', 'rustdesk'].includes(raw.component)) {
    throw new Error('component node pool component is invalid');
  }
  const prefix = checkedIdentifier(
    raw.node_id_prefix,
    'component node prefix'
  );
  if (!Number.isInteger(raw.replica_count) ||
      raw.replica_count < 1 || raw.replica_count > 1_024) {
    throw new Error('component node replica count is invalid');
  }
  const state = checkedState(raw.state);
  const profileIds = checkedProfiles(raw.profile_ids);
  const interactionKinds = checkedKinds(raw.interaction_kinds);
  if (interactionKinds.some((kind) => COMPONENT_BY_KIND[kind] !== raw.component)) {
    throw new Error('component node interaction kind does not match component');
  }
  const dimensions = checkedDimensions(raw.dimensions);
  return {
    component: raw.component,
    node_id_prefix: prefix,
    replica_count: raw.replica_count,
    endpoint_template: checkedTemplate(
      raw.endpoint_template,
      'component endpoint template'
    ),
    control_endpoint_template: checkedTemplate(
      raw.control_endpoint_template,
      'component control endpoint template'
    ),
    state,
    profile_ids: profileIds,
    interaction_kinds: interactionKinds,
    dimensions
  };
}

function checkedTemplate(value: unknown, field: string): string {
  const template = String(value || '');
  if ((template.match(/\{node_id\}/g) || []).length !== 1 ||
      /[{}]/.test(template.replace('{node_id}', ''))) {
    throw new Error(`${field} must contain one node_id placeholder`);
  }
  renderEndpoint(template, 'node-a-0');
  return template;
}

function renderEndpoint(template: string, nodeId: string): string {
  let url: URL;
  try {
    url = new URL(template.replace('{node_id}', nodeId));
  } catch {
    throw new Error('component node endpoint is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.hash) {
    throw new Error('component node endpoint is invalid');
  }
  return url.toString().replace(/\/$/, '');
}

function checkedEndpoint(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('component node endpoint is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.hash) {
    throw new Error('component node endpoint is invalid');
  }
  return url.toString().replace(/\/$/, '');
}

function checkedProfiles(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((value) =>
        !/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(value))) {
    throw new Error('component node profiles are invalid');
  }
  return [...values].sort();
}

function checkedKinds(values: InteractionKind[]): InteractionKind[] {
  if (!Array.isArray(values) || values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((value) => !(value in COMPONENT_BY_KIND))) {
    throw new Error('component node interaction kinds are invalid');
  }
  return [...values].sort();
}

function checkedState(value: AdmissionState): AdmissionState {
  if (!['accepting', 'degraded', 'draining', 'offline'].includes(value)) {
    throw new Error('component node state is invalid');
  }
  return value;
}

function checkedDimensions(input: FlatCapacityState): FlatCapacityState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('component node capacity dimensions are invalid');
  }
  const dimensions: FlatCapacityState = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
        !value || typeof value !== 'object' ||
        typeof value.unit !== 'string' || !value.unit ||
        !Number.isFinite(value.safe_capacity) || value.safe_capacity <= 0 ||
        !Number.isFinite(value.used) || value.used < 0 ||
        !Number.isFinite(value.reserved) || value.reserved < 0 ||
        value.used + value.reserved > value.safe_capacity) {
      throw new Error('component node capacity dimension is invalid');
    }
    dimensions[name] = { ...value };
  }
  if (Object.keys(dimensions).length === 0) {
    throw new Error('component node capacity dimensions are required');
  }
  return dimensions;
}

function canonicalDimensions(input: FlatCapacityState): FlatCapacityState {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right))
  );
}

function checkedIdentifier(value: unknown, field: string): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,240}$/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}
