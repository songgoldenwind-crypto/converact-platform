import {
  request as requestHttp,
  type RequestOptions
} from 'node:http';
import { request as requestHttps } from 'node:https';

import { MediaControlError } from './agent.js';
import {
  MEDIA_CONTROL_PROTOCOL_VERSION,
  checkedMediaControlCommand,
  checkedMediaControlReconcileInput,
  checkedMediaControlResult,
  checkedMediaSessionSnapshot,
  type MediaControlCommand,
  type MediaControlReconcileInput,
  type MediaControlResult,
  type MediaSessionSnapshot
} from './protocol.js';

export interface MediaControlClientTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
  ca: string | Buffer | Array<string | Buffer>;
  servername?: string;
}

export class HttpMediaControlClient {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #tls?: MediaControlClientTlsOptions;

  constructor(input: {
    endpoint: string;
    service_token: string;
    production?: boolean;
    tls?: MediaControlClientTlsOptions;
    timeout_ms?: number;
    max_response_bytes?: number;
  }) {
    this.#endpoint = checkedEndpoint(input.endpoint);
    this.#token = safeToken(input.service_token);
    this.#timeoutMs = boundedInteger(
      input.timeout_ms ?? 2_000,
      50,
      30_000,
      'media control client timeout'
    );
    this.#maxResponseBytes = boundedInteger(
      input.max_response_bytes ?? 262_144,
      1_024,
      1_048_576,
      'media control response limit'
    );
    this.#tls = input.tls;
    if (input.production &&
        (this.#endpoint.protocol !== 'https:' || !this.#tls)) {
      throw new Error('media control production mTLS is required');
    }
    if (this.#tls && this.#endpoint.protocol !== 'https:') {
      throw new Error('media control TLS requires an HTTPS endpoint');
    }
    if (this.#tls) validateTls(this.#tls);
  }

  async execute(command: MediaControlCommand): Promise<MediaControlResult> {
    const checked = checkedMediaControlCommand(command);
    try {
      const data = await this.#request('/v1/commands', 'POST', checked);
      try {
        return checkedMediaControlResult(data as unknown as MediaControlResult);
      } catch {
        throw new ClientTransportError('media_control_response_invalid');
      }
    } catch (error) {
      if (isUnknownOutcome(error)) {
        return {
          protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
          state: 'unknown',
          command_id: checked.command_id,
          error_code: error.code,
          retryable: true
        };
      }
      throw error;
    }
  }

  async reconcile(
    input: MediaControlReconcileInput
  ): Promise<MediaControlResult> {
    const checked = checkedMediaControlReconcileInput(input);
    try {
      const data = await this.#request('/v1/reconcile', 'POST', checked);
      try {
        return checkedMediaControlResult(data as unknown as MediaControlResult);
      } catch {
        throw new ClientTransportError('media_control_response_invalid');
      }
    } catch (error) {
      if (isUnknownOutcome(error)) {
        return {
          protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
          state: 'unknown',
          command_id: checked.command_id,
          error_code: error.code,
          retryable: true
        };
      }
      throw error;
    }
  }

  async session(reservationId: string): Promise<MediaSessionSnapshot> {
    if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(reservationId)) {
      throw new MediaControlError('media_session_id_invalid', 400, false);
    }
    try {
      return checkedMediaSessionSnapshot(await this.#request(
        `/v1/sessions/${encodeURIComponent(reservationId)}`,
        'GET'
      ) as unknown as MediaSessionSnapshot);
    } catch (error) {
      if (error instanceof MediaControlError) throw error;
      throw new MediaControlError(
        'media_control_response_invalid',
        502,
        true
      );
    }
  }

  async #request(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown
  ): Promise<Record<string, unknown>> {
    const target = new URL(path.replace(/^\//, ''), ensureTrailingSlash(this.#endpoint));
    const encoded = body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(body), 'utf8');
    const options: RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: 'application/json',
        ...(encoded
          ? {
              'content-type': 'application/json',
              'content-length': String(encoded.length)
            }
          : {})
      }
    };
    if (target.protocol === 'https:' && this.#tls) {
      Object.assign(options, {
        key: this.#tls.key,
        cert: this.#tls.cert,
        ca: this.#tls.ca,
        servername: this.#tls.servername,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      });
    }

    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
      const request = (target.protocol === 'https:'
        ? requestHttps
        : requestHttp)(options, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > this.#maxResponseBytes) {
            request.destroy(new ClientTransportError(
              'media_control_response_too_large'
            ));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          let payload: Record<string, unknown>;
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks, total).toString('utf8')
            );
            payload = object(parsed);
          } catch {
            reject(new ClientTransportError(
              'media_control_response_invalid'
            ));
            return;
          }
          const status = response.statusCode ?? 502;
          if (status < 200 || status >= 300) {
            try {
              const projected = object(payload.error);
              reject(new MediaControlError(
                safeErrorCode(projected.code),
                status,
                projected.retryable === true
              ));
            } catch {
              reject(new ClientTransportError(
                'media_control_response_invalid'
              ));
            }
            return;
          }
          try {
            resolve(object(payload.data));
          } catch {
            reject(new ClientTransportError(
              'media_control_response_invalid'
            ));
          }
        });
      });
      deadline = setTimeout(() => {
        request.destroy(new ClientTransportError('media_control_timeout'));
      }, this.#timeoutMs);
      request.on('error', (error) => {
        reject(error instanceof ClientTransportError
          ? error
          : new ClientTransportError('media_control_unavailable'));
      });
      if (encoded) request.write(encoded);
      request.end();
      });
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}

class ClientTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ClientTransportError';
  }
}

function isUnknownOutcome(
  error: unknown
): error is ClientTransportError | MediaControlError {
  return error instanceof ClientTransportError ||
    (error instanceof MediaControlError && error.status >= 500);
}

function checkedEndpoint(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search) {
    throw new Error('invalid media control endpoint');
  }
  return url;
}

function ensureTrailingSlash(value: URL): URL {
  const result = new URL(value);
  if (!result.pathname.endsWith('/')) result.pathname += '/';
  return result;
}

function safeToken(value: string): string {
  if (typeof value !== 'string' ||
      value.length < 24 ||
      value.length > 512 ||
      /[\0\r\n]/.test(value)) {
    throw new Error('invalid media control service token');
  }
  return value;
}

function validateTls(tls: MediaControlClientTlsOptions): void {
  for (const value of [tls.key, tls.cert]) {
    if ((typeof value !== 'string' && !Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1) {
      throw new Error('invalid media control TLS configuration');
    }
  }
  const authorities = Array.isArray(tls.ca) ? tls.ca : [tls.ca];
  if (authorities.length < 1 ||
      authorities.some((value) =>
        (typeof value !== 'string' && !Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1)) {
    throw new Error('invalid media control TLS configuration');
  }
}

function safeErrorCode(value: unknown): string {
  const code = String(value || '');
  return /^[a-z][a-z0-9_]{1,127}$/.test(code)
    ? code
    : 'media_control_unavailable';
}

function object(value: unknown): Record<string, unknown> {
  if (!value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('media control response object is invalid');
  }
  return value as Record<string, unknown>;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
