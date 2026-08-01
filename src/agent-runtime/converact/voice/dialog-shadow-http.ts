import { timingSafeEqual } from 'node:crypto';

import {
  DialogShadowError,
  assertDialogShadowPair,
  assertDialogShadowRecord,
  dialogShadowPairHash,
  dialogShadowRecordHash,
  type DialogShadowCommitProof,
  type DialogShadowNotRequired,
  type DialogShadowProfile,
  type DialogShadowPairCommitProof,
  type DialogShadowRecord
} from './dialog-shadow.js';
import {
  DialogOwnerTakeoverError,
  type DialogPeerIdentity,
  type DialogOwnerTakeoverCoordinator
} from './dialog-owner-takeover.js';

const COMMIT_PATH = '/internal/converact/v1/dialog-shadow/commit';
const COMMIT_PAIR_PATH = '/internal/converact/v1/dialog-shadow/commit-pair';
const ADMISSION_PATH = '/internal/converact/v1/dialog-shadow/admission';
const TAKEOVER_CLAIM_PATH = '/internal/converact/v1/dialog-owner/claim';
const TAKEOVER_CONSUME_PATH = '/internal/converact/v1/dialog-owner/consume';
const TAKEOVER_AUTHORITY_PATH = '/internal/converact/v1/dialog-owner/authority';
const TAKEOVER_HEARTBEAT_PATH = '/internal/converact/v1/dialog-owner/heartbeat';
const TAKEOVER_PATHS = new Set([
  TAKEOVER_CLAIM_PATH,
  TAKEOVER_CONSUME_PATH,
  TAKEOVER_AUTHORITY_PATH,
  TAKEOVER_HEARTBEAT_PATH
]);

export interface DialogShadowHttpCoordinator {
  commit(
    profile: DialogShadowProfile,
    record: DialogShadowRecord
  ): Promise<DialogShadowNotRequired | DialogShadowCommitProof>;
  commitPair?(
    profile: DialogShadowProfile,
    records: readonly [DialogShadowRecord, DialogShadowRecord]
  ): Promise<DialogShadowNotRequired | DialogShadowPairCommitProof>;
  assertAdmission(
    profile: DialogShadowProfile
  ): Promise<DialogShadowNotRequired | {
    status: 'ready';
    fault_domains: string[];
  }>;
}

export interface DialogOwnerTakeoverHttpCoordinator {
  heartbeatNode(
    identity: DialogPeerIdentity
  ): ReturnType<DialogOwnerTakeoverCoordinator['heartbeatNode']>;
  assertNodeLease(
    identity: DialogPeerIdentity
  ): ReturnType<DialogOwnerTakeoverCoordinator['assertNodeLease']>;
  observeCommittedPair(
    records: readonly [DialogShadowRecord, DialogShadowRecord]
  ): ReturnType<DialogOwnerTakeoverCoordinator['observeCommittedPair']>;
  claimByDialog(
    input: Parameters<DialogOwnerTakeoverCoordinator['claimByDialog']>[0]
  ): ReturnType<DialogOwnerTakeoverCoordinator['claimByDialog']>;
  consume(
    input: Parameters<DialogOwnerTakeoverCoordinator['consume']>[0]
  ): ReturnType<DialogOwnerTakeoverCoordinator['consume']>;
  checkAuthority(
    input: Parameters<DialogOwnerTakeoverCoordinator['checkAuthority']>[0]
  ): ReturnType<DialogOwnerTakeoverCoordinator['checkAuthority']>;
}

export async function handleDialogShadowRequest(
  request: Request,
  input: {
    service_token: string;
    coordinator: DialogShadowHttpCoordinator;
    takeover_coordinator?: DialogOwnerTakeoverHttpCoordinator;
    peer_identity?: DialogPeerIdentity;
    max_body_bytes?: number;
  }
): Promise<Response> {
  const maximumBodyBytes = boundedInteger(
    input.max_body_bytes ?? 128 * 1024,
    1024,
    1024 * 1024,
    'max_body_bytes'
  );
  const expectedToken = serviceToken(input.service_token);
  const url = new URL(request.url);
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (url.pathname !== COMMIT_PATH &&
      url.pathname !== COMMIT_PAIR_PATH &&
      url.pathname !== ADMISSION_PATH &&
      !TAKEOVER_PATHS.has(url.pathname)) {
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
    const peer = input.peer_identity;
    if (!peer) {
      return json(401, { error: 'dialog_shadow_peer_identity_required' });
    }
    if (TAKEOVER_PATHS.has(url.pathname)) {
      if (!input.takeover_coordinator) {
        return json(503, { error: 'dialog_owner_takeover_unavailable' });
      }
      return await handleTakeoverRequest(
        url.pathname,
        payload,
        input.takeover_coordinator,
        peer
      );
    }
    if (!input.takeover_coordinator) {
      return json(503, { error: 'dialog_owner_takeover_unavailable' });
    }
    await input.takeover_coordinator.assertNodeLease(peer);
    const profile = dialogProfile(payload.profile);
    if (url.pathname === ADMISSION_PATH) {
      exactKeys(payload, ['profile']);
      return json(200, await input.coordinator.assertAdmission(profile));
    }
    if (url.pathname === COMMIT_PAIR_PATH) {
      if (!input.coordinator.commitPair) {
        return json(503, { error: 'dialog_shadow_pair_commit_unavailable' });
      }
      exactKeys(payload, ['profile', 'records']);
      if (!Array.isArray(payload.records) || payload.records.length !== 2) {
        throw new Error('pair requires exactly two records');
      }
      const records = assertDialogShadowPair(
        payload.records as [DialogShadowRecord, DialogShadowRecord]
      );
      assertPeerRecords(peer, records);
      const proof = await input.coordinator.commitPair(profile, records);
      await input.takeover_coordinator.observeCommittedPair(records);
      return json(
        200,
        proof
      );
    }
    exactKeys(payload, ['profile', 'record']);
    const record = assertDialogShadowRecord(payload.record as DialogShadowRecord);
    assertPeerRecords(peer, [record]);
    return json(
      200,
      await input.coordinator.commit(profile, record)
    );
  } catch (error) {
    if (error instanceof DialogOwnerTakeoverError) {
      return json(error.status, { error: error.code });
    }
    if (error instanceof DialogShadowError) {
      return json(error.status, { error: error.code });
    }
    return json(400, { error: 'invalid_request' });
  }
}

async function handleTakeoverRequest(
  path: string,
  payload: Record<string, unknown>,
  coordinator: DialogOwnerTakeoverHttpCoordinator,
  peer: DialogPeerIdentity
): Promise<Response> {
  if (path === TAKEOVER_HEARTBEAT_PATH) {
    exactKeys(payload, []);
    return json(200, await coordinator.heartbeatNode(peer));
  }
  await coordinator.assertNodeLease(peer);
  if (String(payload.cell_id || '') !== peer.cell_id) {
    throw new DialogOwnerTakeoverError(
      'dialog_owner_takeover_identity_mismatch',
      403
    );
  }
  if (path === TAKEOVER_CLAIM_PATH) {
    exactKeys(payload, [
      'profile',
      'tenant_id',
      'cell_id',
      'dialog_id',
      'idempotency_key',
      'reason'
    ]);
    return json(200, await coordinator.claimByDialog({
      profile: dialogProfile(payload.profile),
      tenant_id: String(payload.tenant_id || ''),
      cell_id: String(payload.cell_id || ''),
      dialog_id: String(payload.dialog_id || ''),
      caller: peer,
      idempotency_key: String(payload.idempotency_key || ''),
      reason: String(payload.reason || '')
    }));
  }
  if (path === TAKEOVER_CONSUME_PATH) {
    exactKeys(payload, [
      'tenant_id',
      'cell_id',
      'call_session_ref',
      'takeover_id',
      'owner_epoch',
      'takeover_token'
    ]);
    return json(200, await coordinator.consume({
      tenant_id: String(payload.tenant_id || ''),
      cell_id: String(payload.cell_id || ''),
      call_session_ref: String(payload.call_session_ref || ''),
      takeover_id: String(payload.takeover_id || ''),
      owner_node_id: peer.node_id,
      owner_epoch: boundedInteger(
        payload.owner_epoch,
        2,
        0xffff_ffff,
        'owner_epoch'
      ),
      takeover_token: String(payload.takeover_token || '')
    }));
  }
  exactKeys(payload, [
    'tenant_id',
    'cell_id',
    'call_session_ref',
    'owner_epoch'
  ]);
  return json(200, await coordinator.checkAuthority({
    tenant_id: String(payload.tenant_id || ''),
    cell_id: String(payload.cell_id || ''),
    call_session_ref: String(payload.call_session_ref || ''),
    owner_node_id: peer.node_id,
    owner_epoch: boundedInteger(
      payload.owner_epoch,
      1,
      0xffff_ffff,
      'owner_epoch'
    )
  }));
}

function assertPeerRecords(
  peer: DialogPeerIdentity,
  records: readonly DialogShadowRecord[]
): void {
  if (records.some((record) =>
    record.cell_id !== peer.cell_id ||
    record.owner_node_id !== peer.node_id ||
    record.owner_fault_domain !== peer.fault_domain
  )) {
    throw new DialogOwnerTakeoverError(
      'dialog_owner_takeover_identity_mismatch',
      403
    );
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

  async commitPair(
    profile: DialogShadowProfile,
    values: readonly [DialogShadowRecord, DialogShadowRecord]
  ): Promise<DialogShadowNotRequired | DialogShadowPairCommitProof> {
    const records = assertDialogShadowPair(values);
    const response = await this.#post(COMMIT_PAIR_PATH, { profile, records });
    if (response.status === 'not_required') return { status: 'not_required' };
    const proof = pairCommitProof(response);
    const pairHash = dialogShadowPairHash(records);
    const recordHashes = records.map(dialogShadowRecordHash).sort();
    if (proof.pair_hash !== pairHash ||
        proof.record_hashes.some(
          (hash, index) => hash !== recordHashes[index]
        ) ||
        proof.owner_epoch !== records[0].owner_epoch ||
        proof.sequence !== records[0].sequence) {
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

function pairCommitProof(
  value: Record<string, unknown>
): DialogShadowPairCommitProof {
  exactKeys(value, [
    'status',
    'pair_hash',
    'record_hashes',
    'fault_domains',
    'owner_epoch',
    'sequence'
  ]);
  if (value.status !== 'committed' ||
      !/^[a-f0-9]{64}$/.test(String(value.pair_hash || '')) ||
      !Array.isArray(value.record_hashes) ||
      value.record_hashes.length !== 2 ||
      value.record_hashes.some(
        (hash) => !/^[a-f0-9]{64}$/.test(String(hash || ''))
      )) {
    throw new DialogShadowError('dialog_shadow_response_invalid', 503);
  }
  return {
    status: 'committed',
    pair_hash: String(value.pair_hash),
    record_hashes: value.record_hashes.map(String).sort() as [string, string],
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
