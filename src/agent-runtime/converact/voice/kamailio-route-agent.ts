import { resolveConveractEnv, resolveFabricEnv } from '../../../config/converact-env.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, isAbsolute } from 'node:path';

import type { ComponentNodeStateSnapshot } from '../placement/component-node-admission.js';
import { HttpComponentNodeAdmissionClient } from '../placement/component-node-admission-http.js';
import {
  compileKamailioRouteSnapshotBody,
  renderKamailioDispatcherList,
  type KamailioRoutePoolSource
} from './kamailio-route-compiler.js';
import {
  KamailioRouteSnapshotCodec,
  type KamailioRouteSnapshotBody,
  type KamailioRouteSnapshotKey
} from './kamailio-route-snapshot.js';
import {
  HttpHomerMetricsClient,
  KamailioHepHighWaterController,
  KamailioHepHighWaterStateMachine,
  type KamailioHepDecision,
  type KamailioHepHighWaterPolicy
} from './kamailio-hep-high-water.js';

const POLL_FAILURE_THRESHOLD = 3;
const MAXIMUM_CORE_METRICS_BYTES = 1_048_576;
const METRIC_STATES = ['accepting', 'degraded', 'draining', 'offline'] as const;
const REJECTION_REASONS = [
  'poll_unavailable',
  'compile_invalid',
  'publish_failed',
  'snapshot_expired'
] as const;

export interface KamailioRouteAgentNode {
  node_id: string;
  sip_uri: string;
  pin_set_id: number;
  priority: number;
  safe_capacity_fallback: number;
  read_state: () => Promise<ComponentNodeStateSnapshot>;
}

export interface KamailioRouteAgentPool {
  pool_id: number;
  profile_id: string;
  capacity_dimension: string;
  nodes: KamailioRouteAgentNode[];
}

export interface KamailioDispatcherReloadPort {
  reload(): Promise<void>;
}

export interface KamailioRoutePublicationPort {
  publish(input: {
    snapshot_path: string;
    snapshot: string;
    dispatcher_path: string;
    dispatcher: string;
  }): Promise<void>;
  publishDispatcher(input: {
    dispatcher_path: string;
    dispatcher: string;
  }): Promise<void>;
}

export interface KamailioRouteAgentOptions {
  codec: KamailioRouteSnapshotCodec;
  region_id: string;
  zone_id: string;
  cell_id: string;
  cell_lease_epoch: number;
  edge_replica_count: number;
  ttl_ms: number;
  degraded_weight_factor: number;
  max_parallel_polls: number;
  snapshot_path: string;
  dispatcher_path: string;
  pools: KamailioRouteAgentPool[];
  rpc: KamailioDispatcherReloadPort;
  publisher?: KamailioRoutePublicationPort;
}

export type KamailioRouteAgentRunMode =
  | 'published'
  | 'unchanged'
  | 'last_known_good'
  | 'fail_closed'
  | 'reload_retry';

export interface KamailioRouteAgentRunResult {
  mode: KamailioRouteAgentRunMode;
  published: boolean;
  reloaded: boolean;
  sequence: number;
}

interface NodePollCache {
  state: ComponentNodeStateSnapshot | null;
  consecutive_failures: number;
}

export class KamailioRouteAgent {
  readonly #options: KamailioRouteAgentOptions;
  readonly #publisher: KamailioRoutePublicationPort;
  readonly #nodeCache = new Map<string, NodePollCache>();
  readonly #reloadCounts = { success: 0, failure: 0 };
  readonly #rejections = new Map<string, number>(REJECTION_REASONS.map((reason) => [reason, 0]));
  #currentBody: KamailioRouteSnapshotBody | null = null;
  #lastSequence = 0;
  #reloadPending = false;
  #pendingReloadMode: 'published' | 'fail_closed' = 'published';
  #lastReloadSucceeded = false;
  #failClosedApplied = false;
  #lastPollDurationSeconds = 0;
  #lastPollSucceeded = false;
  #run: Promise<KamailioRouteAgentRunResult> | null = null;

  constructor(options: KamailioRouteAgentOptions) {
    if (!isAbsolute(options.snapshot_path) || !isAbsolute(options.dispatcher_path) ||
        options.snapshot_path === options.dispatcher_path) {
      throw new Error('Kamailio route publication paths must be distinct absolute paths');
    }
    boundedInteger(options.ttl_ms, 1_000, 300_000, 'Kamailio route TTL');
    boundedInteger(options.max_parallel_polls, 1, 128, 'Kamailio route poll concurrency');
    this.#options = options;
    this.#publisher = options.publisher || new AtomicKamailioRoutePublisher();
    for (const pool of options.pools) {
      for (const node of pool.nodes) {
        if (this.#nodeCache.has(node.node_id)) throw new Error(`duplicate Kamailio node ${node.node_id}`);
        this.#nodeCache.set(node.node_id, { state: null, consecutive_failures: 0 });
      }
    }
  }

  restore(wire: string, now: Date): { sequence: number; fresh: boolean } {
    const inspected = this.#options.codec.inspect(wire, this.#inspectionInput());
    this.#currentBody = structuredClone(inspected.body) as KamailioRouteSnapshotBody;
    this.#lastSequence = inspected.body.sequence;
    const timestamp = validDate(now).getTime();
    const fresh = timestamp >= Date.parse(inspected.body.generated_at) &&
      timestamp < Date.parse(inspected.body.expires_at);
    this.#failClosedApplied = !fresh;
    this.#lastReloadSucceeded = false;
    return { sequence: this.#lastSequence, fresh };
  }

  runOnce(now = new Date()): Promise<KamailioRouteAgentRunResult> {
    validDate(now);
    if (this.#run) return this.#run;
    this.#run = this.#runOnce(now).finally(() => {
      this.#run = null;
    });
    return this.#run;
  }

  status(now = new Date()): {
    alive: true;
    ready: boolean;
    snapshot_valid: boolean;
    snapshot_age_seconds: number;
    sequence: number;
    reload_pending: boolean;
    fail_closed: boolean;
    new_call_nodes: number;
  } {
    const timestamp = validDate(now).getTime();
    const body = this.#currentBody;
    const generated = body ? Date.parse(body.generated_at) : 0;
    const expires = body ? Date.parse(body.expires_at) : 0;
    const fresh = Boolean(body) && timestamp >= generated && timestamp < expires;
    const newCallNodes = body ? countNewCallNodes(body) : 0;
    return {
      alive: true,
      ready: fresh && this.#lastReloadSucceeded && !this.#reloadPending &&
        !this.#failClosedApplied && newCallNodes > 0,
      snapshot_valid: fresh,
      snapshot_age_seconds: body ? Math.max(0, (timestamp - generated) / 1_000) : 0,
      sequence: this.#lastSequence,
      reload_pending: this.#reloadPending,
      fail_closed: this.#failClosedApplied || !fresh,
      new_call_nodes: newCallNodes
    };
  }

  prometheusMetrics(now = new Date()): string {
    const status = this.status(now);
    const counts = Object.fromEntries(METRIC_STATES.map((state) => [state, 0])) as Record<string, number>;
    for (const pool of this.#currentBody?.pools || []) {
      for (const node of pool.nodes) counts[node.state] += 1;
    }
    const lines = [
      '# TYPE ivekit_kamailio_snapshot_valid gauge',
      `ivekit_kamailio_snapshot_valid ${status.snapshot_valid ? 1 : 0}`,
      '# TYPE ivekit_kamailio_snapshot_age_seconds gauge',
      `ivekit_kamailio_snapshot_age_seconds ${status.snapshot_age_seconds}`,
      '# TYPE ivekit_kamailio_snapshot_sequence gauge',
      `ivekit_kamailio_snapshot_sequence ${status.sequence}`,
      '# TYPE ivekit_kamailio_new_call_nodes gauge',
      `ivekit_kamailio_new_call_nodes ${status.new_call_nodes}`,
      '# TYPE ivekit_kamailio_route_nodes gauge'
    ];
    for (const state of METRIC_STATES) {
      lines.push(`ivekit_kamailio_route_nodes{state="${state}"} ${counts[state]}`);
    }
    lines.push(
      '# TYPE ivekit_kamailio_route_reload_total counter',
      `ivekit_kamailio_route_reload_total{result="success"} ${this.#reloadCounts.success}`,
      `ivekit_kamailio_route_reload_total{result="failure"} ${this.#reloadCounts.failure}`,
      '# TYPE ivekit_kamailio_route_poll_duration_seconds gauge',
      `ivekit_kamailio_route_poll_duration_seconds{result="${this.#lastPollSucceeded ? 'success' : 'failure'}"} ${this.#lastPollDurationSeconds}`,
      '# TYPE ivekit_kamailio_route_rejections_total counter'
    );
    for (const reason of REJECTION_REASONS) {
      lines.push(`ivekit_kamailio_route_rejections_total{reason="${reason}"} ${this.#rejections.get(reason) || 0}`);
    }
    return `${lines.join('\n')}\n`;
  }

  async #runOnce(now: Date): Promise<KamailioRouteAgentRunResult> {
    if (this.#reloadPending) return this.#retryReload();

    const started = Date.now();
    const polled = await boundedMap(
      flattenNodes(this.#options.pools),
      this.#options.max_parallel_polls,
      async (node) => {
        try {
          return { node, state: await node.read_state(), error: null as unknown };
        } catch (error) {
          return { node, state: null, error };
        }
      }
    );
    this.#lastPollDurationSeconds = Math.max(0, (Date.now() - started) / 1_000);
    const successfulPolls = polled.filter((result) => result.state).length;
    this.#lastPollSucceeded = successfulPolls > 0;
    for (const result of polled) {
      const cache = this.#nodeCache.get(result.node.node_id)!;
      if (result.state) {
        cache.state = structuredClone(result.state);
        cache.consecutive_failures = 0;
      } else {
        cache.consecutive_failures += 1;
      }
    }

    if (successfulPolls === 0 && this.#currentBody) {
      this.#incrementRejection('poll_unavailable');
      return this.#retainOrFailClosed(now);
    }

    let nextBody: KamailioRouteSnapshotBody;
    try {
      nextBody = compileKamailioRouteSnapshotBody({
        sequence: this.#lastSequence + 1,
        region_id: this.#options.region_id,
        zone_id: this.#options.zone_id,
        cell_id: this.#options.cell_id,
        cell_lease_epoch: this.#options.cell_lease_epoch,
        generated_at: now.toISOString(),
        ttl_ms: this.#options.ttl_ms,
        edge_replica_count: this.#options.edge_replica_count,
        degraded_weight_factor: this.#options.degraded_weight_factor,
        pools: this.#sources(now)
      });
    } catch (error) {
      this.#incrementRejection('compile_invalid');
      if (this.#currentBody) return this.#retainOrFailClosed(now);
      throw error;
    }

    const renewalDue = !this.#currentBody ||
      Date.parse(this.#currentBody.expires_at) - now.getTime() <= this.#options.ttl_ms / 2;
    if (this.#currentBody && !renewalDue && sameRoutes(this.#currentBody, nextBody)) {
      return this.#result('unchanged', false, false);
    }

    const wire = this.#options.codec.encode(nextBody);
    this.#options.codec.verify(wire, {
      ...this.#inspectionInput(),
      now,
      last_accepted_sequence: this.#lastSequence
    });
    const dispatcher = renderKamailioDispatcherList(nextBody);
    try {
      await this.#publisher.publish({
        snapshot_path: this.#options.snapshot_path,
        snapshot: wire,
        dispatcher_path: this.#options.dispatcher_path,
        dispatcher
      });
    } catch (error) {
      this.#incrementRejection('publish_failed');
      throw error;
    }
    this.#currentBody = nextBody;
    this.#lastSequence = nextBody.sequence;
    this.#failClosedApplied = false;
    this.#reloadPending = true;
    this.#pendingReloadMode = 'published';
    await this.#reload();
    return this.#result('published', true, true);
  }

  #sources(now: Date): KamailioRoutePoolSource[] {
    const timestamp = now.getTime();
    return this.#options.pools.map((pool) => ({
      pool_id: pool.pool_id,
      profile_id: pool.profile_id,
      capacity_dimension: pool.capacity_dimension,
      nodes: pool.nodes.map((node) => {
        const cache = this.#nodeCache.get(node.node_id)!;
        const cachedLeaseFresh = cache.state &&
          Date.parse(cache.state.lease_expires_at) > timestamp;
        const state = cache.consecutive_failures < POLL_FAILURE_THRESHOLD && cachedLeaseFresh
          ? cache.state
          : cache.consecutive_failures === 0
            ? cache.state
            : null;
        return {
          node_id: node.node_id,
          sip_uri: node.sip_uri,
          pin_set_id: node.pin_set_id,
          priority: node.priority,
          safe_capacity_fallback: node.safe_capacity_fallback,
          state
        };
      })
    }));
  }

  async #retainOrFailClosed(now: Date): Promise<KamailioRouteAgentRunResult> {
    if (!this.#currentBody || now.getTime() < Date.parse(this.#currentBody.expires_at)) {
      return this.#result('last_known_good', false, false);
    }
    this.#incrementRejection('snapshot_expired');
    if (this.#failClosedApplied) return this.#result('fail_closed', false, false);
    const dispatcher = renderKamailioDispatcherList(this.#currentBody, { accept_new_calls: false });
    try {
      await this.#publisher.publishDispatcher({
        dispatcher_path: this.#options.dispatcher_path,
        dispatcher
      });
    } catch (error) {
      this.#incrementRejection('publish_failed');
      throw error;
    }
    this.#failClosedApplied = true;
    this.#reloadPending = true;
    this.#pendingReloadMode = 'fail_closed';
    await this.#reload();
    return this.#result('fail_closed', false, true);
  }

  async #retryReload(): Promise<KamailioRouteAgentRunResult> {
    const mode = this.#pendingReloadMode;
    await this.#reload();
    return this.#result(mode === 'published' ? 'reload_retry' : 'fail_closed', false, true);
  }

  async #reload(): Promise<void> {
    try {
      await this.#options.rpc.reload();
      this.#reloadCounts.success += 1;
      this.#reloadPending = false;
      this.#lastReloadSucceeded = true;
    } catch (error) {
      this.#reloadCounts.failure += 1;
      this.#lastReloadSucceeded = false;
      throw error;
    }
  }

  #inspectionInput() {
    return {
      expected_region_id: this.#options.region_id,
      expected_zone_id: this.#options.zone_id,
      expected_cell_id: this.#options.cell_id,
      expected_cell_lease_epoch: this.#options.cell_lease_epoch
    };
  }

  #result(
    mode: KamailioRouteAgentRunMode,
    published: boolean,
    reloaded: boolean
  ): KamailioRouteAgentRunResult {
    return { mode, published, reloaded, sequence: this.#lastSequence };
  }

  #incrementRejection(reason: typeof REJECTION_REASONS[number]): void {
    this.#rejections.set(reason, (this.#rejections.get(reason) || 0) + 1);
  }
}

export class AtomicKamailioRoutePublisher implements KamailioRoutePublicationPort {
  async publish(input: {
    snapshot_path: string;
    snapshot: string;
    dispatcher_path: string;
    dispatcher: string;
  }): Promise<void> {
    const snapshot = await prepareFile(input.snapshot_path, input.snapshot, 0o600);
    let dispatcher: PreparedFile | null = null;
    try {
      dispatcher = await prepareFile(input.dispatcher_path, input.dispatcher, 0o640);
      await commitFile(snapshot);
      await commitFile(dispatcher);
    } catch (error) {
      await cleanupFile(snapshot);
      if (dispatcher) await cleanupFile(dispatcher);
      throw error;
    }
  }

  async publishDispatcher(input: {
    dispatcher_path: string;
    dispatcher: string;
  }): Promise<void> {
    const prepared = await prepareFile(input.dispatcher_path, input.dispatcher, 0o640);
    try {
      await commitFile(prepared);
    } catch (error) {
      await cleanupFile(prepared);
      throw error;
    }
  }
}

interface PreparedFile {
  target: string;
  temporary: string;
  directory: string;
  mode: number;
}

async function prepareFile(target: string, body: string, mode: number): Promise<PreparedFile> {
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const file = await open(temporary, 'wx', mode);
  try {
    await file.writeFile(body, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  return { target, temporary, directory, mode };
}

async function commitFile(file: PreparedFile): Promise<void> {
  await rename(file.temporary, file.target);
  await chmod(file.target, file.mode);
  const directory = await open(file.directory, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function cleanupFile(file: PreparedFile): Promise<void> {
  await rm(file.temporary, { force: true });
}

export class HttpKamailioJsonRpcClient implements KamailioDispatcherReloadPort {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #requestId = 0;

  constructor(input: {
    endpoint: string;
    bearer_token: string;
    max_attempts?: number;
    retry_delay_ms?: number;
    timeout_ms?: number;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#endpoint = checkedLoopbackRpcEndpoint(input.endpoint);
    this.#token = checkedSecret(input.bearer_token, 'Kamailio RPC token');
    this.#maxAttempts = boundedInteger(input.max_attempts ?? 3, 1, 5, 'Kamailio RPC attempts');
    this.#retryDelayMs = boundedInteger(input.retry_delay_ms ?? 100, 0, 5_000, 'Kamailio RPC retry delay');
    this.#timeoutMs = boundedInteger(input.timeout_ms ?? 1_000, 100, 5_000, 'Kamailio RPC timeout');
    this.#fetch = input.fetch || globalThis.fetch;
    this.#sleep = input.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async reload(): Promise<void> {
    await this.#call('dispatcher.reload');
  }

  async applyHepControl(input: {
    mode: 'full' | 'sampled' | 'off';
    sample_buckets: number;
    revision: number;
  }): Promise<void> {
    const sampleBuckets = boundedInteger(
      input.sample_buckets,
      1,
      1_024,
      'Kamailio HEP sample buckets'
    );
    const revision = boundedInteger(
      input.revision,
      1,
      Number.MAX_SAFE_INTEGER,
      'Kamailio HEP control revision'
    );
    const mode = { off: 0, sampled: 1, full: 2 }[input.mode];
    if (mode === undefined) throw new Error('Kamailio HEP mode is invalid');
    await this.#call('htable.seti', ['ivekit_hep_control', 'sample_buckets', sampleBuckets]);
    await this.#call('htable.seti', ['ivekit_hep_control', 'mode', mode]);
    await this.#call('htable.seti', ['ivekit_hep_control', 'revision', revision]);
  }

  async readHepControlRevision(): Promise<number> {
    const result = await this.#call(
      'htable.get',
      ['ivekit_hep_control', 'revision']
    );
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Kamailio HEP control revision response is invalid');
    }
    const item = (result as Record<string, unknown>).item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Kamailio HEP control revision response is invalid');
    }
    const value = (item as Record<string, unknown>).value;
    if (typeof value !== 'number') {
      throw new Error('Kamailio HEP control revision response is invalid');
    }
    return boundedInteger(
      value,
      0,
      Number.MAX_SAFE_INTEGER,
      'Kamailio HEP control revision'
    );
  }

  async #call(method: string, params?: unknown[]): Promise<unknown> {
    let lastError: unknown = new Error(`Kamailio RPC ${method} failed`);
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const id = ++this.#requestId;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(this.#endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.#token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method,
            ...(params ? { params } : {}),
            id
          })
        });
        const payload = await boundedRpcResponse(response);
        if (!response.ok) throw new Error(`Kamailio RPC returned HTTP ${response.status}`);
        if (payload.jsonrpc !== '2.0' || payload.id !== id ||
            Object.prototype.hasOwnProperty.call(payload, 'error') ||
            !Object.prototype.hasOwnProperty.call(payload, 'result')) {
          throw new Error('Kamailio RPC response is invalid');
        }
        return payload.result;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.#maxAttempts) await this.#sleep(this.#retryDelayMs * attempt);
    }
    throw lastError;
  }
}

export class HttpKamailioCoreMetricsClient {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(input: {
    endpoint: string;
    timeout_ms?: number;
    fetch?: typeof fetch;
  }) {
    this.#endpoint = checkedLoopbackMetricsEndpoint(input.endpoint);
    this.#timeoutMs = boundedInteger(
      input.timeout_ms ?? 1_000,
      100,
      5_000,
      'Kamailio core metrics timeout'
    );
    this.#fetch = input.fetch || globalThis.fetch;
  }

  async read(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'text/plain' }
      });
      if (!response.ok) throw new Error(`Kamailio core metrics returned HTTP ${response.status}`);
      return boundedCoreMetricsResponse(response);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createKamailioRouteAgentHttpServer(input: {
  agent: KamailioRouteAgent;
  now?: () => Date;
  read_core_metrics?: () => Promise<string>;
  supplemental_metrics?: () => string;
}): Server {
  const now = input.now || (() => new Date());
  return createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/livez') {
      return sendJson(response, 200, { status: 'alive' });
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      const status = input.agent.status(now());
      return sendJson(response, status.ready ? 200 : 503, {
        status: status.ready ? 'ready' : 'not_ready',
        snapshot_valid: status.snapshot_valid,
        sequence: status.sequence,
        reload_pending: status.reload_pending,
        fail_closed: status.fail_closed,
        new_call_nodes: status.new_call_nodes
      });
    }
    if (request.method === 'GET' && url.pathname === '/metrics') {
      void sendRouteAgentMetrics({
        response,
        own_metrics: input.agent.prometheusMetrics(now()),
        read_core_metrics: input.read_core_metrics,
        supplemental_metrics: input.supplemental_metrics
      });
      return;
    }
    return sendJson(response, 404, { error: { code: 'not_found' } });
  });
}

export interface KamailioRouteAgentRuntimeNode extends Omit<KamailioRouteAgentNode, 'read_state'> {
  component_endpoint: string;
  service_token: string;
}

export interface KamailioHepHighWaterRuntimeConfig {
  poll_interval_ms: number;
  metrics_endpoint: string;
  metrics_timeout_ms: number;
  policy: KamailioHepHighWaterPolicy;
}

export interface KamailioRouteAgentRuntimeConfig {
  host: string;
  port: number;
  poll_interval_ms: number;
  region_id: string;
  zone_id: string;
  cell_id: string;
  cell_lease_epoch: number;
  edge_replica_count: number;
  ttl_ms: number;
  degraded_weight_factor: number;
  max_parallel_polls: number;
  snapshot_path: string;
  dispatcher_path: string;
  current_key: KamailioRouteSnapshotKey;
  previous_key?: KamailioRouteSnapshotKey;
  pools: Array<Omit<KamailioRouteAgentPool, 'nodes'> & { nodes: KamailioRouteAgentRuntimeNode[] }>;
  rpc: {
    endpoint: string;
    bearer_token: string;
    max_attempts: number;
    retry_delay_ms: number;
    timeout_ms: number;
  };
  hep_high_water?: KamailioHepHighWaterRuntimeConfig;
}

export async function loadKamailioRouteAgentRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<KamailioRouteAgentRuntimeConfig> {
  rejectInlineSecrets(env);
  const topologyPath = absolutePath(requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_TOPOLOGY_FILE'), 'topology file');
  const topology = parseTopology(await readBoundedText(topologyPath, 1_048_576, 'topology file'));
  const pools = [] as KamailioRouteAgentRuntimeConfig['pools'];
  for (const pool of topology.pools) {
    const nodes: KamailioRouteAgentRuntimeNode[] = [];
    for (const node of pool.nodes) {
      const tokenFile = absolutePath(node.service_token_file, `service token file for ${node.node_id}`);
      nodes.push({
        node_id: node.node_id,
        component_endpoint: checkedHttpEndpoint(node.component_endpoint, 'component endpoint').toString(),
        service_token: checkedSecret(
          (await readBoundedText(tokenFile, 4_096, 'component service token')).trim(),
          'component service token'
        ),
        sip_uri: node.sip_uri,
        pin_set_id: node.pin_set_id,
        priority: node.priority,
        safe_capacity_fallback: node.safe_capacity_fallback
      });
    }
    pools.push({
      pool_id: pool.pool_id,
      profile_id: pool.profile_id,
      capacity_dimension: pool.capacity_dimension,
      nodes
    });
  }
  const currentKeyFile = absolutePath(
    requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY_FILE'),
    'current key file'
  );
  const currentKey: KamailioRouteSnapshotKey = {
    key_id: requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY_ID'),
    key: (await readBoundedText(currentKeyFile, 4_096, 'current key')).trim()
  };
  const previousKeyId = String(resolveFabricEnv(env, 'KAMAILIO_PREVIOUS_KEY_ID') || '').trim();
  const previousKeyFile = String(resolveFabricEnv(env, 'KAMAILIO_PREVIOUS_KEY_FILE') || '').trim();
  if (Boolean(previousKeyId) !== Boolean(previousKeyFile)) {
    throw new Error('Kamailio previous key id and file must be configured together');
  }
  const previousKey = previousKeyId ? {
    key_id: previousKeyId,
    key: (await readBoundedText(
      absolutePath(previousKeyFile, 'previous key file'),
      4_096,
      'previous key'
    )).trim()
  } : undefined;
  new KamailioRouteSnapshotCodec({ current: currentKey, previous: previousKey });
  const rpcTokenFile = absolutePath(
    requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE'),
    'RPC token file'
  );
  const rpcToken = checkedSecret(
    (await readBoundedText(rpcTokenFile, 4_096, 'RPC token')).trim(),
    'Kamailio RPC token'
  );
  const snapshotPath = absolutePath(
    requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_SNAPSHOT_PATH'),
    'snapshot path'
  );
  const dispatcherPath = absolutePath(
    requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_DISPATCHER_PATH'),
    'dispatcher path'
  );
  if (snapshotPath === dispatcherPath) throw new Error('Kamailio publication paths must be distinct');
  const hepHighWaterEnabled = envBoolean(
    resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_ENABLED'),
    false,
    'CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED'
  );
  const hepHighWater = hepHighWaterEnabled
    ? parseHepHighWaterRuntimeConfig(env)
    : undefined;

  const config: KamailioRouteAgentRuntimeConfig = {
    host: checkedHost(resolveFabricEnv(env, 'KAMAILIO_HOST') || '127.0.0.1'),
    port: envInteger(resolveFabricEnv(env, 'KAMAILIO_PORT'), 3_220, 1, 65_535),
    poll_interval_ms: envInteger(resolveFabricEnv(env, 'KAMAILIO_POLL_INTERVAL_MS'), 1_000, 100, 60_000),
    region_id: requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_REGION_ID'),
    zone_id: requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_ZONE_ID'),
    cell_id: requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_CELL_ID'),
    cell_lease_epoch: envInteger(requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_CELL_LEASE_EPOCH'), 0, 1, 0xffff_ffff),
    edge_replica_count: envInteger(resolveFabricEnv(env, 'KAMAILIO_EDGE_REPLICA_COUNT'), 2, 1, 128),
    ttl_ms: envInteger(resolveFabricEnv(env, 'KAMAILIO_SNAPSHOT_TTL_MS'), 10_000, 1_000, 300_000),
    degraded_weight_factor: envNumber(resolveFabricEnv(env, 'KAMAILIO_DEGRADED_WEIGHT_FACTOR'), 0.5, 0.01, 1),
    max_parallel_polls: envInteger(resolveFabricEnv(env, 'KAMAILIO_MAX_PARALLEL_POLLS'), 16, 1, 128),
    snapshot_path: snapshotPath,
    dispatcher_path: dispatcherPath,
    current_key: currentKey,
    previous_key: previousKey,
    pools,
    rpc: {
      endpoint: checkedLoopbackRpcEndpoint(
        requiredEnv(env, 'CONVERACT_FABRIC_KAMAILIO_RPC_ENDPOINT')
      ).toString(),
      bearer_token: rpcToken,
      max_attempts: envInteger(resolveFabricEnv(env, 'KAMAILIO_RPC_MAX_ATTEMPTS'), 3, 1, 5),
      retry_delay_ms: envInteger(resolveFabricEnv(env, 'KAMAILIO_RPC_RETRY_DELAY_MS'), 100, 0, 5_000),
      timeout_ms: envInteger(resolveFabricEnv(env, 'KAMAILIO_RPC_TIMEOUT_MS'), 1_000, 100, 5_000)
    },
    hep_high_water: hepHighWater
  };
  compileKamailioRouteSnapshotBody({
    sequence: 1,
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    cell_lease_epoch: config.cell_lease_epoch,
    generated_at: new Date(0).toISOString(),
    ttl_ms: config.ttl_ms,
    edge_replica_count: config.edge_replica_count,
    degraded_weight_factor: config.degraded_weight_factor,
    pools: config.pools.map((pool) => ({
      ...pool,
      nodes: pool.nodes.map((node) => ({ ...node, state: null }))
    }))
  });
  return config;
}

export function createKamailioRouteAgentFromConfig(
  config: KamailioRouteAgentRuntimeConfig,
  dependencies: { fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void> } = {}
): KamailioRouteAgent {
  const codec = new KamailioRouteSnapshotCodec({
    current: config.current_key,
    previous: config.previous_key
  });
  const pools: KamailioRouteAgentPool[] = config.pools.map((pool) => ({
    ...pool,
    nodes: pool.nodes.map((node) => {
      const client = new HttpComponentNodeAdmissionClient({
        endpoint: node.component_endpoint,
        service_token: node.service_token,
        timeout_ms: Math.min(config.poll_interval_ms, 5_000),
        fetch: dependencies.fetch
      });
      return {
        node_id: node.node_id,
        sip_uri: node.sip_uri,
        pin_set_id: node.pin_set_id,
        priority: node.priority,
        safe_capacity_fallback: node.safe_capacity_fallback,
        read_state: () => client.readState()
      };
    })
  }));
  return new KamailioRouteAgent({
    codec,
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    cell_lease_epoch: config.cell_lease_epoch,
    edge_replica_count: config.edge_replica_count,
    ttl_ms: config.ttl_ms,
    degraded_weight_factor: config.degraded_weight_factor,
    max_parallel_polls: config.max_parallel_polls,
    snapshot_path: config.snapshot_path,
    dispatcher_path: config.dispatcher_path,
    pools,
    rpc: new HttpKamailioJsonRpcClient({
      ...config.rpc,
      fetch: dependencies.fetch,
      sleep: dependencies.sleep
    })
  });
}

export interface KamailioRouteAgentRuntimeHandle {
  agent: KamailioRouteAgent;
  server: Server;
  hep_controller?: KamailioHepHighWaterController;
  runOnce(): Promise<KamailioRouteAgentRunResult>;
  runHepOnce?(): Promise<KamailioHepDecision & { revision: number }>;
  stop(): Promise<void>;
}

export async function startKamailioRouteAgent(
  config: KamailioRouteAgentRuntimeConfig,
  dependencies: {
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
    log?: (message: string) => void;
  } = {}
): Promise<KamailioRouteAgentRuntimeHandle> {
  const now = dependencies.now || (() => new Date());
  const log = dependencies.log || ((message: string) => console.log(message));
  const agent = createKamailioRouteAgentFromConfig(config, dependencies);
  const coreMetrics = new HttpKamailioCoreMetricsClient({
    endpoint: metricsEndpointFromRpc(config.rpc.endpoint),
    timeout_ms: config.rpc.timeout_ms,
    fetch: dependencies.fetch
  });
  const homerMetrics = config.hep_high_water
    ? new HttpHomerMetricsClient({
        endpoint: config.hep_high_water.metrics_endpoint,
        timeout_ms: config.hep_high_water.metrics_timeout_ms,
        fetch: dependencies.fetch
      })
    : undefined;
  const hepRpc = config.hep_high_water
    ? new HttpKamailioJsonRpcClient({
        ...config.rpc,
        fetch: dependencies.fetch,
        sleep: dependencies.sleep
      })
    : undefined;
  const hepController = config.hep_high_water
    ? new KamailioHepHighWaterController({
        policy: config.hep_high_water.policy,
        read_metrics: () => homerMetrics!.read(),
        control: {
          read_revision: () => hepRpc!.readHepControlRevision(),
          apply: (input) => hepRpc!.applyHepControl(input)
        }
      })
    : undefined;
  try {
    const existing = await readFile(config.snapshot_path, 'utf8');
    const restored = agent.restore(existing, now());
    log(`[ivekit-kamailio-route-agent] restored sequence=${restored.sequence} fresh=${restored.fresh}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log('[ivekit-kamailio-route-agent] existing snapshot rejected; rebuilding from component state');
    }
  }
  const server = createKamailioRouteAgentHttpServer({
    agent,
    now,
    read_core_metrics: () => coreMetrics.read(),
    supplemental_metrics: hepController
      ? () => hepController.prometheusMetrics()
      : undefined
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  let stopping: Promise<void> | null = null;
  const tick = async (): Promise<KamailioRouteAgentRunResult> => {
    try {
      return await agent.runOnce(now());
    } catch (error) {
      log(`[ivekit-kamailio-route-agent] update failed: ${safeLogMessage(error)}`);
      throw error;
    }
  };
  const hepTick = hepController
    ? async (): Promise<KamailioHepDecision & { revision: number }> => {
        try {
          return await hepController.runOnce(now());
        } catch (error) {
          log(`[ivekit-kamailio-route-agent] HEP control update failed: ${safeLogMessage(error)}`);
          throw error;
        }
      }
    : undefined;
  await tick().catch(() => undefined);
  if (hepTick) await hepTick().catch(() => undefined);
  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, config.poll_interval_ms);
  timer.unref?.();
  const hepTimer = hepTick && config.hep_high_water
    ? setInterval(() => {
        void hepTick().catch(() => undefined);
      }, config.hep_high_water.poll_interval_ms)
    : undefined;
  hepTimer?.unref?.();
  return {
    agent,
    server,
    hep_controller: hepController,
    runOnce: tick,
    runHepOnce: hepTick,
    stop() {
      if (stopping) return stopping;
      clearInterval(timer);
      if (hepTimer) clearInterval(hepTimer);
      stopping = closeHttpServer(server);
      return stopping;
    }
  };
}

export async function runKamailioRouteAgent(
  config: KamailioRouteAgentRuntimeConfig
): Promise<void> {
  const handle = await startKamailioRouteAgent(config);
  const address = handle.server.address();
  const endpoint = address && typeof address === 'object'
    ? `${address.address}:${address.port}`
    : String(address || 'unknown');
  console.log(
    `[ivekit-kamailio-route-agent] listening on ${endpoint} for ` +
    `${config.region_id}/${config.zone_id}/${config.cell_id}`
  );
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void handle.stop().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function parseTopology(text: string): {
  pools: Array<{
    pool_id: number;
    profile_id: string;
    capacity_dimension: string;
    nodes: Array<{
      node_id: string;
      component_endpoint: string;
      service_token_file: string;
      sip_uri: string;
      pin_set_id: number;
      priority: number;
      safe_capacity_fallback: number;
    }>;
  }>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Kamailio topology file is invalid JSON');
  }
  const root = strictObject(parsed, ['pools'], 'topology');
  if (!Array.isArray(root.pools) || root.pools.length < 1 || root.pools.length > 256) {
    throw new Error('Kamailio topology pools are invalid');
  }
  return {
    pools: root.pools.map((rawPool, poolIndex) => {
      const pool = strictObject(
        rawPool,
        ['capacity_dimension', 'nodes', 'pool_id', 'profile_id'],
        `pool ${poolIndex}`
      );
      if (!Array.isArray(pool.nodes) || pool.nodes.length > 1_024) {
        throw new Error(`Kamailio topology nodes are invalid for pool ${poolIndex}`);
      }
      return {
        pool_id: Number(pool.pool_id),
        profile_id: String(pool.profile_id),
        capacity_dimension: String(pool.capacity_dimension),
        nodes: pool.nodes.map((rawNode, nodeIndex) => {
          const node = strictObject(rawNode, [
            'component_endpoint', 'node_id', 'pin_set_id', 'priority',
            'safe_capacity_fallback', 'service_token_file', 'sip_uri'
          ], `node ${nodeIndex}`);
          return {
            node_id: String(node.node_id),
            component_endpoint: String(node.component_endpoint),
            service_token_file: String(node.service_token_file),
            sip_uri: String(node.sip_uri),
            pin_set_id: Number(node.pin_set_id),
            priority: Number(node.priority),
            safe_capacity_fallback: Number(node.safe_capacity_fallback)
          };
        })
      };
    })
  };
}

function strictObject(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`Kamailio ${label} fields are invalid`);
  }
  return value as Record<string, unknown>;
}

function flattenNodes(pools: KamailioRouteAgentPool[]): KamailioRouteAgentNode[] {
  return pools.flatMap((pool) => pool.nodes);
}

async function boundedMap<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  }));
  return results;
}

function sameRoutes(left: KamailioRouteSnapshotBody, right: KamailioRouteSnapshotBody): boolean {
  return JSON.stringify(left.pools) === JSON.stringify(right.pools) &&
    left.edge_replica_count === right.edge_replica_count &&
    left.cell_lease_epoch === right.cell_lease_epoch;
}

function countNewCallNodes(body: KamailioRouteSnapshotBody): number {
  let count = 0;
  for (const pool of body.pools) {
    for (const node of pool.nodes) {
      if ((node.state === 'accepting' || node.state === 'degraded') &&
          node.safe_capacity - node.used - node.reserved > 0) count += 1;
    }
  }
  return count;
}

async function boundedRpcResponse(response: Response): Promise<Record<string, unknown>> {
  const maximum = 65_536;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximum) throw new Error('Kamailio RPC response is too large');
  const text = await response.text();
  if (Buffer.byteLength(text) > maximum) throw new Error('Kamailio RPC response is too large');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Kamailio RPC response is invalid');
  }
}

function checkedLoopbackRpcEndpoint(value: string): URL {
  const url = checkedHttpEndpoint(value, 'RPC endpoint');
  if (!['127.0.0.1', '[::1]', '::1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Kamailio RPC endpoint must use loopback without credentials');
  }
  return url;
}

function checkedLoopbackMetricsEndpoint(value: string): URL {
  const url = checkedHttpEndpoint(value, 'core metrics endpoint');
  if (!['127.0.0.1', '[::1]', '::1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/metrics') {
    throw new Error('Kamailio core metrics endpoint must use loopback /metrics without credentials');
  }
  return url;
}

function metricsEndpointFromRpc(value: string): string {
  const url = checkedLoopbackRpcEndpoint(value);
  url.pathname = '/metrics';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function checkedHttpEndpoint(value: string, label: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Kamailio ${label} is invalid`);
  }
  return url;
}

function checkedSecret(value: string, label: string): string {
  if (value.length < 24 || value.length > 512 || /[\0\r\n]/.test(value) ||
      /change[_-]?me|replace|placeholder|example/i.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function rejectInlineSecrets(env: NodeJS.ProcessEnv): void {
  const forbidden = [
    'CONVERACT_FABRIC_KAMAILIO_TOPOLOGY_JSON',
    'CONVERACT_FABRIC_KAMAILIO_CURRENT_KEY',
    'CONVERACT_FABRIC_KAMAILIO_PREVIOUS_KEY',
    'CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN',
    'CONVERACT_FABRIC_KAMAILIO_NODE_TOKENS_JSON'
  ];
  if (forbidden.some((name) => String(resolveConveractEnv(env, name) || '').trim())) {
    throw new Error('Kamailio inline secret or topology configuration is forbidden');
  }
}

async function readBoundedText(path: string, maximum: number, label: string): Promise<string> {
  const value = await readFile(path);
  if (value.length < 1 || value.length > maximum || value.includes(0)) {
    throw new Error(`Kamailio ${label} is empty or too large`);
  }
  return value.toString('utf8');
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`Kamailio ${label} must be absolute`);
  return value;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(resolveConveractEnv(env, key) || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function checkedHost(value: string): string {
  if (!/^[A-Za-z0-9:.-]+$/.test(value)) throw new Error('Kamailio route-agent host is invalid');
  return value;
}

function envInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value == null || value === '' ? fallback : Number(value);
  return boundedInteger(parsed, minimum, maximum, 'Kamailio numeric configuration');
}

function envNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Kamailio numeric configuration is invalid');
  }
  return parsed;
}

function parseHepHighWaterRuntimeConfig(
  env: NodeJS.ProcessEnv
): KamailioHepHighWaterRuntimeConfig {
  const metricsEndpoint = requiredEnv(
    env,
    'CONVERACT_FABRIC_KAMAILIO_HOMER_METRICS_ENDPOINT'
  );
  const metricsTimeoutMs = envInteger(
    resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_METRICS_TIMEOUT_MS'),
    1_000,
    100,
    5_000
  );
  new HttpHomerMetricsClient({
    endpoint: metricsEndpoint,
    timeout_ms: metricsTimeoutMs
  });
  const policy: KamailioHepHighWaterPolicy = {
    sample_percent: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_SAMPLE_PERCENT'),
      10,
      0.1,
      100
    ),
    queue_recover_ratio: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_QUEUE_RECOVER_RATIO'),
      0.2,
      0,
      1
    ),
    queue_sample_ratio: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_QUEUE_SAMPLE_RATIO'),
      0.5,
      0,
      1
    ),
    queue_off_ratio: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_QUEUE_OFF_RATIO'),
      0.8,
      0,
      1
    ),
    cpu_recover_cores: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_CPU_RECOVER_CORES'),
      0.3,
      0,
      1_024
    ),
    cpu_sample_cores: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_CPU_SAMPLE_CORES'),
      0.7,
      0,
      1_024
    ),
    cpu_off_cores: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_CPU_OFF_CORES'),
      1.5,
      0,
      1_024
    ),
    packets_recover_per_second: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_PACKETS_RECOVER_PER_SECOND'),
      2_000,
      0,
      100_000_000
    ),
    packets_sample_per_second: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_PACKETS_SAMPLE_PER_SECOND'),
      5_000,
      0,
      100_000_000
    ),
    packets_off_per_second: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_PACKETS_OFF_PER_SECOND'),
      10_000,
      0,
      100_000_000
    ),
    processing_gap_recover_per_second: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_PROCESSING_GAP_RECOVER_PER_SECOND'),
      25,
      0,
      100_000_000
    ),
    processing_gap_sample_per_second: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_PROCESSING_GAP_SAMPLE_PER_SECOND'),
      250,
      0,
      100_000_000
    ),
    processing_gap_off_per_second: envNumber(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_PROCESSING_GAP_OFF_PER_SECOND'),
      1_000,
      0,
      100_000_000
    ),
    failure_samples_to_off: envInteger(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_FAILURE_SAMPLES_TO_OFF'),
      3,
      1,
      60
    ),
    recovery_samples: envInteger(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_RECOVERY_SAMPLES'),
      5,
      1,
      600
    )
  };
  new KamailioHepHighWaterStateMachine(policy);
  return {
    poll_interval_ms: envInteger(
      resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_POLL_INTERVAL_MS'),
      1_000,
      100,
      60_000
    ),
    metrics_endpoint: metricsEndpoint,
    metrics_timeout_ms: metricsTimeoutMs,
    policy
  };
}

function envBoolean(
  value: string | undefined,
  fallback: boolean,
  label: string
): boolean {
  if (value == null || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${label} must be true or false`);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Kamailio route time is invalid');
  return value;
}

async function boundedCoreMetricsResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAXIMUM_CORE_METRICS_BYTES) {
    throw new Error('Kamailio core metrics response is too large');
  }
  if (!response.body) throw new Error('Kamailio core metrics response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAXIMUM_CORE_METRICS_BYTES) {
        await reader.cancel();
        throw new Error('Kamailio core metrics response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error('Kamailio core metrics response is empty');
  const body = Buffer.concat(chunks, length).toString('utf8');
  if (body.includes('\0')) throw new Error('Kamailio core metrics response is invalid');
  return body.endsWith('\n') ? body : `${body}\n`;
}

async function sendRouteAgentMetrics(input: {
  response: import('node:http').ServerResponse;
  own_metrics: string;
  read_core_metrics?: () => Promise<string>;
  supplemental_metrics?: () => string;
}): Promise<void> {
  let coreMetrics = '';
  let coreMetricsUp = 0;
  if (input.read_core_metrics) {
    try {
      coreMetrics = checkedCoreMetricsText(await input.read_core_metrics());
      coreMetricsUp = 1;
    } catch {
      coreMetrics = '';
    }
  }
  let supplementalMetrics = '';
  if (input.supplemental_metrics) {
    try {
      supplementalMetrics = checkedCoreMetricsText(input.supplemental_metrics());
    } catch {
      supplementalMetrics = '';
    }
  }
  const body = `${input.own_metrics}` +
    '# HELP ivekit_kamailio_core_metrics_up Whether Kamailio core metrics were read.\n' +
    '# TYPE ivekit_kamailio_core_metrics_up gauge\n' +
    `ivekit_kamailio_core_metrics_up ${coreMetricsUp}\n` +
    coreMetrics +
    supplementalMetrics;
  input.response.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  input.response.end(body);
}

function checkedCoreMetricsText(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
      Buffer.byteLength(value) > MAXIMUM_CORE_METRICS_BYTES) {
    throw new Error('Kamailio core metrics response is empty, invalid or too large');
  }
  return value.endsWith('\n') ? value : `${value}\n`;
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  value: unknown
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function safeLogMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]/g, ' ').slice(0, 512);
}
