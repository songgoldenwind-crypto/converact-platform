import { timingSafeEqual } from 'node:crypto';

import {
  DialogShadowError,
  assertDialogShadowRecord,
  dialogShadowRecordHash,
  type DialogShadowCommitProof,
  type DialogShadowNotRequired,
  type DialogShadowProfile,
  type DialogShadowRecord
} from './dialog-shadow.js';

const COMMIT_PATH = '/internal/ivekit/v1/dialog-shadow/commit';
const ADMISSION_PATH = '/internal/ivekit/v1/dialog-shadow/admission';

export interface DialogShadowHttpCoordinator {
  commit(
    profile: DialogShadowProfile,
    record: DialogShadowRecord
  ): Promise<DialogShadowNotRequired | DialogShadowCommitProof>;
  assertAdmission(
    profile: DialogShadowProfile
  ): Promise<DialogShadowNotRequired | {
    status: 'ready';
    fault_domains: string[];
  }>;
}

export async function handleDialogShadowRequest(
  request: Request,
  input: {
    service_token: string;
    coordinator: DialogShadowHttpCoordinator;
    max_body_bytes?: number;
  }
): Promise<Response> {
  const maximumBodyBytes = boundedInteger(
    input.max_body_bytes ?? 48 * 1024,
    1024,
    1024 * 1024,
    'max_body_bytes'
  );
  const expectedToken = serviceToken(input.service_token);
  const url = new URL(request.url);
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (url.pathname !== COMMIT_PATH && url.pathname !== ADMISSION_PATH) {
    return json(404, { error: 'not_found' });
  }
  if (!request.headers.get('content-type')?.toLowerCase()
    .startsWith('application/json')) {
    return json(415, { error: 'unsupported_media_type' });
  }
  if (!authorized(request.headers.get('authorization'), expectedToken)) {
    return json(401, { error: 'unauthorized' });
  }
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    return json(413, { error: 'body_too_large' });
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > maximumBodyBytes) {
      return json(413, { error: 'body_too_large' });
    }
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  try {
    const payload = strictObject(body);
    const profile = dialogProfile(payload.profile);
    if (url.pathname === ADMISSION_PATH) {
      exactKeys(payload, ['profile']);
      return json(200, await input.coordinator.assertAdmission(profile));
    }
    exactKeys(payload, ['profile', 'record']);
    return json(
      200,
      await input.coordinator.commit(
        profile,
        assertDialogShadowRecord(payload.record as DialogShadowRecord)
      )
    );
  } catch (error) {
    if (error instanceof DialogShadowError) {
      return json(error.status, { error: error.code });
    }
    return json(400, { error: 'invalid_request' });
  }
}

export class HttpDialogShadowClient {
  readonly #endpoint: URL;
  readonly #serviceToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #maxResponseBytes: number;

  constructor(input: {
    endpoint: string;
    service_token: string;
    timeout_ms?: number;
    max_response_bytes?: number;
    fetch?: typeof fetch;
  }) {
    this.#endpoint = endpoint(input.endpoint);
    this.#serviceToken = serviceToken(input.service_token);
    this.#timeoutMs = boundedInteger(
      input.timeout_ms ?? 500,
      50,
      10_000,
      'timeout_ms'
    );
    this.#maxResponseBytes = boundedInteger(
      input.max_response_bytes ?? 16 * 1024,
      1024,
      1024 * 1024,
      'max_response_bytes'
    );
    this.#fetch = input.fetch || fetch;
  }

  async commit(
    profile: DialogShadowProfile,
    value: DialogShadowRecord
  ): Promise<DialogShadowNotRequired | DialogShadowCommitProof> {
    const record = assertDialogShadowRecord(value);
    const response = await this.#post(COMMIT_PATH, { profile, record });
    if (response.status === 'not_required') return { status: 'not_required' };
    const proof = commitProof(response);
    if (proof.record_hash !== dialogShadowRecordHash(record) ||
        proof.owner_epoch !== record.owner_epoch ||
        proof.sequence !== record.sequence) {
      throw new DialogShadowError('dialog_shadow_response_mismatch', 503);
    }
    return proof;
  }

  async assertAdmission(
    profile: DialogShadowProfile
  ): Promise<DialogShadowNotRequired | {
    status: 'ready';
    fault_domains: string[];
  }> {
    const response = await this.#post(ADMISSION_PATH, { profile });
    if (response.status === 'not_required') return { status: 'not_required' };
    const record = strictObject(response);
    exactKeys(record, ['status', 'fault_domains']);
    if (record.status !== 'ready') {
      throw new DialogShadowError('dialog_shadow_response_invalid', 503);
    }
    return {
      status: 'ready',
      fault_domains: faultDomains(record.fault_domains)
    };
  }

  async #post(
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetch(new URL(path, this.#endpoint), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#serviceToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await boundedResponseBody(response, this.#maxResponseBytes);
      let decoded: Record<string, unknown>;
      try {
        decoded = strictObject(JSON.parse(text));
      } catch (error) {
        throw new DialogShadowError(
          'dialog_shadow_response_invalid',
          503,
          error
        );
      }
      if (!response.ok) {
        const code = typeof decoded.error === 'string'
          ? decoded.error
          : 'dialog_shadow_request_failed';
        throw new DialogShadowError(code, response.status);
      }
      return decoded;
    } catch (error) {
      if (error instanceof DialogShadowError) throw error;
      throw new DialogShadowError('dialog_shadow_request_failed', 503, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function commitProof(value: Record<string, unknown>): DialogShadowCommitProof {
  exactKeys(value, [
    'status',
    'record_hash',
    'fault_domains',
    'owner_epoch',
    'sequence'
  ]);
  if (value.status !== 'committed' ||
      !/^[a-f0-9]{64}$/.test(String(value.record_hash || ''))) {
    throw new DialogShadowError('dialog_shadow_response_invalid', 503);
  }
  return {
    status: 'committed',
    record_hash: String(value.record_hash),
    fault_domains: faultDomains(value.fault_domains),
    owner_epoch: boundedInteger(value.owner_epoch, 1, 0xffff_ffff, 'owner_epoch'),
    sequence: boundedInteger(value.sequence, 1, 0xffff_ffff, 'sequence')
  };
}

function faultDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) {
    throw new DialogShadowError('dialog_shadow_response_invalid', 503);
  }
  const domains = value.map((item) => {
    const result = String(item || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
      throw new DialogShadowError('dialog_shadow_response_invalid', 503);
    }
    return result;
  });
  if (new Set(domains).size !== domains.length) {
    throw new DialogShadowError('dialog_shadow_response_invalid', 503);
  }
  return domains.sort();
}

async function boundedResponseBody(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new DialogShadowError('dialog_shadow_response_too_large', 503);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
    throw new DialogShadowError('dialog_shadow_response_too_large', 503);
  }
  return body;
}

function endpoint(value: unknown): URL {
  const result = new URL(String(value || ''));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(result.hostname);
  if ((result.protocol !== 'https:' && !(result.protocol === 'http:' && loopback)) ||
      result.username || result.password || result.search || result.hash) {
    throw new Error('dialog shadow endpoint is invalid');
  }
  result.pathname = result.pathname.replace(/\/+$/, '') || '/';
  return result;
}

function authorized(header: string | null, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice(7), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return received.byteLength === wanted.byteLength &&
    timingSafeEqual(received, wanted);
}

function serviceToken(value: unknown): string {
  const result = String(value || '');
  if (result.length < 16 || result.length > 4096 || /[\r\n\0]/.test(result)) {
    throw new Error('dialog shadow service token is invalid');
  }
  return result;
}

function dialogProfile(value: unknown): DialogShadowProfile {
  const result = String(value || '');
  if (!/^[A-Z][A-Z0-9_-]{2,63}$/.test(result)) {
    throw new DialogShadowError('dialog_shadow_profile_invalid', 400);
  }
  return result as DialogShadowProfile;
}

function strictObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('object required');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[]
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((item, index) => item !== wanted[index])) {
    throw new Error('fields mismatch');
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return Number(value);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8'
    }
  });
}
