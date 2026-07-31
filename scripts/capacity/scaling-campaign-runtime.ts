import { createHash } from 'node:crypto';

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import {
  finalizeCapacityScalingCampaign,
  type CapacityScalingCampaignResult,
  type CapacityScalingCampaignSubmission,
  type CapacityScalingProbeReference,
  type CapacityScalingRunEvidenceDocument
} from './scaling-campaign.js';
import type { CapacityEvidenceObjectStore } from './orchestrator/worker-runtime.js';

export interface CapacityScalingPgQueryable {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface CapacityEvidenceDocumentReader {
  get(input: {
    object_uri: string;
    maximum_bytes: number;
    signal: AbortSignal;
  }): Promise<Uint8Array>;
}

export interface VerifiedCapacityRunReference {
  run_id: string;
  manifest_sha256: string;
  evidence_manifest_sha256: string;
}

export class PostgresVerifiedCapacityRunEvidenceSource {
  readonly #pg: CapacityScalingPgQueryable;
  readonly #reader: CapacityEvidenceDocumentReader;

  constructor(pg: CapacityScalingPgQueryable, reader: CapacityEvidenceDocumentReader) {
    this.#pg = pg;
    this.#reader = reader;
  }

  async load(
    reference: VerifiedCapacityRunReference,
    signal: AbortSignal = new AbortController().signal
  ): Promise<CapacityScalingRunEvidenceDocument> {
    const result = await this.#pg.query(
      `SELECT run.run_id, run.state AS run_state, run.outcome AS run_outcome,
         run.manifest, run.manifest_sha256,
         run.evidence_manifest_sha256 AS run_evidence_manifest_sha256,
         evidence.state AS evidence_state,
         evidence.object_uri AS evidence_object_uri,
         evidence.sha256 AS evidence_sha256,
         evidence.byte_size AS evidence_byte_size
       FROM ivekit_capacity_load_runs run
       JOIN ivekit_capacity_evidence evidence
         ON evidence.run_id = run.run_id
        AND evidence.phase_id IS NULL
        AND evidence.shard_id IS NULL
        AND evidence.kind = 'run_evidence_manifest'
       WHERE run.run_id = $1`,
      [reference.run_id]
    );
    if (result.rows.length !== 1) {
      throw new Error(`run ${reference.run_id} has no unique run evidence record`);
    }
    const row = result.rows[0];
    const manifest = jsonObject(row.manifest, 'run manifest');
    if (String(row.run_id) !== reference.run_id ||
        String(row.manifest_sha256) !== reference.manifest_sha256 ||
        canonicalSha256(manifest) !== reference.manifest_sha256) {
      throw new Error(`run ${reference.run_id} database manifest SHA-256 mismatch`);
    }
    if (String(row.evidence_state) !== 'verified' ||
        String(row.run_evidence_manifest_sha256) !== reference.evidence_manifest_sha256 ||
        String(row.evidence_sha256) !== reference.evidence_manifest_sha256) {
      throw new Error(`run ${reference.run_id} evidence is not verified at the expected SHA-256`);
    }
    const byteSize = positiveSafeInteger(row.evidence_byte_size, 'evidence byte size');
    if (byteSize > 16 * 1024 * 1024) throw new Error('capacity run evidence exceeds the read limit');
    const body = await this.#reader.get({
      object_uri: String(row.evidence_object_uri || ''),
      maximum_bytes: 16 * 1024 * 1024,
      signal
    });
    if (body.byteLength !== byteSize || sha256(body) !== reference.evidence_manifest_sha256) {
      throw new Error(`run ${reference.run_id} evidence object SHA-256 mismatch`);
    }
    let document: CapacityScalingRunEvidenceDocument;
    try {
      document = JSON.parse(Buffer.from(body).toString('utf8')) as CapacityScalingRunEvidenceDocument;
    } catch {
      throw new Error(`run ${reference.run_id} evidence object is not JSON`);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document) ||
        canonicalSha256(document) !== reference.evidence_manifest_sha256 ||
        canonicalSha256(document.manifest) !== reference.manifest_sha256 ||
        canonicalSha256(document.manifest) !== canonicalSha256(manifest)) {
      throw new Error(`run ${reference.run_id} evidence document identity mismatch`);
    }
    const expectedState = document.validation.outcome === 'passed'
      ? 'completed'
      : document.validation.outcome === 'not_run'
        ? 'not_run'
        : 'failed';
    if (String(row.run_state) !== expectedState ||
        String(row.run_outcome) !== document.validation.outcome) {
      throw new Error(`run ${reference.run_id} terminal outcome mismatch`);
    }
    return structuredClone(document);
  }
}

export interface CapacityScalingCampaignRecord {
  state: 'finalizing' | 'completed' | 'failed' | 'not_run';
  submission_sha256: string;
  outcome: string;
  capacity_claim: 'none' | 'component_pass' | 'cell_pass';
  controller_lease_epoch: string;
  evidence_object_uri: string;
  evidence_sha256: string;
  evidence_byte_size: number;
}

export interface CapacityScalingCampaignControl {
  ensureCampaign(input: {
    submission: CapacityScalingCampaignSubmission;
    submission_sha256: string;
    result: CapacityScalingCampaignResult;
    now: string;
  }): Promise<CapacityScalingCampaignRecord>;
  claimCampaign(input: {
    campaign_id: string;
    submission_sha256: string;
    controller_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityScalingCampaignRecord>;
  completeCampaign(input: {
    campaign_id: string;
    submission_sha256: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: CapacityScalingCampaignResult['outcome'];
    capacity_claim: CapacityScalingCampaignResult['capacity_claim'];
    evidence_object_uri: string;
    evidence_sha256: string;
    evidence_byte_size: number;
    failure_code: string;
    now: string;
  }): Promise<CapacityScalingCampaignRecord>;
}

export class CapacityScalingCampaignEvidenceFinalizer {
  readonly #control: CapacityScalingCampaignControl;
  readonly #source: PostgresVerifiedCapacityRunEvidenceSource;
  readonly #objectStore: CapacityEvidenceObjectStore;
  readonly #controllerId: string;
  readonly #leaseTtlMs: number;
  readonly #evidencePrefix: string;
  readonly #now: () => string;

  constructor(input: {
    control: CapacityScalingCampaignControl;
    source: PostgresVerifiedCapacityRunEvidenceSource;
    object_store: CapacityEvidenceObjectStore;
    controller_id: string;
    lease_ttl_ms: number;
    evidence_prefix: string;
    now?: () => string;
  }) {
    this.#control = input.control;
    this.#source = input.source;
    this.#objectStore = input.object_store;
    safeId(input.controller_id, 'controller_id');
    this.#controllerId = input.controller_id;
    this.#leaseTtlMs = boundedInteger(input.lease_ttl_ms, 1_000, 300_000, 'lease_ttl_ms');
    this.#evidencePrefix = evidencePrefix(input.evidence_prefix);
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async finalize(input: {
    contract: Parameters<typeof finalizeCapacityScalingCampaign>[0]['contract'];
    submission: CapacityScalingCampaignSubmission;
  }, signal?: AbortSignal): Promise<CapacityScalingCampaignResult> {
    const activeSignal = signal ?? new AbortController().signal;
    const result = await finalizeCapacityScalingCampaign({
      ...input,
      load_run_evidence: (reference) => this.#source.load(reference, activeSignal)
    });
    const body = Buffer.from(canonicalJson(result));
    if (body.byteLength > 16 * 1024 * 1024) throw new Error('scaling campaign evidence is too large');
    const evidenceSha256 = sha256(body);
    const now = validTimestamp(this.#now());
    let record = await this.#control.ensureCampaign({
      submission: input.submission,
      submission_sha256: result.submission_sha256,
      result,
      now
    });
    if (record.state !== 'finalizing') {
      assertTerminalCampaign(record, result, evidenceSha256, body.byteLength);
      return result;
    }
    record = await this.#control.claimCampaign({
      campaign_id: result.campaign_id,
      submission_sha256: result.submission_sha256,
      controller_id: this.#controllerId,
      lease_ttl_ms: this.#leaseTtlMs,
      now
    });
    const key = `${this.#evidencePrefix}/${result.campaign_id}/scaling-${evidenceSha256}.json`;
    const uploaded = await this.#objectStore.put({
      key,
      body,
      sha256: evidenceSha256,
      content_type: 'application/json',
      signal: activeSignal
    });
    record = await this.#control.completeCampaign({
      campaign_id: result.campaign_id,
      submission_sha256: result.submission_sha256,
      controller_id: this.#controllerId,
      controller_lease_epoch: record.controller_lease_epoch,
      outcome: result.outcome,
      capacity_claim: result.capacity_claim,
      evidence_object_uri: uploaded.object_uri,
      evidence_sha256: evidenceSha256,
      evidence_byte_size: body.byteLength,
      failure_code: campaignFailureCode(result.outcome),
      now: validTimestamp(this.#now())
    });
    assertTerminalCampaign(record, result, evidenceSha256, body.byteLength);
    return result;
  }
}

export class PostgresCapacityScalingCampaignRepository
implements CapacityScalingCampaignControl {
  readonly #pg: CapacityScalingPgQueryable;

  constructor(pg: CapacityScalingPgQueryable) {
    this.#pg = pg;
  }

  async ensureCampaign(input: Parameters<CapacityScalingCampaignControl['ensureCampaign']>[0]): Promise<CapacityScalingCampaignRecord> {
    const result = await this.#pg.query(
      `WITH campaign AS (
         INSERT INTO ivekit_capacity_scaling_campaigns
           (campaign_id, contract_id, contract_sha256, submission_sha256,
            submission, curve_id, scope, mode, identity, source_run_count,
            state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb,
           $10, 'finalizing', $11::timestamptz, $11::timestamptz)
         ON CONFLICT (campaign_id) DO UPDATE
           SET updated_at = ivekit_capacity_scaling_campaigns.updated_at
         WHERE ivekit_capacity_scaling_campaigns.submission_sha256 = EXCLUDED.submission_sha256
           AND ivekit_capacity_scaling_campaigns.contract_sha256 = EXCLUDED.contract_sha256
         RETURNING campaign_id
       ), probe_input AS (
         SELECT * FROM jsonb_to_recordset($12::jsonb) AS probe(
           units integer, attempt integer, phase text, requested_load integer,
           run_id text, manifest_sha256 text, evidence_manifest_sha256 text,
           dominant_resource text
         )
       ), inserted_probes AS (
         INSERT INTO ivekit_capacity_scaling_campaign_runs
           (campaign_id, units, attempt, phase, requested_load, run_id,
            manifest_sha256, evidence_manifest_sha256, dominant_resource, created_at)
         SELECT $1, probe.units, probe.attempt, probe.phase, probe.requested_load,
           probe.run_id, probe.manifest_sha256, probe.evidence_manifest_sha256,
           probe.dominant_resource, $11::timestamptz
         FROM probe_input probe JOIN campaign ON true
         ON CONFLICT DO NOTHING
         RETURNING run_id
       )
       SELECT target.state, target.submission_sha256, target.outcome,
         target.capacity_claim, target.controller_lease_epoch,
         target.evidence_object_uri, target.evidence_sha256,
         target.evidence_byte_size,
         (SELECT COUNT(*)::integer FROM ivekit_capacity_scaling_campaign_runs refs
          WHERE refs.campaign_id = target.campaign_id) AS reference_count
       FROM ivekit_capacity_scaling_campaigns target
       WHERE target.campaign_id = $1 AND target.submission_sha256 = $4`,
      [
        input.submission.campaign_id,
        input.submission.contract_id,
        input.submission.contract_sha256,
        input.submission_sha256,
        JSON.stringify(input.submission),
        input.submission.curve_id,
        input.result.scope,
        input.submission.mode,
        JSON.stringify(input.submission.identity),
        input.submission.probes.length,
        input.now,
        JSON.stringify(input.submission.probes)
      ]
    );
    const row = result.rows[0];
    if (!row || Number(row.reference_count) !== input.submission.probes.length) {
      throw new Error('scaling campaign immutable registration failed');
    }
    return campaignRecord(row);
  }

  async claimCampaign(input: Parameters<CapacityScalingCampaignControl['claimCampaign']>[0]): Promise<CapacityScalingCampaignRecord> {
    const expiresAt = new Date(Date.parse(input.now) + input.lease_ttl_ms).toISOString();
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_scaling_campaigns
       SET controller_lease_epoch = CASE
             WHEN controller_id = $3 AND controller_lease_expires_at > $4::timestamptz
               THEN controller_lease_epoch
             ELSE controller_lease_epoch + 1
           END,
           controller_id = $3,
           controller_lease_expires_at = $5::timestamptz,
           updated_at = $4::timestamptz
       WHERE campaign_id = $1 AND submission_sha256 = $2
         AND state = 'finalizing'
         AND (controller_id = $3 OR controller_lease_expires_at IS NULL
           OR controller_lease_expires_at <= $4::timestamptz)
       RETURNING state, submission_sha256, outcome, capacity_claim,
         controller_lease_epoch, evidence_object_uri, evidence_sha256,
         evidence_byte_size`,
      [input.campaign_id, input.submission_sha256, input.controller_id, input.now, expiresAt]
    );
    if (!result.rows[0]) throw new Error('scaling campaign lease is unavailable');
    return campaignRecord(result.rows[0]);
  }

  async completeCampaign(input: Parameters<CapacityScalingCampaignControl['completeCampaign']>[0]): Promise<CapacityScalingCampaignRecord> {
    const state = input.outcome === 'passed'
      ? 'completed'
      : input.outcome === 'not_run'
        ? 'not_run'
        : 'failed';
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_scaling_campaigns
       SET state = $5, outcome = $6, capacity_claim = $7,
         evidence_object_uri = $8, evidence_sha256 = $9,
         evidence_byte_size = $10, failure_code = $11,
         completed_at = $12::timestamptz, updated_at = $12::timestamptz
       WHERE campaign_id = $1 AND submission_sha256 = $2
         AND controller_id = $3 AND controller_lease_epoch = $4::bigint
         AND controller_lease_expires_at > $12::timestamptz
         AND state = 'finalizing'
       RETURNING state, submission_sha256, outcome, capacity_claim,
         controller_lease_epoch, evidence_object_uri, evidence_sha256,
         evidence_byte_size`,
      [
        input.campaign_id, input.submission_sha256, input.controller_id,
        input.controller_lease_epoch, state, input.outcome,
        input.capacity_claim, input.evidence_object_uri, input.evidence_sha256,
        input.evidence_byte_size, input.failure_code, input.now
      ]
    );
    if (!result.rows[0]) throw new Error('scaling campaign finalization fence rejected the update');
    return campaignRecord(result.rows[0]);
  }
}

function campaignRecord(row: Record<string, unknown>): CapacityScalingCampaignRecord {
  const state = String(row.state);
  const claim = String(row.capacity_claim);
  if (!['finalizing', 'completed', 'failed', 'not_run'].includes(state) ||
      !['none', 'component_pass', 'cell_pass'].includes(claim)) {
    throw new Error('scaling campaign database record is invalid');
  }
  return {
    state: state as CapacityScalingCampaignRecord['state'],
    submission_sha256: String(row.submission_sha256 || ''),
    outcome: String(row.outcome || ''),
    capacity_claim: claim as CapacityScalingCampaignRecord['capacity_claim'],
    controller_lease_epoch: decimalEpoch(row.controller_lease_epoch),
    evidence_object_uri: String(row.evidence_object_uri || ''),
    evidence_sha256: String(row.evidence_sha256 || ''),
    evidence_byte_size: Number(row.evidence_byte_size || 0)
  };
}

function assertTerminalCampaign(
  record: CapacityScalingCampaignRecord,
  result: CapacityScalingCampaignResult,
  evidenceSha256: string,
  byteSize: number
): void {
  const expectedState = result.outcome === 'passed'
    ? 'completed'
    : result.outcome === 'not_run'
      ? 'not_run'
      : 'failed';
  if (record.state !== expectedState || record.outcome !== result.outcome ||
      record.capacity_claim !== result.capacity_claim ||
      !record.evidence_object_uri || record.evidence_sha256 !== evidenceSha256 ||
      record.evidence_byte_size !== byteSize) {
    throw new Error('scaling campaign terminal evidence mismatch');
  }
}

function campaignFailureCode(outcome: CapacityScalingCampaignResult['outcome']): string {
  if (outcome === 'passed') return '';
  if (outcome === 'not_run') return 'capacity_curve_not_run';
  if (outcome === 'invalid_generator_capacity') return 'invalid_generator_capacity';
  return 'capacity_curve_failed';
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} is invalid`);
  return parsed;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function decimalEpoch(value: unknown): string {
  const text = String(value ?? '0');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) throw new Error('scaling campaign lease epoch is invalid');
  return text;
}

function safeId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new Error(`scaling campaign ${field} is invalid`);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`scaling campaign ${field} is invalid`);
  }
  return value;
}

function evidencePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.length > 512 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) ||
      normalized.split('/').some((part) => !part || part === '..')) {
    throw new Error('scaling campaign evidence prefix is invalid');
  }
  return normalized;
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('scaling campaign timestamp is invalid');
  return new Date(value).toISOString();
}
