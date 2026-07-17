import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  CellAdmissionController,
  type CellAdmissionReservationCheckpoint
} from './admission.js';
import {
  PlacementError,
  type AdmissionReservation,
  type CellAdmissionPort,
  type CellAdmissionRequest,
  type CellReservationLifecyclePort
} from './types.js';

interface CellAdmissionHttpServerInput {
  controller: CellAdmissionController;
  service_token: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  cell_lease_epoch: number;
  max_body_bytes?: number;
  now?: () => Date;
  can_accept?: () => boolean;
  persistence?: {
    persist(
      checkpoint: CellAdmissionReservationCheckpoint,
      now: Date
    ): Promise<void>;
  };
  node_sync?: {
    applyCheckpoint(
      checkpoint: CellAdmissionReservationCheckpoint,
      now: Date
    ): Promise<void>;
  };
}

interface CellAdmissionStandbyHttpServerInput {
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_instance_id: string;
}

export interface CellAdmissionStateSnapshot {
  state: import('./types.js').AdmissionState;
  cell_lease_epoch: number;
  nodes: Array<{
    node_id: string;
    state: import('./types.js').AdmissionState;
    recovery_safe_after: string;
  }>;
  reservations: Array<{
    reservation_id: string;
    state: import('./types.js').ReservationState;
    owner_node_id: string;
    owner_epoch: string;
  }>;
}

export function createCellAdmissionStandbyHttpServer(
  input: CellAdmissionStandbyHttpServerInput
): Server {
  for (const value of [
    input.region_id,
    input.zone_id,
    input.cell_id,
    input.owner_instance_id
  ]) safeIdentifier(value);
  const identity = structuredClone(input);
  return createServer((request, response) => {
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`
    );
    if (request.method === 'GET' && url.pathname === '/livez') {
      return sendJson(response, 200, {
        status: 'alive',
        role: 'standby',
        ...identity
      });
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      return sendJson(response, 503, {
        status: 'not_ready',
        role: 'standby',
        ...identity
      });
    }
    request.resume();
    return sendJson(response, 503, {
      error: {
        code: 'cell_admission_standby',
        retryable: true
      }
    });
  });
}

export function createCellAdmissionHttpServer(
  input: CellAdmissionHttpServerInput
): Server {
  const config = validatedServerInput(input);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/livez') {
        return sendJson(response, 200, { status: 'alive' });
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const state = config.controller.snapshot().state;
        const capacityFresh = config.controller.isCapacityFresh(config.now());
        const ready = (state === 'accepting' || state === 'degraded') &&
          capacityFresh;
        return sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          state,
          capacity_fresh: capacityFresh,
          region_id: config.region_id,
          zone_id: config.zone_id,
          cell_id: config.cell_id,
          cell_lease_epoch: config.cell_lease_epoch
        });
      }
      requireServiceToken(request.headers, config.service_token);
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        return sendJson(response, 200, { data: config.controller.snapshot() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/state') {
        const body = object(await readJsonBody(request, config.max_body_bytes));
        const state = admissionState(body.state);
        if ((state === 'accepting' || state === 'degraded') &&
            !config.can_accept()) {
          throw new PlacementError({
            code: 'cell_lease_lost',
            status: 409,
            retryable: true
          });
        }
        if ((state === 'accepting' || state === 'degraded') &&
            !config.controller.isCapacityFresh(config.now())) {
          throw new PlacementError({
            code: 'capacity_stale',
            status: 409,
            retryable: true
          });
        }
        config.controller.setState(state, config.now());
        return sendJson(response, 200, { data: config.controller.snapshot() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/capacity') {
        const body = object(await readJsonBody(request, config.max_body_bytes));
        validateCapacityTarget(body, config);
        config.controller.applyCapacityObservation(
          structuredClone(body) as import('./types.js').CellCapacityObservation,
          config.now()
        );
        return sendJson(response, 200, { data: config.controller.snapshot() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/drain') {
        await readJsonBody(request, config.max_body_bytes);
        config.controller.startDrain(config.now());
        return sendJson(response, 200, { data: config.controller.snapshot() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/reservations') {
        const body = await readJsonBody(request, config.max_body_bytes);
        const reservationRequest = validateReservationRequest(body, config);
        const {
          region_id: _regionId,
          zone_id: _zoneId,
          cell_id: _cellId,
          snapshot_version: _snapshotVersion,
          cell_lease_epoch: _cellLeaseEpoch,
          ...localRequest
        } = reservationRequest;
        const now = config.now();
        const reservation = config.controller.reserve(localRequest, now);
        await persistCheckpoint(config, reservation.reservation_id, now);
        return sendJson(response, 201, {
          data: reservation
        });
      }
      const lifecycle = url.pathname.match(
        /^\/v1\/reservations\/([^/]+)\/(activate|close)$/
      );
      if (request.method === 'POST' && lifecycle) {
        await readJsonBody(request, config.max_body_bytes);
        const reservationId = decodeSegment(lifecycle[1]);
        const now = config.now();
        const result = lifecycle[2] === 'activate'
          ? config.controller.activate(reservationId, now)
          : config.controller.close(reservationId, now);
        await persistCheckpoint(config, reservationId, now);
        return sendJson(response, 200, { data: result });
      }
      return sendJson(response, 404, {
        error: { code: 'not_found', retryable: false }
      });
    } catch (error) {
      const projected = projectError(error);
      return sendJson(response, projected.status, {
        error: {
          code: projected.code,
          retryable: projected.retryable
        }
      });
    }
  });
}

async function persistCheckpoint(
  config: ReturnType<typeof validatedServerInput>,
  reservationId: string,
  now: Date
): Promise<void> {
  if (!config.persistence && !config.node_sync) return;
  const checkpoint = config.controller.checkpoint(reservationId);
  const previous = config.persistence_tails.get(reservationId) || Promise.resolve();
  const persisted = previous.catch(() => undefined).then(async () => {
    await config.persistence?.persist(checkpoint, now);
    await config.node_sync?.applyCheckpoint(checkpoint, now);
  });
  config.persistence_tails.set(reservationId, persisted);
  try {
    await persisted;
  } catch (error) {
    const candidate = error as {
      code?: unknown;
      node_id?: unknown;
      status?: unknown;
      retryable?: unknown;
    };
    const nodeId = String(candidate.node_id || '');
    const code = safeErrorCode(candidate.code);
    if (nodeId && code.startsWith('component_node_')) {
      try {
        config.controller.setNodeState(nodeId, 'offline');
      } catch {
        // The failing target may already have been removed from this Cell.
      }
      throw new PlacementError({
        code,
        status: Number.isInteger(Number(candidate.status)) &&
          Number(candidate.status) >= 400 &&
          Number(candidate.status) <= 599
          ? Number(candidate.status)
          : 503,
        retryable: candidate.retryable !== false
      });
    }
    try {
      config.controller.startDrain(now);
    } catch {
      // An offline controller is already fail-closed.
    }
    throw new PlacementError({
      code: 'admission_persistence_failed',
      status: 503,
      retryable: true
    });
  } finally {
    if (config.persistence_tails.get(reservationId) === persisted) {
      config.persistence_tails.delete(reservationId);
    }
  }
}

export class HttpCellAdmissionClient
implements CellAdmissionPort, CellReservationLifecyclePort {
  readonly #endpoint: URL;
  readonly #serviceToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(input: {
    endpoint: string;
    service_token: string;
    timeout_ms?: number;
    fetch?: typeof fetch;
  }) {
    const endpoint = new URL(input.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username || endpoint.password) {
      throw new Error('invalid Cell admission endpoint');
    }
    this.#endpoint = endpoint;
    this.#serviceToken = safeServiceToken(input.service_token);
    const timeoutMs = input.timeout_ms ?? 2_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error('invalid Cell admission timeout');
    }
    this.#timeoutMs = timeoutMs;
    this.#fetch = input.fetch || globalThis.fetch;
  }

  async reserve(input: CellAdmissionRequest): Promise<AdmissionReservation> {
    return this.#request('/v1/reservations', input);
  }

  async activate(reservationId: string): Promise<AdmissionReservation> {
    safeIdentifier(reservationId);
    return this.#request(
      `/v1/reservations/${encodeURIComponent(reservationId)}/activate`,
      {}
    );
  }

  async close(reservationId: string): Promise<AdmissionReservation> {
    safeIdentifier(reservationId);
    return this.#request(
      `/v1/reservations/${encodeURIComponent(reservationId)}/close`,
      {}
    );
  }

  async state(): Promise<CellAdmissionStateSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(
        new URL('/v1/state', this.#endpoint),
        {
          method: 'GET',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.#serviceToken}`
          }
        }
      );
      const payload = await boundedJsonResponse(response);
      if (!response.ok) {
        const error = object(payload.error);
        throw new PlacementError({
          code: safeErrorCode(error.code),
          status: response.status,
          retryable: error.retryable === true
        });
      }
      return checkedAdmissionStateSnapshot(payload.data);
    } catch (error) {
      if (error instanceof PlacementError) throw error;
      const aborted = (error as { name?: unknown })?.name === 'AbortError';
      throw new PlacementError({
        code: aborted ? 'admission_timeout' : 'admission_unavailable',
        status: 503,
        retryable: true
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(
    path: string,
    body: CellAdmissionRequest | Record<string, never>
  ): Promise<AdmissionReservation> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(
        new URL(path, this.#endpoint),
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.#serviceToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(body)
        }
      );
      const payload = await boundedJsonResponse(response);
      if (!response.ok) {
        const error = object(payload.error);
        throw new PlacementError({
          code: safeErrorCode(error.code),
          status: response.status,
          retryable: error.retryable === true
        });
      }
      return object(payload.data) as unknown as AdmissionReservation;
    } catch (error) {
      if (error instanceof PlacementError) throw error;
      const aborted = (error as { name?: unknown })?.name === 'AbortError';
      throw new PlacementError({
        code: aborted ? 'admission_timeout' : 'admission_unavailable',
        status: 503,
        retryable: true
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function checkedAdmissionStateSnapshot(value: unknown): CellAdmissionStateSnapshot {
  const input = object(value);
  const state = admissionState(input.state);
  const cellLeaseEpoch = Number(input.cell_lease_epoch);
  if (!Number.isInteger(cellLeaseEpoch) ||
      cellLeaseEpoch < 1 ||
      cellLeaseEpoch > 0xffff_ffff) {
    throw new PlacementError({ code: 'admission_state_invalid', status: 502 });
  }
  if (!Array.isArray(input.nodes) || !Array.isArray(input.reservations)) {
    throw new PlacementError({ code: 'admission_state_invalid', status: 502 });
  }
  const nodes = input.nodes.map((value) => {
    const node = object(value);
    return {
      node_id: safeIdentifier(String(node.node_id || '')),
      state: admissionState(node.state),
      recovery_safe_after: optionalTimestamp(node.recovery_safe_after)
    };
  });
  const reservations = input.reservations.map((value) => {
    const reservation = object(value);
    const reservationState = String(reservation.state || '');
    if (!['reserved', 'active', 'expired', 'closed'].includes(reservationState) ||
        !/^(?:0|[1-9][0-9]{0,19})$/.test(String(reservation.owner_epoch || ''))) {
      throw new PlacementError({ code: 'admission_state_invalid', status: 502 });
    }
    return {
      reservation_id: safeIdentifier(String(reservation.reservation_id || '')),
      state: reservationState as import('./types.js').ReservationState,
      owner_node_id: safeIdentifier(String(reservation.owner_node_id || '')),
      owner_epoch: String(reservation.owner_epoch)
    };
  });
  return {
    state,
    cell_lease_epoch: cellLeaseEpoch,
    nodes,
    reservations
  };
}

function optionalTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) {
    throw new PlacementError({ code: 'admission_state_invalid', status: 502 });
  }
  return new Date(timestamp).toISOString();
}

function validatedServerInput(input: CellAdmissionHttpServerInput) {
  safeIdentifier(input.region_id);
  safeIdentifier(input.zone_id);
  safeIdentifier(input.cell_id);
  if (!Number.isInteger(input.cell_lease_epoch) ||
      input.cell_lease_epoch < 1 || input.cell_lease_epoch > 0xffff_ffff) {
    throw new Error('invalid Cell admission lease epoch');
  }
  const maxBodyBytes = input.max_body_bytes ?? 65_536;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 128 || maxBodyBytes > 1_048_576) {
    throw new Error('invalid Cell admission body limit');
  }
  return {
    ...input,
    service_token: safeServiceToken(input.service_token),
    max_body_bytes: maxBodyBytes,
    now: input.now || (() => new Date()),
    can_accept: input.can_accept || (() => true),
    persistence_tails: new Map<string, Promise<void>>()
  };
}

function validateReservationRequest(
  value: unknown,
  config: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    cell_lease_epoch: number;
  }
): CellAdmissionRequest {
  const input = object(value);
  if (input.region_id !== config.region_id ||
      input.zone_id !== config.zone_id ||
      input.cell_id !== config.cell_id) {
    throw new PlacementError({
      code: 'admission_target_mismatch',
      status: 409,
      retryable: true
    });
  }
  if (input.cell_lease_epoch !== config.cell_lease_epoch) {
    throw new PlacementError({
      code: 'stale_cell_lease_epoch',
      status: 409,
      retryable: true
    });
  }
  if (!Number.isSafeInteger(input.snapshot_version) || Number(input.snapshot_version) < 1) {
    throw new PlacementError({ code: 'snapshot_version_invalid', status: 400 });
  }
  return structuredClone(input) as unknown as CellAdmissionRequest;
}

function validateCapacityTarget(
  input: Record<string, unknown>,
  config: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    cell_lease_epoch: number;
  }
): void {
  if (input.region_id !== config.region_id ||
      input.zone_id !== config.zone_id ||
      input.cell_id !== config.cell_id) {
    throw new PlacementError({
      code: 'admission_target_mismatch',
      status: 409,
      retryable: true
    });
  }
  if (input.cell_lease_epoch !== config.cell_lease_epoch) {
    throw new PlacementError({
      code: 'stale_cell_lease_epoch',
      status: 409,
      retryable: true
    });
  }
}

async function readJsonBody(
  request: import('node:http').IncomingMessage,
  maximumBytes: number
): Promise<unknown> {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maximumBytes) throw httpError('request_too_large', 413);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBytes) throw httpError('request_too_large', 413);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, total).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError('invalid_json', 400);
  }
}

async function boundedJsonResponse(
  response: Response
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > 65_536) {
    throw new Error('Cell admission response is too large');
  }
  return object(JSON.parse(text));
}

function requireServiceToken(
  headers: import('node:http').IncomingHttpHeaders,
  expected: string
): void {
  const supplied = String(headers.authorization || '');
  if (!safeEqual(supplied, `Bearer ${expected}`)) {
    throw httpError('authentication_required', 401);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

function safeServiceToken(value: string): string {
  if (!value || value.length < 24 || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error('invalid Cell admission service token');
  }
  return value;
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value)) {
    throw new Error('invalid Cell admission identifier');
  }
  return value;
}

function admissionState(value: unknown) {
  if (!['accepting', 'degraded', 'draining', 'offline'].includes(String(value))) {
    throw httpError('admission_state_invalid', 400);
  }
  return String(value) as import('./types.js').AdmissionState;
}

function safeErrorCode(value: unknown): string {
  const code = String(value || '');
  return /^[a-z][a-z0-9_]{1,127}$/.test(code)
    ? code
    : 'admission_unavailable';
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError('invalid_request', 400);
  }
  return value as Record<string, any>;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError('invalid_request', 400);
  }
}

function httpError(code: string, status: number): Error & {
  code: string;
  status: number;
  retryable: boolean;
} {
  return Object.assign(new Error(code), {
    code,
    status,
    retryable: false
  });
}

function projectError(error: unknown): {
  code: string;
  status: number;
  retryable: boolean;
} {
  if (error instanceof PlacementError) {
    return {
      code: error.code,
      status: error.status,
      retryable: error.retryable
    };
  }
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    retryable?: unknown;
  };
  const status = Number(candidate.status || 500);
  return {
    code: status >= 500 ? 'internal_error' : safeErrorCode(candidate.code),
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    retryable: candidate.retryable === true
  };
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}
