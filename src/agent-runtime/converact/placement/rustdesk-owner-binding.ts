import { resolveFabricEnv } from '../../../config/converact-env.js';
import { timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server
} from 'node:http';
import { dirname } from 'node:path';

export interface RustDeskOwnerBinding {
  target_id: string;
  interaction_id: string;
  reservation_id: string;
  owner_node_id: string;
  owner_epoch: string;
  status: 'pending' | 'claimed';
  relay_uuid?: string;
  expires_at: string;
}

export interface RustDeskOwnerPlacement {
  owner_node_id: string;
  reservation_id: string;
  owner_epoch: string;
}

export interface RustDeskOwnerBindingPreparePort {
  prepare(input: {
    owner: RustDeskOwnerPlacement;
    interaction_id: string;
    target_id: string;
  }): Promise<RustDeskOwnerBinding>;
}

export class RustDeskOwnerBindingError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false
  ) {
    super(code);
  }
}

export class RustDeskOwnerBindingRegistry {
  readonly #nodeId: string;
  readonly #maxBindings: number;
  readonly #claimedTtlMs: number;
  readonly #byReservation = new Map<string, RustDeskOwnerBinding>();
  readonly #pendingByTarget = new Map<string, string>();
  readonly #reservationByRelay = new Map<string, string>();

  constructor(input: {
    node_id: string;
    max_bindings?: number;
    claimed_ttl_ms?: number;
    checkpoint?: unknown;
    now?: () => Date;
  }) {
    this.#nodeId = identifier(input.node_id, 'RustDesk owner node ID');
    this.#maxBindings = integer(
      input.max_bindings ?? 4_096,
      1,
      100_000,
      'RustDesk owner binding limit'
    );
    this.#claimedTtlMs = integer(
      input.claimed_ttl_ms ?? 120_000,
      30_000,
      3_600_000,
      'RustDesk claimed binding TTL'
    );
    if (input.checkpoint !== undefined) {
      this.#restore(input.checkpoint, checkedDate(input.now?.() ?? new Date()));
    }
  }

  prepare(input: {
    target_id: string;
    interaction_id: string;
    reservation_id: string;
    owner_node_id: string;
    owner_epoch: string;
    expires_at: string;
  }, now = new Date()): RustDeskOwnerBinding {
    this.#prune(now);
    const binding: RustDeskOwnerBinding = {
      target_id: identifier(input.target_id, 'RustDesk target ID'),
      interaction_id: identifier(input.interaction_id, 'RustDesk interaction ID'),
      reservation_id: identifier(input.reservation_id, 'RustDesk reservation ID'),
      owner_node_id: identifier(input.owner_node_id, 'RustDesk owner node ID'),
      owner_epoch: ownerEpoch(input.owner_epoch),
      status: 'pending',
      expires_at: futureTimestamp(input.expires_at, now, 'RustDesk binding expiry')
    };
    if (binding.owner_node_id !== this.#nodeId) {
      throw new RustDeskOwnerBindingError('rustdesk_owner_node_mismatch', 409);
    }
    const existing = this.#byReservation.get(binding.reservation_id);
    if (existing) {
      if (!samePreparedBinding(existing, binding)) {
        throw new RustDeskOwnerBindingError('rustdesk_binding_conflict', 409);
      }
      return structuredClone(existing);
    }
    const pendingReservation = this.#pendingByTarget.get(binding.target_id);
    if (pendingReservation && pendingReservation !== binding.reservation_id) {
      throw new RustDeskOwnerBindingError('rustdesk_target_binding_pending', 409, true);
    }
    if (this.#byReservation.size >= this.#maxBindings) {
      throw new RustDeskOwnerBindingError('rustdesk_binding_capacity_exhausted', 503, true);
    }
    this.#byReservation.set(binding.reservation_id, binding);
    this.#pendingByTarget.set(binding.target_id, binding.reservation_id);
    return structuredClone(binding);
  }

  claim(input: {
    target_id: string;
    relay_uuid: string;
  }, now = new Date()): RustDeskOwnerBinding {
    this.#prune(now);
    const targetId = identifier(input.target_id, 'RustDesk target ID');
    const relayUuid = identifier(input.relay_uuid, 'RustDesk relay UUID');
    const existingReservation = this.#reservationByRelay.get(relayUuid);
    if (existingReservation) {
      const existing = this.#byReservation.get(existingReservation);
      if (!existing || existing.target_id !== targetId) {
        throw new RustDeskOwnerBindingError('rustdesk_relay_binding_conflict', 409);
      }
      return structuredClone(existing);
    }
    const reservationId = this.#pendingByTarget.get(targetId);
    if (!reservationId) {
      throw new RustDeskOwnerBindingError('rustdesk_pending_binding_not_found', 404);
    }
    const binding = this.#byReservation.get(reservationId);
    if (!binding || binding.status !== 'pending') {
      throw new RustDeskOwnerBindingError('rustdesk_pending_binding_not_found', 404);
    }
    binding.status = 'claimed';
    binding.relay_uuid = relayUuid;
    binding.expires_at = new Date(now.getTime() + this.#claimedTtlMs).toISOString();
    this.#pendingByTarget.delete(targetId);
    this.#reservationByRelay.set(relayUuid, reservationId);
    return structuredClone(binding);
  }

  resolve(relayUuid: string, now = new Date()): RustDeskOwnerBinding {
    this.#prune(now);
    const normalized = identifier(relayUuid, 'RustDesk relay UUID');
    const reservationId = this.#reservationByRelay.get(normalized);
    const binding = reservationId ? this.#byReservation.get(reservationId) : undefined;
    if (!binding || binding.status !== 'claimed' || binding.relay_uuid !== normalized) {
      throw new RustDeskOwnerBindingError('rustdesk_relay_binding_not_found', 404);
    }
    return structuredClone(binding);
  }

  close(relayUuid: string, now = new Date()): boolean {
    this.#prune(now);
    const normalized = identifier(relayUuid, 'RustDesk relay UUID');
    const reservationId = this.#reservationByRelay.get(normalized);
    if (!reservationId) return false;
    this.#delete(reservationId);
    return true;
  }

  snapshot(now = new Date()): {
    node_id: string;
    pending: number;
    claimed: number;
    total: number;
  } {
    this.#prune(now);
    let pending = 0;
    let claimed = 0;
    for (const binding of this.#byReservation.values()) {
      if (binding.status === 'pending') pending += 1;
      else claimed += 1;
    }
    return {
      node_id: this.#nodeId,
      pending,
      claimed,
      total: pending + claimed
    };
  }

  checkpoint(now = new Date()): {
    schema_version: 1;
    node_id: string;
    bindings: RustDeskOwnerBinding[];
  } {
    this.#prune(now);
    return {
      schema_version: 1,
      node_id: this.#nodeId,
      bindings: [...this.#byReservation.values()]
        .map((binding) => structuredClone(binding))
        .sort((left, right) => left.reservation_id.localeCompare(right.reservation_id))
    };
  }

  #restore(raw: unknown, now: Date): void {
    const checkpoint = object(raw);
    if (checkpoint.schema_version !== 1 || checkpoint.node_id !== this.#nodeId ||
        !Array.isArray(checkpoint.bindings)) {
      throw new RustDeskOwnerBindingError('rustdesk_binding_checkpoint_invalid', 500);
    }
    for (const value of checkpoint.bindings) {
      const input = object(value);
      try {
        const status = input.status;
        if (status !== 'pending' && status !== 'claimed') {
          throw new RustDeskOwnerBindingError('rustdesk_binding_checkpoint_invalid', 500);
        }
        const normalized = {
          target_id: identifier(input.target_id, 'RustDesk target ID'),
          interaction_id: identifier(input.interaction_id, 'RustDesk interaction ID'),
          reservation_id: identifier(input.reservation_id, 'RustDesk reservation ID'),
          owner_node_id: identifier(input.owner_node_id, 'RustDesk owner node ID'),
          owner_epoch: ownerEpoch(input.owner_epoch),
          expires_at: timestamp(input.expires_at, 'RustDesk binding expiry')
        };
        const relayUuid = status === 'claimed'
          ? identifier(input.relay_uuid, 'RustDesk relay UUID')
          : '';
        if (Date.parse(normalized.expires_at) <= now.getTime()) continue;
        const binding = this.prepare({
          ...normalized
        }, now);
        if (status === 'claimed') {
          this.claim({
            target_id: binding.target_id,
            relay_uuid: relayUuid
          }, now);
          const restored = this.#byReservation.get(binding.reservation_id)!;
          restored.expires_at = normalized.expires_at;
        }
      } catch (error) {
        if (error instanceof RustDeskOwnerBindingError &&
            error.code === 'rustdesk_binding_checkpoint_invalid') {
          throw error;
        }
        throw new RustDeskOwnerBindingError('rustdesk_binding_checkpoint_invalid', 500);
      }
    }
  }

  #prune(now: Date): void {
    const nowMs = now.getTime();
    for (const [reservationId, binding] of this.#byReservation) {
      if (new Date(binding.expires_at).getTime() <= nowMs) this.#delete(reservationId);
    }
  }

  #delete(reservationId: string): void {
    const binding = this.#byReservation.get(reservationId);
    if (!binding) return;
    this.#byReservation.delete(reservationId);
    if (this.#pendingByTarget.get(binding.target_id) === reservationId) {
      this.#pendingByTarget.delete(binding.target_id);
    }
    if (binding.relay_uuid &&
        this.#reservationByRelay.get(binding.relay_uuid) === reservationId) {
      this.#reservationByRelay.delete(binding.relay_uuid);
    }
  }
}

export function createRustDeskOwnerBindingHttpServer(input: {
  registry: RustDeskOwnerBindingRegistry;
  service_token: string;
  checkpoint_path?: string;
  max_body_bytes?: number;
  now?: () => Date;
}): Server {
  const token = serviceToken(input.service_token);
  const maxBodyBytes = integer(
    input.max_body_bytes ?? 65_536,
    128,
    1_048_576,
    'RustDesk owner binding body limit'
  );
  const now = input.now || (() => new Date());
  const persist = () => {
    if (!input.checkpoint_path) return;
    persistCheckpoint(input.checkpoint_path, input.registry.checkpoint(now()));
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/livez') {
        return sendJson(response, 200, { status: 'alive' });
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        return sendJson(response, 200, {
          status: 'ready',
          ...input.registry.snapshot(now())
        });
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        const snapshot = input.registry.snapshot(now());
        response.statusCode = 200;
        response.setHeader('content-type', 'text/plain; version=0.0.4');
        return response.end([
          '# TYPE ivekit_rustdesk_owner_bindings gauge',
          `ivekit_rustdesk_owner_bindings{state="pending"} ${snapshot.pending}`,
          `ivekit_rustdesk_owner_bindings{state="claimed"} ${snapshot.claimed}`,
          ''
        ].join('\n'));
      }
      requireToken(request.headers, token);
      const body = object(await readJsonBody(request, maxBodyBytes));
      if (request.method === 'POST' && url.pathname === '/v1/bindings/prepare') {
        const binding = input.registry.prepare({
          target_id: String(body.target_id || ''),
          interaction_id: String(body.interaction_id || ''),
          reservation_id: String(body.reservation_id || ''),
          owner_node_id: String(body.owner_node_id || ''),
          owner_epoch: String(body.owner_epoch || ''),
          expires_at: String(body.expires_at || '')
        }, now());
        persist();
        return sendJson(response, 200, { data: binding });
      }
      if (request.method === 'POST' && url.pathname === '/v1/bindings/claim') {
        const binding = input.registry.claim({
          target_id: String(body.target_id || ''),
          relay_uuid: String(body.relay_uuid || '')
        }, now());
        persist();
        return sendJson(response, 200, { data: binding });
      }
      if (request.method === 'POST' && url.pathname === '/v1/relays/resolve') {
        return sendJson(response, 200, {
          data: input.registry.resolve(String(body.relay_uuid || ''), now())
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/relays/close') {
        const closed = input.registry.close(String(body.relay_uuid || ''), now());
        persist();
        return sendJson(response, 200, { data: { closed } });
      }
      return sendJson(response, 404, {
        error: { code: 'not_found', retryable: false }
      });
    } catch (error) {
      const projected = error instanceof RustDeskOwnerBindingError
        ? error
        : new RustDeskOwnerBindingError('rustdesk_owner_binding_internal', 500);
      return sendJson(response, projected.status, {
        error: { code: projected.code, retryable: projected.retryable }
      });
    }
  });
}

export class HttpRustDeskOwnerBindingPrepareClient
implements RustDeskOwnerBindingPreparePort {
  readonly #nodes: Record<string, { endpoint: URL; token: string }>;
  readonly #timeoutMs: number;
  readonly #pendingTtlMs: number;
  readonly #fetch: typeof fetch;

  constructor(input: {
    nodes: Record<string, { endpoint: string; token: string }>;
    timeout_ms?: number;
    pending_ttl_ms?: number;
    fetch?: typeof fetch;
  }) {
    this.#nodes = Object.fromEntries(Object.entries(input.nodes).map(([nodeId, value]) => [
      identifier(nodeId, 'RustDesk owner node ID'),
      {
        endpoint: httpEndpoint(value.endpoint),
        token: serviceToken(value.token)
      }
    ]));
    this.#timeoutMs = integer(
      input.timeout_ms ?? 2_000,
      100,
      30_000,
      'RustDesk owner binding timeout'
    );
    this.#pendingTtlMs = integer(
      input.pending_ttl_ms ?? 120_000,
      30_000,
      900_000,
      'RustDesk pending binding TTL'
    );
    this.#fetch = input.fetch || globalThis.fetch;
  }

  async prepare(input: {
    owner: RustDeskOwnerPlacement;
    interaction_id: string;
    target_id: string;
  }): Promise<RustDeskOwnerBinding> {
    const node = this.#nodes[input.owner.owner_node_id];
    if (!node) {
      throw new RustDeskOwnerBindingError('rustdesk_owner_binding_endpoint_missing', 503);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(
        new URL('/v1/bindings/prepare', node.endpoint),
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${node.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            target_id: input.target_id,
            interaction_id: input.interaction_id,
            reservation_id: input.owner.reservation_id,
            owner_node_id: input.owner.owner_node_id,
            owner_epoch: input.owner.owner_epoch,
            expires_at: new Date(Date.now() + this.#pendingTtlMs).toISOString()
          })
        }
      );
      const payload = object(await response.json());
      if (!response.ok) {
        const error = object(payload.error);
        throw new RustDeskOwnerBindingError(
          String(error.code || 'rustdesk_owner_binding_failed'),
          response.status,
          error.retryable === true
        );
      }
      return structuredClone(object(payload.data)) as unknown as RustDeskOwnerBinding;
    } catch (error) {
      if (error instanceof RustDeskOwnerBindingError) throw error;
      const aborted = (error as { name?: unknown })?.name === 'AbortError';
      throw new RustDeskOwnerBindingError(
        aborted ? 'rustdesk_owner_binding_timeout' : 'rustdesk_owner_binding_unavailable',
        503,
        true
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function rustDeskOwnerBindingPrepareClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): HttpRustDeskOwnerBindingPrepareClient | null {
  const raw = String(resolveFabricEnv(env, 'RUSTDESK_OWNER_RUNTIME_JSON') || '').trim();
  const defaultToken = String(resolveFabricEnv(env, 'RUSTDESK_OWNER_BINDING_TOKEN') || '').trim();
  if (!raw) return null;
  const runtime = object(JSON.parse(raw));
  const nodes: Record<string, { endpoint: string; token: string }> = {};
  for (const [nodeId, value] of Object.entries(runtime)) {
    const config = object(value);
    const endpoint = String(config.owner_binding_endpoint || '').trim();
    const token = String(config.owner_binding_token || defaultToken).trim();
    if (endpoint || token) {
      nodes[nodeId] = { endpoint, token };
    }
  }
  if (!Object.keys(nodes).length) return null;
  return new HttpRustDeskOwnerBindingPrepareClient({ nodes });
}

export function rustDeskOwnerBindingCheckpointFromFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function persistCheckpoint(path: string, checkpoint: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function samePreparedBinding(
  existing: RustDeskOwnerBinding,
  prepared: RustDeskOwnerBinding
): boolean {
  return existing.target_id === prepared.target_id &&
    existing.interaction_id === prepared.interaction_id &&
    existing.reservation_id === prepared.reservation_id &&
    existing.owner_node_id === prepared.owner_node_id &&
    existing.owner_epoch === prepared.owner_epoch;
}

function requireToken(headers: IncomingHttpHeaders, expected: string): void {
  const value = String(headers.authorization || '');
  const provided = value.startsWith('Bearer ') ? value.slice(7) : '';
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new RustDeskOwnerBindingError('unauthorized', 401);
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) {
      throw new RustDeskOwnerBindingError('request_body_too_large', 413);
    }
    chunks.push(buffer);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RustDeskOwnerBindingError('invalid_json', 400);
  }
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function identifier(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(normalized)) {
    throw new RustDeskOwnerBindingError(
      `${field.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_invalid`,
      400
    );
  }
  return normalized;
}

function ownerEpoch(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(normalized) ||
      BigInt(normalized) > 0xffff_ffff_ffff_ffffn) {
    throw new RustDeskOwnerBindingError('rustdesk_owner_epoch_invalid', 400);
  }
  return normalized;
}

function futureTimestamp(value: unknown, now: Date, field: string): string {
  const normalized = timestamp(value, field);
  if (Date.parse(normalized) <= checkedDate(now).getTime()) {
    throw new RustDeskOwnerBindingError(
      `${field.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_invalid`,
      400
    );
  }
  return normalized;
}

function timestamp(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  const parsed = new Date(normalized);
  if (!normalized || !Number.isFinite(parsed.getTime())) {
    throw new RustDeskOwnerBindingError(
      `${field.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_invalid`,
      400
    );
  }
  return parsed.toISOString();
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RustDeskOwnerBindingError('rustdesk_owner_binding_clock_invalid', 500);
  }
  return value;
}

function serviceToken(value: unknown): string {
  const normalized = String(value || '').trim();
  if (normalized.length < 16 || normalized.length > 512) {
    throw new RustDeskOwnerBindingError('rustdesk_owner_binding_token_invalid', 500);
  }
  return normalized;
}

function httpEndpoint(value: unknown): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(String(value || '').trim());
  } catch {
    throw new RustDeskOwnerBindingError('rustdesk_owner_binding_endpoint_invalid', 500);
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password) {
    throw new RustDeskOwnerBindingError('rustdesk_owner_binding_endpoint_invalid', 500);
  }
  return endpoint;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RustDeskOwnerBindingError(
      `${field.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_invalid`,
      500
    );
  }
  return normalized;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
