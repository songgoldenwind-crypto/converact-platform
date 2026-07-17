import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type {
  CellAdmissionReservationCheckpoint
} from './admission.js';
import {
  ComponentNodeAdmissionController,
  ComponentNodeAdmissionError,
  type ComponentNodeAuthorization,
  type ComponentNodeBatchAuthorizationResult,
  type ComponentNodeAuthorizationInput,
  type ComponentNodeLeaseHeartbeat
} from './component-node-admission.js';

export function createComponentNodeAdmissionHttpServer(input: {
  controller: ComponentNodeAdmissionController;
  service_token: string;
  max_body_bytes?: number;
  now?: () => Date;
  before_new_reservation?: (
    checkpoint: CellAdmissionReservationCheckpoint,
    now: Date
  ) => void | Promise<void>;
  additional_metrics?: (now: Date) => string;
}): Server {
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
    additional_metrics: input.additional_metrics
  };
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/livez') {
        return sendJson(response, 200, { status: 'alive' });
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const state = config.controller.snapshot(config.now());
        const ready = state.lease_fresh && !state.recovery_pending &&
          (state.state === 'accepting' || state.state === 'degraded');
        return sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          state: state.state,
          lease_fresh: state.lease_fresh,
          recovery_pending: state.recovery_pending,
          component: state.component,
          node_id: state.node_id,
          cell_lease_epoch: state.cell_lease_epoch,
          state_sequence: state.state_sequence
        });
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        const now = config.now();
        return sendMetrics(response, renderMetrics(
          config.controller.snapshot(now),
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
        await readJsonBody(request, config.max_body_bytes);
        return sendJson(response, 200, {
          data: config.controller.startDrain(config.now())
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
  });
}

export class HttpComponentNodeAdmissionClient {
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
    this.#endpoint = checkedEndpoint(input.endpoint);
    this.#token = safeToken(input.service_token);
    this.#timeoutMs = boundedInteger(
      input.timeout_ms ?? 2_000,
      100,
      30_000,
      'component node timeout'
    );
    this.#fetch = input.fetch || globalThis.fetch;
  }

  async applyLease(
    heartbeat: ComponentNodeLeaseHeartbeat
  ): Promise<Record<string, unknown>> {
    return this.#request<Record<string, unknown>>('/v1/lease', 'POST', heartbeat);
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
    method: 'POST' | 'PUT',
    body: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(new URL(path, this.#endpoint), {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
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

function renderMetrics(
  snapshot: ReturnType<ComponentNodeAdmissionController['snapshot']>,
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
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) {
    throw new ComponentNodeAdmissionError('component_node_response_too_large', 502);
  }
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
