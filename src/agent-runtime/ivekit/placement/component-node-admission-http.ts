import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type RequestListener,
  type Server
} from 'node:http';
import {
  createServer as createSecureServer,
  request as requestHttps,
  type RequestOptions as HttpsRequestOptions
} from 'node:https';

import type {
  CellAdmissionReservationCheckpoint
} from './admission.js';
import {
  ComponentNodeAdmissionController,
  ComponentNodeAdmissionError,
  type ComponentNodeAuthorization,
  type ComponentNodeBatchAuthorizationResult,
  type ComponentNodeAuthorizationInput,
  type ComponentNodeLeaseHeartbeat,
  type ComponentNodeStateSnapshot
} from './component-node-admission.js';

export interface ComponentNodeAdmissionTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
  ca: string | Buffer | Array<string | Buffer>;
}

export interface ComponentNodeAdmissionClientTlsOptions
extends ComponentNodeAdmissionTlsOptions {
  servername?: string;
}

export interface ComponentNodeAdditionalReadiness {
  ready: boolean;
  failure_stages?: readonly string[];
  route_snapshot?: unknown;
  media_control?: unknown;
  profiles?: unknown;
}

export function createComponentNodeAdmissionHttpServer(input: {
  controller: ComponentNodeAdmissionController;
  service_token: string;
  production?: boolean;
  tls?: ComponentNodeAdmissionTlsOptions;
  max_body_bytes?: number;
  now?: () => Date;
  before_new_reservation?: (
    checkpoint: CellAdmissionReservationCheckpoint,
    now: Date
  ) => void | Promise<void>;
  readiness?: (
    state: ComponentNodeStateSnapshot,
    now: Date
  ) => ComponentNodeAdditionalReadiness |
    Promise<ComponentNodeAdditionalReadiness>;
  additional_metrics?: (now: Date) => string;
}): Server {
  if (input.production && !input.tls) {
    throw new Error('component node production mTLS is required');
  }
  if (input.tls) validateTls(input.tls);
  const config = {
    controller: input.controller,
    service_token: safeToken(input.service_token),
    max_body_bytes: boundedInteger(
      input.max_body_bytes ?? 65_536,
      128,
      1_048_576,
      'component node body limit'
    ),
    now: input.now || (() => new Date()),
    before_new_reservation: input.before_new_reservation,
    readiness: input.readiness,
    additional_metrics: input.additional_metrics
  };
  const handler: RequestListener = async (
    request,
    response
  ) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/livez') {
        return sendJson(response, 200, { status: 'alive' });
      }
      if (request.method === 'GET' && url.pathname === '/operationalz') {
        const now = config.now();
        const state = config.controller.snapshot(now);
        const readiness = await additionalReadiness(
          config.readiness,
          state,
          now
        );
        const operational = state.lease_fresh && !state.recovery_pending &&
          readiness.ready;
        return sendJson(response, operational ? 200 : 503, {
          status: operational ? 'operational' : 'not_operational',
          state: state.state,
          lease_fresh: state.lease_fresh,
          recovery_pending: state.recovery_pending,
          component: state.component,
          node_id: state.node_id,
          cell_lease_epoch: state.cell_lease_epoch,
          state_sequence: state.state_sequence,
          readiness
        });
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const now = config.now();
        const state = config.controller.snapshot(now);
        const readiness = await additionalReadiness(
          config.readiness,
          state,
          now
        );
        const ready = state.lease_fresh && !state.recovery_pending &&
          (state.state === 'accepting' || state.state === 'degraded') &&
          readiness.ready;
        return sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          state: state.state,
          lease_fresh: state.lease_fresh,
          recovery_pending: state.recovery_pending,
          component: state.component,
          node_id: state.node_id,
          cell_lease_epoch: state.cell_lease_epoch,
          state_sequence: state.state_sequence,
          readiness
        });
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        const now = config.now();
        return sendMetrics(response, renderMetrics(
          config.controller.snapshot(now),
          config.controller.routeDrainActive(),
          config.additional_metrics?.(now) || ''
        ));
      }

      requireToken(request.headers, config.service_token);
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        return sendJson(response, 200, {
          data: config.controller.snapshot(config.now())
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/lease') {
        const body = await readJsonBody(request, config.max_body_bytes);
        return sendJson(response, 200, {
          data: config.controller.applyLease(
            structuredClone(object(body)) as unknown as ComponentNodeLeaseHeartbeat,
            config.now()
          )
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/drain') {
        const body = object(await readJsonBody(request, config.max_body_bytes));
        const drain = config.controller.startRouteDrain(config.now());
        const propagationDelayMs = optionalBoundedInteger(
          body.propagation_delay_ms,
          0,
          60_000,
          'component drain propagation delay'
        );
        const waitForReservationsMs = optionalBoundedInteger(
          body.wait_for_reservations_ms,
          0,
          3_600_000,
          'component drain reservation timeout'
        );
        const pollIntervalMs = optionalBoundedInteger(
          body.poll_interval_ms,
          50,
          5_000,
          'component drain poll interval',
          250
        );
        const drained = await waitForReservationDrain({
          controller: config.controller,
          now: config.now,
          propagation_delay_ms: propagationDelayMs,
          wait_for_reservations_ms: waitForReservationsMs,
          poll_interval_ms: pollIntervalMs
        });
        return sendJson(response, drained ? 200 : 503, {
          data: drain,
          drained
        });
      }
      const recoveryReservation = url.pathname.match(
        /^\/v1\/recovery\/reservations\/([^/]+)$/
      );
      if (request.method === 'PUT' && recoveryReservation) {
        const reservationId = decodeSegment(recoveryReservation[1]);
        const body = object(
          await readJsonBody(request, config.max_body_bytes)
        );
        if (JSON.stringify(Object.keys(body).sort()) !==
            JSON.stringify(['cell_lease_epoch', 'checkpoint'])) {
          throw new ComponentNodeAdmissionError(
            'component_node_recovery_request_invalid',
            400
          );
        }
        const checkpoint = structuredClone(
          object(body.checkpoint)
        ) as unknown as CellAdmissionReservationCheckpoint;
        if (checkpoint.reservation_id !== reservationId) {
          throw new ComponentNodeAdmissionError(
            'component_reservation_path_mismatch',
            409
          );
        }
        return sendJson(response, 200, {
          data: config.controller.applyRecoveryReservation(
            checkpoint,
            config.now(),
            requiredBoundedInteger(
              body.cell_lease_epoch,
              1,
              0xffff_ffff,
              'component node recovery Cell lease epoch'
            )
          )
        });
      }
      const reservation = url.pathname.match(/^\/v1\/reservations\/([^/]+)$/);
      if (request.method === 'PUT' && reservation) {
        const reservationId = decodeSegment(reservation[1]);
        const body = structuredClone(
          object(await readJsonBody(request, config.max_body_bytes))
        ) as unknown as CellAdmissionReservationCheckpoint;
        if (body.reservation_id !== reservationId) {
          throw new ComponentNodeAdmissionError(
            'component_reservation_path_mismatch',
            409
          );
        }
        if (!config.controller.hasReservation(reservationId)) {
          await config.before_new_reservation?.(body, config.now());
        }
        return sendJson(response, 200, {
          data: config.controller.applyReservation(body, config.now())
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/authorize') {
        const body = structuredClone(
          object(await readJsonBody(request, config.max_body_bytes))
        ) as unknown as ComponentNodeAuthorizationInput;
        return sendJson(response, 200, {
          data: config.controller.authorize(body, config.now())
        });
      }
      if (request.method === 'POST' &&
          url.pathname === '/v1/authorize/batch') {
        const body = object(
          await readJsonBody(request, config.max_body_bytes)
        );
        if (!Array.isArray(body.requests)) {
          throw new ComponentNodeAdmissionError(
            'component_authorization_batch_invalid',
            400
          );
        }
        return sendJson(response, 200, {
          data: {
            results: config.controller.authorizeBatch(
              structuredClone(body.requests) as ComponentNodeAuthorizationInput[],
              config.now()
            )
          }
        });
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
  };
  return input.tls
    ? createSecureServer({
        key: input.tls.key,
        cert: input.tls.cert,
        ca: input.tls.ca,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      }, handler)
    : createServer(handler);
}

async function waitForReservationDrain(input: {
  controller: ComponentNodeAdmissionController;
  now: () => Date;
  propagation_delay_ms: number;
  wait_for_reservations_ms: number;
  poll_interval_ms: number;
}): Promise<boolean> {
  if (input.propagation_delay_ms > 0) {
    await delay(input.propagation_delay_ms);
  }
  input.controller.stopNewAdmissions();
  const deadline = Date.now() + input.wait_for_reservations_ms;
  do {
    const reservations = input.controller.snapshot(input.now()).reservations;
    if (reservations.reserved === 0 && reservations.active === 0) return true;
    if (input.wait_for_reservations_ms === 0 || Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(input.poll_interval_ms, Math.max(1, deadline - Date.now())));
  } while (true);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function optionalBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
  fallback = 0
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) ||
      (value as number) < minimum || (value as number) > maximum) {
    throw new ComponentNodeAdmissionError(
      `${field.replaceAll(' ', '_')}_invalid`,
      400
    );
  }
  return value as number;
}

function requiredBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) ||
      (value as number) < minimum || (value as number) > maximum) {
    throw new ComponentNodeAdmissionError(
      `${field.replaceAll(' ', '_')}_invalid`,
      400
    );
  }
  return value as number;
}

async function additionalReadiness(
  callback: ((
    state: ComponentNodeStateSnapshot,
    now: Date
  ) => ComponentNodeAdditionalReadiness |
    Promise<ComponentNodeAdditionalReadiness>) | undefined,
  state: ComponentNodeStateSnapshot,
  now: Date
): Promise<ComponentNodeAdditionalReadiness> {
  if (!callback) return { ready: true };
  try {
    const result = await callback(state, now);
    if (!result || typeof result !== 'object' ||
        typeof result.ready !== 'boolean') {
      return { ready: false, failure_stages: ['readiness_contract'] };
    }
    return structuredClone(result);
  } catch {
    return { ready: false, failure_stages: ['readiness_probe'] };
  }
}

export class HttpComponentNodeAdmissionClient {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #tls?: ComponentNodeAdmissionClientTlsOptions;

  constructor(input: {
    endpoint: string;
    service_token: string;
    production?: boolean;
    tls?: ComponentNodeAdmissionClientTlsOptions;
    timeout_ms?: number;
    fetch?: typeof fetch;
  }) {
    this.#endpoint = checkedEndpoint(input.endpoint);
    this.#token = safeToken(input.service_token);
    this.#timeoutMs = boundedInteger(
      input.timeout_ms ?? 2_000,
      100,
      30_000,
      'component node timeout'
    );
    this.#tls = input.tls;
    if (input.production &&
        (this.#endpoint.protocol !== 'https:' || !this.#tls)) {
      throw new Error('component node production mTLS is required');
    }
    if (this.#tls && this.#endpoint.protocol !== 'https:') {
      throw new Error('component node TLS requires an HTTPS endpoint');
    }
    if (this.#tls) validateTls(this.#tls);
    this.#fetch = input.fetch ||
      (this.#tls ? createMutualTlsFetch(this.#tls) : globalThis.fetch);
  }

  async applyLease(
    heartbeat: ComponentNodeLeaseHeartbeat
  ): Promise<ComponentNodeStateSnapshot> {
    const state = await this.#request<Record<string, unknown>>(
      '/v1/lease',
      'POST',
      heartbeat
    );
    return decodeComponentNodeState(state);
  }

  async readState(): Promise<ComponentNodeStateSnapshot> {
    const state = await this.#request<Record<string, unknown>>(
      '/v1/state',
      'GET'
    );
    return decodeComponentNodeState(state);
  }

  async applyReservation(
    checkpoint: CellAdmissionReservationCheckpoint
  ): Promise<CellAdmissionReservationCheckpoint> {
    return this.#request<CellAdmissionReservationCheckpoint>(
      `/v1/reservations/${encodeURIComponent(checkpoint.reservation_id)}`,
      'PUT',
      checkpoint
    );
  }

  async applyRecoveryReservation(
    checkpoint: CellAdmissionReservationCheckpoint,
    cellLeaseEpoch: number
  ): Promise<CellAdmissionReservationCheckpoint> {
    return this.#request<CellAdmissionReservationCheckpoint>(
      `/v1/recovery/reservations/${encodeURIComponent(checkpoint.reservation_id)}`,
      'PUT',
      {
        cell_lease_epoch: requiredBoundedInteger(
          cellLeaseEpoch,
          1,
          0xffff_ffff,
          'component node recovery Cell lease epoch'
        ),
        checkpoint
      }
    );
  }

  async authorize(
    input: ComponentNodeAuthorizationInput
  ): Promise<ComponentNodeAuthorization> {
    return this.#request<ComponentNodeAuthorization>(
      '/v1/authorize',
      'POST',
      input
    );
  }

  async authorizeBatch(
    inputs: ComponentNodeAuthorizationInput[]
  ): Promise<ComponentNodeBatchAuthorizationResult[]> {
    const data = await this.#request<{
      results: ComponentNodeBatchAuthorizationResult[];
    }>('/v1/authorize/batch', 'POST', { requests: inputs });
    if (!Array.isArray(data.results)) {
      throw new ComponentNodeAdmissionError(
        'component_node_response_invalid',
        502
      );
    }
    return data.results;
  }

  async drain(): Promise<Record<string, unknown>> {
    return this.#request<Record<string, unknown>>('/v1/drain', 'POST', {});
  }

  async #request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.#token}`
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.#fetch(new URL(path, this.#endpoint), {
        method,
        signal: controller.signal,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = await boundedJsonResponse(response);
      if (!response.ok) {
        const error = object(payload.error);
        throw new ComponentNodeAdmissionError(
          safeErrorCode(error.code),
          response.status,
          error.retryable === true
        );
      }
      return object(payload.data) as T;
    } catch (error) {
      if (error instanceof ComponentNodeAdmissionError) throw error;
      const aborted = (error as { name?: unknown })?.name === 'AbortError';
      throw new ComponentNodeAdmissionError(
        aborted ? 'component_node_timeout' : 'component_node_unavailable',
        503,
        true
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function decodeComponentNodeState(
  value: Record<string, unknown>
): ComponentNodeStateSnapshot {
  try {
    exactResponseKeys(value, [
      'cell_id', 'cell_lease_epoch', 'component', 'dimensions',
      'drain_started_at', 'lease_expires_at', 'lease_fresh',
      'lease_observed_at', 'node_id', 'recovery_pending', 'region_id',
      'reservations', 'state', 'state_sequence', 'zone_id'
    ]);
    if (!['rustpbx', 'livekit', 'tinode', 'rustdesk'].includes(String(value.component))) {
      throw new Error('component');
    }
    for (const key of ['region_id', 'zone_id', 'cell_id', 'node_id'] as const) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(String(value[key] || ''))) {
        throw new Error(key);
      }
    }
    if (!['accepting', 'degraded', 'draining'].includes(String(value.state)) ||
        !safeResponseInteger(value.state_sequence, 0, Number.MAX_SAFE_INTEGER) ||
        !safeResponseInteger(value.cell_lease_epoch, 0, 0xffff_ffff) ||
        typeof value.lease_fresh !== 'boolean' ||
        typeof value.recovery_pending !== 'boolean') {
      throw new Error('state');
    }
    optionalIsoTime(value.drain_started_at, 'drain_started_at');
    optionalIsoTime(value.lease_observed_at, 'lease_observed_at');
    optionalIsoTime(value.lease_expires_at, 'lease_expires_at');
    if (value.cell_lease_epoch === 0 &&
        (value.lease_observed_at !== '' || value.lease_expires_at !== '' || value.lease_fresh)) {
      throw new Error('lease');
    }
    if (value.cell_lease_epoch !== 0 &&
        (value.lease_observed_at === '' || value.lease_expires_at === '')) {
      throw new Error('lease');
    }

    const dimensions = responseObject(value.dimensions);
    const dimensionEntries = Object.entries(dimensions);
    if (dimensionEntries.length < 1 || dimensionEntries.length > 64) throw new Error('dimensions');
    for (const [name, raw] of dimensionEntries) {
      if (!/^[a-z][a-z0-9_.]{2,127}$/.test(name)) throw new Error('dimension name');
      const dimension = responseObject(raw);
      exactResponseKeys(dimension, ['reserved', 'safe_capacity', 'unit', 'used']);
      if (typeof dimension.unit !== 'string' || dimension.unit.length < 1 || dimension.unit.length > 64 ||
          !safeResponseNumber(dimension.safe_capacity, 0, Number.MAX_SAFE_INTEGER, false) ||
          !safeResponseNumber(dimension.used, 0, Number.MAX_SAFE_INTEGER, true) ||
          !safeResponseNumber(dimension.reserved, 0, Number.MAX_SAFE_INTEGER, true)) {
        throw new Error('dimension');
      }
    }
    const reservations = responseObject(value.reservations);
    exactResponseKeys(reservations, ['active', 'closed', 'expired', 'reserved']);
    for (const count of Object.values(reservations)) {
      if (!safeResponseInteger(count, 0, Number.MAX_SAFE_INTEGER)) throw new Error('reservations');
    }
    return structuredClone(value) as unknown as ComponentNodeStateSnapshot;
  } catch (error) {
    if (error instanceof ComponentNodeAdmissionError) throw error;
    throw new ComponentNodeAdmissionError('component_node_response_invalid', 502);
  }
}

function exactResponseKeys(value: Record<string, unknown>, expected: string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error('response fields');
  }
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('response object');
  }
  return value as Record<string, unknown>;
}

function optionalIsoTime(value: unknown, label: string): void {
  if (value === '') return;
  if (typeof value !== 'string') throw new Error(label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(label);
}

function safeResponseInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function safeResponseNumber(value: unknown, min: number, max: number, allowZero: boolean): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max &&
    (allowZero || value > 0);
}

function renderMetrics(
  snapshot: ReturnType<ComponentNodeAdmissionController['snapshot']>,
  routeDrainActive: boolean,
  additional = ''
): string {
  const lines = [
    '# TYPE ivekit_component_node_state_sequence gauge',
    `ivekit_component_node_state_sequence ${snapshot.state_sequence}`,
    '# TYPE ivekit_component_node_cell_lease_epoch gauge',
    `ivekit_component_node_cell_lease_epoch ${snapshot.cell_lease_epoch}`,
    '# TYPE ivekit_component_node_lease_fresh gauge',
    `ivekit_component_node_lease_fresh ${snapshot.lease_fresh ? 1 : 0}`,
    '# TYPE ivekit_component_node_recovery_pending gauge',
    `ivekit_component_node_recovery_pending ${snapshot.recovery_pending ? 1 : 0}`,
    '# TYPE ivekit_component_node_draining gauge',
    `ivekit_component_node_draining ${snapshot.state === 'draining' ? 1 : 0}`,
    '# TYPE ivekit_component_node_route_drain_active gauge',
    `ivekit_component_node_route_drain_active ${routeDrainActive ? 1 : 0}`,
    '# TYPE ivekit_component_node_reservations gauge'
  ];
  for (const state of ['reserved', 'active', 'expired', 'closed'] as const) {
    lines.push(
      `ivekit_component_node_reservations{state="${state}"} ` +
      `${snapshot.reservations[state]}`
    );
  }
  for (const [dimension, value] of Object.entries(snapshot.dimensions)) {
    const label = prometheusLabel(dimension);
    lines.push(
      `ivekit_component_node_capacity_safe{dimension="${label}"} ${value.safe_capacity}`,
      `ivekit_component_node_capacity_used{dimension="${label}"} ${value.used}`,
      `ivekit_component_node_capacity_reserved{dimension="${label}"} ${value.reserved}`
    );
  }
  if (additional) {
    if (Buffer.byteLength(additional) > 32_768 || /\u0000/.test(additional)) {
      throw new Error('component node additional metrics are invalid');
    }
    lines.push(additional.trimEnd());
  }
  return `${lines.join('\n')}\n`;
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
  const text = Buffer.concat(chunks, total).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError('invalid_json', 400);
  }
}

async function boundedJsonResponse(
  response: Response
): Promise<Record<string, unknown>> {
  const maximumBytes = 131_072;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximumBytes) {
    throw new ComponentNodeAdmissionError('component_node_response_too_large', 502);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        total += chunk.length;
        if (total > maximumBytes) {
          await reader.cancel('component_node_response_too_large');
          throw new ComponentNodeAdmissionError(
            'component_node_response_too_large',
            502
          );
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks, total).toString('utf8');
  try {
    return object(JSON.parse(text));
  } catch (error) {
    if (error instanceof ComponentNodeAdmissionError) throw error;
    throw new ComponentNodeAdmissionError('component_node_response_invalid', 502);
  }
}

function requireToken(
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

function safeToken(value: string): string {
  if (!value || value.length < 24 || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new Error('invalid component node service token');
  }
  return value;
}

function validateTls(
  tls: ComponentNodeAdmissionTlsOptions
): void {
  for (const value of [tls.key, tls.cert]) {
    if ((typeof value !== 'string' && !Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1) {
      throw new Error('invalid component node TLS configuration');
    }
  }
  const authorities = Array.isArray(tls.ca) ? tls.ca : [tls.ca];
  if (authorities.length < 1 ||
      authorities.some((value) =>
        (typeof value !== 'string' && !Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1)) {
    throw new Error('invalid component node TLS configuration');
  }
}

function createMutualTlsFetch(
  tls: ComponentNodeAdmissionClientTlsOptions
): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {}
  ) => {
    const target = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    );
    if (target.protocol !== 'https:') {
      throw new Error('component node TLS request must use HTTPS');
    }
    const encoded = encodeRequestBody(init.body);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const options: HttpsRequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers: {
        ...headers,
        ...(encoded && headers['content-length'] === undefined
          ? { 'content-length': String(encoded.length) }
          : {})
      },
      key: tls.key,
      cert: tls.cert,
      ca: tls.ca,
      servername: tls.servername,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    };
    return await new Promise<Response>((resolve, reject) => {
      const request = requestHttps(options, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > 131_072) {
            request.destroy(new ComponentNodeAdmissionError(
              'component_node_response_too_large',
              502
            ));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          resolve(new Response(Buffer.concat(chunks, total), {
            status: response.statusCode || 502,
            headers: responseHeaders(response.headers)
          }));
        });
      });
      const abort = () => request.destroy(
        Object.assign(new Error('aborted'), { name: 'AbortError' })
      );
      init.signal?.addEventListener('abort', abort, { once: true });
      request.once('close', () =>
        init.signal?.removeEventListener('abort', abort)
      );
      request.once('error', reject);
      if (encoded) request.write(encoded);
      request.end();
    });
  }) as typeof fetch;
}

function encodeRequestBody(
  value: RequestInit['body']
): Buffer | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('component node request body is unsupported');
}

function responseHeaders(
  input: import('node:http').IncomingHttpHeaders
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function checkedEndpoint(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password) {
    throw new Error('invalid component node endpoint');
  }
  return url;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError('invalid_request', 400);
  }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError('invalid_request', 400);
  }
  return value as Record<string, any>;
}

function safeErrorCode(value: unknown): string {
  const code = String(value || '');
  return /^[a-z][a-z0-9_]{1,127}$/.test(code)
    ? code
    : 'component_node_unavailable';
}

function projectError(error: unknown): {
  code: string;
  status: number;
  retryable: boolean;
} {
  if (error instanceof ComponentNodeAdmissionError) {
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
    status: Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : 500,
    retryable: candidate.retryable === true
  };
}

function httpError(
  code: string,
  status: number
): Error & { code: string; status: number; retryable: boolean } {
  return Object.assign(new Error(code), {
    code,
    status,
    retryable: false
  });
}

function prometheusLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
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

function sendMetrics(
  response: import('node:http').ServerResponse,
  value: string
): void {
  response.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(value);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}
