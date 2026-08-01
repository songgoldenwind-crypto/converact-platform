import { resolveConveractEnv, resolveFabricEnv } from '../src/config/converact-env.js';
import { pathToFileURL } from 'node:url';

import {
  createComponentCapacityProbe,
  type ComponentCapacityObservation,
  type ComponentCapacityProbe,
  type ComponentCapacityProbeConfig
} from './capacity/probes/index.js';
import type {
  AdmissionState,
  CellCapacityObservation,
  CellCapacityObservationDimension,
  FlatCapacityState
} from '../src/agent-runtime/converact/placement/types.js';
import {
  compileAdmissionNodePools,
  validateAdmissionNodeCapacity,
  type AdmissionNodePoolConfig
} from '../src/agent-runtime/converact/placement/component-node-topology.js';

interface ProjectorNodeConfig {
  node_id: string;
  state: AdmissionState;
  dimensions: FlatCapacityState;
}

export interface CellCapacityPublisher {
  state(): Promise<{
    capacity_sequence: number;
    cell_lease_epoch: number;
    state: AdmissionState;
  }>;
  publish(observation: CellCapacityObservation): Promise<void>;
  setState(state: 'accepting' | 'degraded'): Promise<void>;
}

export interface CellCapacityProjector {
  runOnce(now?: Date): Promise<CellCapacityObservation>;
}

export interface CellCapacityProjectorRuntimeConfig {
  admission_endpoint: string;
  service_token: string;
  interval_ms: number;
  observation_ttl_ms: number;
  region_id: string;
  zone_id: string;
  cell_id: string;
  profile_id: string;
  profile_sha256: string;
  dimensions: FlatCapacityState;
  nodes: ProjectorNodeConfig[];
  probes: ComponentCapacityProbeConfig[];
}

export function createCellCapacityProjector(input: {
  publisher: CellCapacityPublisher;
  probes: ComponentCapacityProbe[];
  observation_ttl_ms: number;
  region_id: string;
  zone_id: string;
  cell_id: string;
  profile_id: string;
  profile_sha256: string;
  dimensions: FlatCapacityState;
  nodes: ProjectorNodeConfig[];
}): CellCapacityProjector {
  if (input.probes.length !== input.nodes.length) {
    throw new Error('Cell capacity projector requires one probe per node');
  }
  const ttlMs = boundedInteger(input.observation_ttl_ms, 1_000, 300_000);
  return {
    async runOnce(now = new Date()) {
      validDate(now);
      const state = await input.publisher.state();
      if (!Number.isSafeInteger(state.capacity_sequence) ||
          state.capacity_sequence < 0 ||
          !Number.isInteger(state.cell_lease_epoch) ||
          state.cell_lease_epoch < 1 ||
          state.cell_lease_epoch > 0xffff_ffff) {
        throw new Error('Cell admission returned invalid capacity state');
      }
      const observations = await Promise.all(
        input.probes.map((probe) => probe.collect(now))
      );
      const observation = buildCellCapacityObservation({
        sequence: state.capacity_sequence + 1,
        observed_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        region_id: input.region_id,
        zone_id: input.zone_id,
        cell_id: input.cell_id,
        cell_lease_epoch: state.cell_lease_epoch,
        profile_id: input.profile_id,
        profile_sha256: input.profile_sha256,
        dimensions: input.dimensions,
        nodes: input.nodes,
        observations
      });
      await input.publisher.publish(observation);
      if (state.state === 'draining' && state.capacity_sequence === 0) {
        const admissionState = observation.nodes.every(
          (node) => node.state === 'accepting'
        ) ? 'accepting' : 'degraded';
        await input.publisher.setState(admissionState);
      }
      return observation;
    }
  };
}

export function buildCellCapacityObservation(input: {
  sequence: number;
  observed_at: string;
  expires_at: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  cell_lease_epoch: number;
  profile_id: string;
  profile_sha256: string;
  dimensions: FlatCapacityState;
  nodes: ProjectorNodeConfig[];
  observations: ComponentCapacityObservation[];
}): CellCapacityObservation {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error('invalid Cell capacity sequence');
  }
  validIdentifier(input.region_id);
  validIdentifier(input.zone_id);
  validIdentifier(input.cell_id);
  if (!Number.isInteger(input.cell_lease_epoch) ||
      input.cell_lease_epoch < 1 || input.cell_lease_epoch > 0xffff_ffff) {
    throw new Error('invalid Cell capacity lease epoch');
  }
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(input.profile_id) ||
      !/^[a-f0-9]{64}$/.test(input.profile_sha256)) {
    throw new Error('invalid Cell capacity profile');
  }
  const observedAt = Date.parse(input.observed_at);
  const expiresAt = Date.parse(input.expires_at);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) ||
      expiresAt <= observedAt || expiresAt - observedAt > 300_000) {
    throw new Error('invalid Cell capacity timestamps');
  }
  validateFlatCapacity(input.dimensions);
  if (input.nodes.length === 0) throw new Error('Cell capacity nodes are required');
  const nodesById = new Map<string, ProjectorNodeConfig>();
  for (const node of input.nodes) {
    validIdentifier(node.node_id);
    if (nodesById.has(node.node_id)) throw new Error('duplicate Cell capacity node');
    validAdmissionState(node.state);
    validateFlatCapacity(node.dimensions);
    nodesById.set(node.node_id, node);
  }
  const observations = new Map<string, ComponentCapacityObservation>();
  for (const observation of input.observations) {
    if (observations.has(observation.instance_id)) {
      throw new Error('duplicate component capacity observation');
    }
    if (!nodesById.has(observation.instance_id)) {
      throw new Error('unexpected component capacity observation');
    }
    validateObservationIdentity(observation, input);
    observations.set(observation.instance_id, observation);
  }

  const aggregateUsed: Record<string, number> = {};
  const coveredDimensions = new Set<string>();
  const nodes: CellCapacityObservation['nodes'] = [];
  for (const expected of input.nodes) {
    const observation = observations.get(expected.node_id);
    const failedClosed = !observation || observation.outcome !== 'observed';
    const dimensions: Record<string, CellCapacityObservationDimension> = {};
    if (!failedClosed) {
      validateObservedNodeDimensions(observation.dimensions, expected.dimensions);
    }
    for (const [name, expectedDimension] of Object.entries(expected.dimensions)) {
      const used = failedClosed
        ? expectedDimension.safe_capacity
        : observation!.dimensions[name].used;
      dimensions[name] = {
        unit: expectedDimension.unit,
        safe_capacity: expectedDimension.safe_capacity,
        used
      };
      aggregateUsed[name] = (aggregateUsed[name] || 0) + used;
      coveredDimensions.add(name);
    }
    nodes.push({
      node_id: expected.node_id,
      state: failedClosed
        ? 'offline'
        : moreRestrictiveAdmissionState(expected.state, observation!.state),
      dimensions
    });
  }

  const dimensions: CellCapacityObservation['dimensions'] = {};
  for (const [name, expected] of Object.entries(input.dimensions)) {
    if (!coveredDimensions.has(name)) {
      throw new Error(`Cell capacity dimension ${name} has no node observation`);
    }
    dimensions[name] = {
      unit: expected.unit,
      safe_capacity: expected.safe_capacity,
      used: aggregateUsed[name] || 0
    };
  }
  return {
    schema_version: '1.0.0',
    sequence: input.sequence,
    observed_at: new Date(observedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    region_id: input.region_id,
    zone_id: input.zone_id,
    cell_id: input.cell_id,
    cell_lease_epoch: input.cell_lease_epoch,
    dimensions,
    nodes
  };
}

export class HttpCellCapacityPublisher implements CellCapacityPublisher {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(input: {
    endpoint: string;
    service_token: string;
    timeout_ms?: number;
    fetch?: typeof fetch;
  }) {
    this.#endpoint = checkedHttpUrl(input.endpoint);
    this.#token = safeToken(input.service_token);
    this.#timeoutMs = boundedInteger(input.timeout_ms ?? 2_000, 100, 30_000);
    this.#fetch = input.fetch || globalThis.fetch;
  }

  async state(): Promise<{
    capacity_sequence: number;
    cell_lease_epoch: number;
    state: AdmissionState;
  }> {
    const payload = await this.#request('/v1/state', { method: 'GET' });
    const data = object(payload.data);
    return {
      capacity_sequence: Number(data.capacity_sequence),
      cell_lease_epoch: Number(data.cell_lease_epoch),
      state: validAdmissionState(String(data.state))
    };
  }

  async publish(observation: CellCapacityObservation): Promise<void> {
    await this.#request('/v1/capacity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(observation)
    });
  }

  async setState(state: 'accepting' | 'degraded'): Promise<void> {
    await this.#request('/v1/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state })
    });
  }

  async #request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(new URL(path, this.#endpoint), {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(init.headers || {})
        }
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 1_048_576) {
        throw new Error('Cell admission response is too large');
      }
      const payload = object(JSON.parse(text));
      if (!response.ok) {
        const error = object(payload.error);
        throw new Error(`Cell admission rejected capacity: ${String(error.code || response.status)}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function cellCapacityProjectorRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): CellCapacityProjectorRuntimeConfig {
  const dimensions = jsonObject<FlatCapacityState>(
    required(env, 'CONVERACT_FABRIC_CELL_DIMENSIONS_JSON'),
    'CONVERACT_FABRIC_CELL_DIMENSIONS_JSON'
  );
  const explicitNodes = String(resolveFabricEnv(env, 'CELL_NODES_JSON') || '').trim();
  const nodePools = String(resolveFabricEnv(env, 'CELL_NODE_POOLS_JSON') || '').trim();
  if (Boolean(explicitNodes) === Boolean(nodePools)) {
    throw new Error('exactly one Cell node topology authority is required');
  }
  const nodes = nodePools
    ? projectorNodesFromPools(jsonArray<AdmissionNodePoolConfig>(
        nodePools,
        'CONVERACT_FABRIC_CELL_NODE_POOLS_JSON'
      ), dimensions)
    : jsonArray<ProjectorNodeConfig>(
        explicitNodes,
        'CONVERACT_FABRIC_CELL_NODES_JSON'
      );
  const probes = jsonArray<ComponentCapacityProbeConfig>(
    required(env, 'CONVERACT_FABRIC_CELL_PROBES_JSON'),
    'CONVERACT_FABRIC_CELL_PROBES_JSON'
  );
  for (const probe of probes) createComponentCapacityProbe(probe);
  if (probes.length !== nodes.length) {
    throw new Error('CONVERACT_FABRIC_CELL_PROBES_JSON must contain one probe per node');
  }
  return {
    admission_endpoint: checkedHttpUrl(
      resolveFabricEnv(env, 'CELL_ADMISSION_ENDPOINT') || 'http://127.0.0.1:3200'
    ).toString(),
    service_token: safeToken(required(env, 'CONVERACT_FABRIC_CELL_ADMISSION_TOKEN')),
    interval_ms: boundedInteger(
      numberValue(resolveFabricEnv(env, 'CELL_PROBE_INTERVAL_MS'), 2_000),
      500,
      60_000
    ),
    observation_ttl_ms: boundedInteger(
      numberValue(resolveFabricEnv(env, 'CELL_OBSERVATION_TTL_MS'), 10_000),
      1_000,
      300_000
    ),
    region_id: validIdentifier(required(env, 'CONVERACT_FABRIC_CELL_REGION_ID')),
    zone_id: validIdentifier(required(env, 'CONVERACT_FABRIC_CELL_ZONE_ID')),
    cell_id: validIdentifier(required(env, 'CONVERACT_FABRIC_CELL_ID')),
    profile_id: required(env, 'CONVERACT_FABRIC_CELL_CAPACITY_PROFILE_ID'),
    profile_sha256: required(env, 'CONVERACT_FABRIC_CELL_CAPACITY_PROFILE_SHA256'),
    dimensions,
    nodes,
    probes
  };
}

function projectorNodesFromPools(
  pools: AdmissionNodePoolConfig[],
  dimensions: FlatCapacityState
): ProjectorNodeConfig[] {
  const compiled = compileAdmissionNodePools(pools);
  validateAdmissionNodeCapacity(compiled, dimensions);
  return compiled.map((node) => ({
    node_id: node.node_id,
    state: node.state,
    dimensions: node.dimensions
  }));
}

export async function runCellCapacityProjector(
  config: CellCapacityProjectorRuntimeConfig
): Promise<void> {
  const projector = createCellCapacityProjector({
    publisher: new HttpCellCapacityPublisher({
      endpoint: config.admission_endpoint,
      service_token: config.service_token
    }),
    probes: config.probes.map(createComponentCapacityProbe),
    observation_ttl_ms: config.observation_ttl_ms,
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    profile_id: config.profile_id,
    profile_sha256: config.profile_sha256,
    dimensions: config.dimensions,
    nodes: config.nodes
  });
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopped) {
    try {
      const observation = await projector.runOnce();
      console.log(
        `[converact-cell-capacity] published sequence=${observation.sequence} ` +
        `lease=${observation.cell_lease_epoch}`
      );
    } catch (error) {
      console.error(
        '[converact-cell-capacity] projection failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!stopped) await delay(config.interval_ms);
  }
}

function validateObservationIdentity(
  observation: ComponentCapacityObservation,
  expected: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    profile_id: string;
    profile_sha256: string;
  }
): void {
  if (observation.region_id !== expected.region_id ||
      observation.zone_id !== expected.zone_id ||
      observation.cell_id !== expected.cell_id ||
      observation.profile_id !== expected.profile_id ||
      observation.profile_sha256 !== expected.profile_sha256) {
    throw new Error('component capacity observation identity mismatch');
  }
}

function validateObservedNodeDimensions(
  observed: ComponentCapacityObservation['dimensions'],
  expected: FlatCapacityState
): void {
  const observedKeys = Object.keys(observed).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (observedKeys.length !== expectedKeys.length ||
      observedKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('component capacity dimensions mismatch');
  }
  for (const name of expectedKeys) {
    const sample = observed[name];
    const dimension = expected[name];
    if (sample.unit !== dimension.unit ||
        sample.safe_capacity !== dimension.safe_capacity ||
        !Number.isFinite(sample.used) || sample.used < 0) {
      throw new Error('component capacity dimensions mismatch');
    }
  }
}

function validateFlatCapacity(dimensions: FlatCapacityState): void {
  const entries = Object.entries(dimensions);
  if (entries.length === 0) throw new Error('Cell capacity dimensions are required');
  for (const [name, dimension] of entries) {
    if (!/^[a-z][a-z0-9_.]{2,127}$/.test(name) ||
        !dimension.unit || dimension.unit.length > 64 ||
        !Number.isFinite(dimension.safe_capacity) || dimension.safe_capacity <= 0 ||
        !Number.isFinite(dimension.used) || dimension.used < 0 ||
        !Number.isFinite(dimension.reserved) || dimension.reserved < 0) {
      throw new Error('invalid Cell capacity dimension');
    }
  }
}

function validAdmissionState(value: string): AdmissionState {
  if (!['accepting', 'degraded', 'draining', 'offline'].includes(value)) {
    throw new Error('invalid Cell capacity node state');
  }
  return value as AdmissionState;
}

function moreRestrictiveAdmissionState(
  configured: AdmissionState,
  observed: AdmissionState
): AdmissionState {
  const precedence: AdmissionState[] = [
    'accepting',
    'degraded',
    'draining',
    'offline'
  ];
  return precedence[
    Math.max(precedence.indexOf(configured), precedence.indexOf(observed))
  ];
}

function validIdentifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(value)) {
    throw new Error('invalid Cell capacity identifier');
  }
  return value;
}

function checkedHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid Cell capacity endpoint');
  }
  return url;
}

function safeToken(value: string): string {
  if (value.length < 24 || value.length > 512 || /[\r\n\0]/.test(value) ||
      /change[_-]?me|replace|placeholder|example/i.test(value)) {
    throw new Error('invalid Cell capacity service token');
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(resolveConveractEnv(env, key) || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function numberValue(value: string | undefined, fallback: number): number {
  return value == null || value === '' ? fallback : Number(value);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('Cell capacity numeric configuration is invalid');
  }
  return value;
}

function validDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid Cell capacity time');
  }
}

function jsonObject<T extends object>(value: string, field: string): T {
  const parsed = parseJson(value, field);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return structuredClone(parsed) as T;
}

function jsonArray<T>(value: string, field: string): T[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array`);
  return structuredClone(parsed) as T[];
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${field} is invalid JSON`);
  }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cell capacity response is invalid');
  }
  return value as Record<string, any>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCellCapacityProjector(cellCapacityProjectorRuntimeConfig()).catch((error) => {
    console.error(
      '[converact-cell-capacity] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
