import { createHash } from 'node:crypto';

const RECORD_KEYS = [
  'schema_version',
  'tenant_id',
  'cell_id',
  'dialog_id',
  'call_id_hash',
  'owner_node_id',
  'owner_fault_domain',
  'owner_epoch',
  'sequence',
  'state',
  'local_tag',
  'remote_tag',
  'route_set',
  'local_cseq',
  'remote_cseq',
  'branch_hash',
  'final_response_hash',
  'auth_context_ref',
  'logical_offer_hash',
  'logical_answer_hash',
  'media_reservation_id',
  'provider_session_ref',
  'cdr_sequence',
  'recorded_at',
  'terminal'
] as const;

const DIALOG_STATES = [
  'trying',
  'early',
  'confirmed',
  'updating',
  'terminating',
  'terminated'
] as const;

export type DialogShadowState = typeof DIALOG_STATES[number];
export type DialogShadowProfile = 'VOICE-HA-T1' | (string & {});

export interface DialogShadowRecord {
  schema_version: 1;
  tenant_id: string;
  cell_id: string;
  dialog_id: string;
  call_id_hash: string;
  owner_node_id: string;
  owner_fault_domain: string;
  owner_epoch: number;
  sequence: number;
  state: DialogShadowState;
  local_tag: string;
  remote_tag: string | null;
  route_set: string[];
  local_cseq: number;
  remote_cseq: number;
  branch_hash: string;
  final_response_hash: string | null;
  auth_context_ref: string;
  logical_offer_hash: string | null;
  logical_answer_hash: string | null;
  media_reservation_id: string | null;
  provider_session_ref: string | null;
  cdr_sequence: number;
  recorded_at: string;
  terminal: boolean;
}

export interface DialogShadowJournalAppendResult {
  status: 'committed' | 'replayed';
  record_hash: string;
}

export interface DialogShadowJournalPort {
  append(record: DialogShadowRecord): Promise<DialogShadowJournalAppendResult>;
}

export interface DialogShadowReplicaAck {
  schema_version: 1;
  cell_id: string;
  dialog_id: string;
  owner_epoch: number;
  sequence: number;
  record_hash: string;
  node_id: string;
  fault_domain: string;
  durable: boolean;
  acknowledged_at: string;
}

export interface DialogShadowReplicaHealth {
  cell_id: string;
  node_id: string;
  fault_domain: string;
  durable: boolean;
  ready: boolean;
}

export interface DialogShadowReplicationBus {
  replicate(
    record: DialogShadowRecord,
    recordHash: string
  ): Promise<DialogShadowReplicaAck[]>;
  replicaHealth(): Promise<DialogShadowReplicaHealth[]>;
}

export interface DialogShadowCommitProof {
  status: 'committed';
  record_hash: string;
  fault_domains: string[];
  owner_epoch: number;
  sequence: number;
}

export interface DialogShadowNotRequired {
  status: 'not_required';
}

export class DialogShadowQuorum {
  readonly #localJournal: DialogShadowJournalPort;
  readonly #replicationBus: DialogShadowReplicationBus;
  readonly #localIdentity: {
    cell_id: string;
    node_id: string;
    fault_domain: string;
  };
  readonly #requiredFaultDomains: number;

  constructor(input: {
    local_journal: DialogShadowJournalPort;
    replication_bus: DialogShadowReplicationBus;
    local_identity: {
      cell_id: string;
      node_id: string;
      fault_domain: string;
    };
    required_fault_domains?: number;
  }) {
    this.#localJournal = input.local_journal;
    this.#replicationBus = input.replication_bus;
    this.#localIdentity = {
      cell_id: identifier(input.local_identity.cell_id, 'cell_id'),
      node_id: identifier(input.local_identity.node_id, 'node_id'),
      fault_domain: identifier(
        input.local_identity.fault_domain,
        'fault_domain'
      )
    };
    this.#requiredFaultDomains = boundedInteger(
      input.required_fault_domains ?? 2,
      2,
      16,
      'required_fault_domains'
    );
  }

  async assertAdmission(
    profile: DialogShadowProfile
  ): Promise<DialogShadowNotRequired | { status: 'ready'; fault_domains: string[] }> {
    if (!requiresShadow(profile)) return { status: 'not_required' };
    let health: DialogShadowReplicaHealth[];
    try {
      health = await this.#replicationBus.replicaHealth();
    } catch (error) {
      throw unavailable(error);
    }
    const domains = new Set([this.#localIdentity.fault_domain]);
    for (const candidate of health) {
      if (validReplicaHealth(candidate, this.#localIdentity)) {
        domains.add(candidate.fault_domain);
      }
    }
    if (domains.size < this.#requiredFaultDomains) throw unavailable();
    return { status: 'ready', fault_domains: [...domains].sort() };
  }

  async commit(
    profile: DialogShadowProfile,
    value: DialogShadowRecord
  ): Promise<DialogShadowNotRequired | DialogShadowCommitProof> {
    if (!requiresShadow(profile)) return { status: 'not_required' };
    const record = assertDialogShadowRecord(value);
    if (record.cell_id !== this.#localIdentity.cell_id ||
        record.owner_node_id !== this.#localIdentity.node_id ||
        record.owner_fault_domain !== this.#localIdentity.fault_domain) {
      throw new DialogShadowError('dialog_shadow_owner_mismatch', 409);
    }
    const hash = dialogShadowRecordHash(record);
    let local: DialogShadowJournalAppendResult;
    try {
      local = await this.#localJournal.append(record);
    } catch (error) {
      throw unavailable(error);
    }
    if (local.record_hash !== hash) {
      throw new DialogShadowError('dialog_shadow_local_identity_mismatch', 503);
    }

    let acknowledgements: DialogShadowReplicaAck[];
    try {
      acknowledgements = await this.#replicationBus.replicate(record, hash);
    } catch (error) {
      throw unavailable(error);
    }
    const domains = new Set([this.#localIdentity.fault_domain]);
    for (const acknowledgement of acknowledgements) {
      if (validReplicaAck(
        acknowledgement,
        record,
        hash,
        this.#localIdentity
      )) {
        domains.add(acknowledgement.fault_domain);
      }
    }
    if (domains.size < this.#requiredFaultDomains) throw unavailable();
    return {
      status: 'committed',
      record_hash: hash,
      fault_domains: [...domains].sort(),
      owner_epoch: record.owner_epoch,
      sequence: record.sequence
    };
  }
}

export interface DialogShadowStreamEvidence {
  stream_name: string;
  subject_prefix: string;
  storage: 'file' | 'memory';
  num_replicas: number;
  replica_fault_domains: string[];
}

export function assertDialogShadowStreamEvidence(
  value: DialogShadowStreamEvidence
): DialogShadowStreamEvidence {
  try {
    const streamName = String(value.stream_name || '');
    const subjectPrefix = String(value.subject_prefix || '');
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(streamName) ||
        !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(subjectPrefix) ||
        value.storage !== 'file' ||
        !Number.isInteger(value.num_replicas) ||
        value.num_replicas < 3 ||
        value.num_replicas > 5 ||
        !Array.isArray(value.replica_fault_domains) ||
        value.replica_fault_domains.length !== value.num_replicas) {
      throw new Error('invalid stream evidence');
    }
    const domains = value.replica_fault_domains.map(
      (item) => identifier(item, 'replica_fault_domain')
    );
    if (new Set(domains).size < 2) throw new Error('insufficient fault domains');
    return {
      stream_name: streamName,
      subject_prefix: subjectPrefix,
      storage: 'file',
      num_replicas: value.num_replicas,
      replica_fault_domains: domains
    };
  } catch (error) {
    throw new DialogShadowError('dialog_shadow_stream_invalid', 503, error);
  }
}

export function assertDialogShadowRecord(
  value: DialogShadowRecord
): DialogShadowRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('record must be an object');
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== RECORD_KEYS.length ||
        keys.some((key, index) => key !== [...RECORD_KEYS].sort()[index])) {
      throw new Error('record fields mismatch');
    }
    if (value.schema_version !== 1) throw new Error('schema version mismatch');
    const result: DialogShadowRecord = {
      schema_version: 1,
      tenant_id: identifier(value.tenant_id, 'tenant_id'),
      cell_id: identifier(value.cell_id, 'cell_id'),
      dialog_id: identifier(value.dialog_id, 'dialog_id'),
      call_id_hash: sha256(value.call_id_hash, 'call_id_hash'),
      owner_node_id: identifier(value.owner_node_id, 'owner_node_id'),
      owner_fault_domain: identifier(
        value.owner_fault_domain,
        'owner_fault_domain'
      ),
      owner_epoch: boundedInteger(value.owner_epoch, 1, 0xffff_ffff, 'owner_epoch'),
      sequence: boundedInteger(value.sequence, 1, 0xffff_ffff, 'sequence'),
      state: shadowState(value.state),
      local_tag: sipTag(value.local_tag, 'local_tag'),
      remote_tag: nullable(value.remote_tag, (item) => sipTag(item, 'remote_tag')),
      route_set: routeSet(value.route_set),
      local_cseq: boundedInteger(value.local_cseq, 0, 0x7fff_ffff, 'local_cseq'),
      remote_cseq: boundedInteger(value.remote_cseq, 0, 0x7fff_ffff, 'remote_cseq'),
      branch_hash: sha256(value.branch_hash, 'branch_hash'),
      final_response_hash: nullable(
        value.final_response_hash,
        (item) => sha256(item, 'final_response_hash')
      ),
      auth_context_ref: identifier(value.auth_context_ref, 'auth_context_ref'),
      logical_offer_hash: nullable(
        value.logical_offer_hash,
        (item) => sha256(item, 'logical_offer_hash')
      ),
      logical_answer_hash: nullable(
        value.logical_answer_hash,
        (item) => sha256(item, 'logical_answer_hash')
      ),
      media_reservation_id: nullable(
        value.media_reservation_id,
        (item) => identifier(item, 'media_reservation_id')
      ),
      provider_session_ref: nullable(
        value.provider_session_ref,
        (item) => identifier(item, 'provider_session_ref')
      ),
      cdr_sequence: boundedInteger(
        value.cdr_sequence,
        0,
        Number.MAX_SAFE_INTEGER,
        'cdr_sequence'
      ),
      recorded_at: timestamp(value.recorded_at),
      terminal: boolean(value.terminal, 'terminal')
    };
    if (result.terminal !== (result.state === 'terminated')) {
      throw new Error('terminal state mismatch');
    }
    if (Buffer.byteLength(canonicalJson(result), 'utf8') > 32 * 1024) {
      throw new Error('record exceeds maximum size');
    }
    return result;
  } catch (error) {
    if (error instanceof DialogShadowError) throw error;
    throw new DialogShadowError('dialog_shadow_record_invalid', 400, error);
  }
}

export function dialogShadowRecordHash(value: DialogShadowRecord): string {
  const record = assertDialogShadowRecord(value);
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

export class DialogShadowError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'DialogShadowError';
    this.code = code;
    this.status = status;
  }
}

function validReplicaHealth(
  value: DialogShadowReplicaHealth,
  local: { cell_id: string; node_id: string; fault_domain: string }
): boolean {
  try {
    return value.cell_id === local.cell_id &&
      identifier(value.node_id, 'node_id') !== local.node_id &&
      identifier(value.fault_domain, 'fault_domain') !== local.fault_domain &&
      value.durable === true &&
      value.ready === true;
  } catch {
    return false;
  }
}

function validReplicaAck(
  value: DialogShadowReplicaAck,
  record: DialogShadowRecord,
  hash: string,
  local: { cell_id: string; node_id: string; fault_domain: string }
): boolean {
  try {
    return value.schema_version === 1 &&
      value.cell_id === record.cell_id &&
      value.dialog_id === record.dialog_id &&
      value.owner_epoch === record.owner_epoch &&
      value.sequence === record.sequence &&
      value.record_hash === hash &&
      value.node_id !== local.node_id &&
      value.fault_domain !== local.fault_domain &&
      value.durable === true &&
      Number.isFinite(Date.parse(value.acknowledged_at)) &&
      identifier(value.node_id, 'node_id').length > 0 &&
      identifier(value.fault_domain, 'fault_domain').length > 0;
  } catch {
    return false;
  }
}

function requiresShadow(profile: DialogShadowProfile): boolean {
  return profile === 'VOICE-HA-T1';
}

function unavailable(cause?: unknown): DialogShadowError {
  return new DialogShadowError('dialog_shadow_quorum_unavailable', 503, cause);
}

function identifier(value: unknown, field: string): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function sha256(value: unknown, field: string): string {
  const result = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
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

function shadowState(value: unknown): DialogShadowState {
  if (!DIALOG_STATES.includes(value as DialogShadowState)) {
    throw new Error('state is invalid');
  }
  return value as DialogShadowState;
}

function sipTag(value: unknown, field: string): string {
  const result = String(value || '');
  if (result.length > 256 ||
      !/^[A-Za-z0-9.!%*_+`'~-]+$/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function routeSet(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error('route_set is invalid');
  }
  return value.map((item) => {
    const route = String(item || '');
    if (route.length > 512 || route.includes('@') ||
        !/^sips?:[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:;[A-Za-z0-9._~!$&'()*+,;=:%-]+)*$/.test(route)) {
      throw new Error('route_set is invalid');
    }
    return route;
  });
}

function nullable<T>(
  value: unknown,
  decode: (value: unknown) => T
): T | null {
  return value === null ? null : decode(value);
}

function timestamp(value: unknown): string {
  const result = String(value || '');
  if (!Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString() !== result) {
    throw new Error('recorded_at is invalid');
  }
  return result;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} is invalid`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}
