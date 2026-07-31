import { createHash } from 'node:crypto';

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import {
  finalizeCapacityPlatformCampaign,
  type CapacityPlatformCampaignResult,
  type CapacityPlatformCampaignSubmission,
  type CapacityPlatformEndpointReference,
  type CapacityPlatformScalingReference
} from './platform-campaign.js';
import type { CapacityScalingCampaignResult } from './scaling-campaign.js';
import {
  PostgresVerifiedCapacityRunEvidenceSource,
  type CapacityEvidenceDocumentReader,
  type CapacityScalingPgQueryable
} from './scaling-campaign-runtime.js';
import type { CapacityEvidenceObjectStore } from './orchestrator/worker-runtime.js';

export interface CapacityScalingCampaignEvidenceSource {
  load(
    reference: CapacityPlatformScalingReference,
    signal?: AbortSignal
  ): Promise<CapacityScalingCampaignResult>;
}

export class PostgresVerifiedCapacityScalingCampaignSource
implements CapacityScalingCampaignEvidenceSource {
  readonly #pg: CapacityScalingPgQueryable;
  readonly #reader: CapacityEvidenceDocumentReader;

  constructor(pg: CapacityScalingPgQueryable, reader: CapacityEvidenceDocumentReader) {
    this.#pg = pg;
    this.#reader = reader;
  }

  async load(
    reference: CapacityPlatformScalingReference,
    signal: AbortSignal = new AbortController().signal
  ): Promise<CapacityScalingCampaignResult> {
    const query = await this.#pg.query(
      `SELECT campaign_id, state, outcome, capacity_claim, submission_sha256,
         evidence_object_uri, evidence_sha256, evidence_byte_size
       FROM ivekit_capacity_scaling_campaigns
       WHERE campaign_id = $1`,
      [reference.campaign_id]
    );
    if (query.rows.length !== 1) {
      throw new Error(`scaling campaign ${reference.campaign_id} is not uniquely registered`);
    }
    const row = query.rows[0];
    if (String(row.campaign_id) !== reference.campaign_id ||
        String(row.submission_sha256) !== reference.submission_sha256 ||
        String(row.evidence_sha256) !== reference.evidence_sha256 ||
        !['completed', 'failed', 'not_run'].includes(String(row.state))) {
      throw new Error(`scaling campaign ${reference.campaign_id} has no matching terminal evidence`);
    }
    const byteSize = positiveSafeInteger(row.evidence_byte_size, 'scaling evidence byte size');
    if (byteSize > 16 * 1024 * 1024) throw new Error('scaling campaign evidence exceeds the read limit');
    const body = await this.#reader.get({
      object_uri: String(row.evidence_object_uri || ''),
      maximum_bytes: 16 * 1024 * 1024,
      signal
    });
    if (body.byteLength !== byteSize || sha256(body) !== reference.evidence_sha256) {
      throw new Error(`scaling campaign ${reference.campaign_id} evidence object SHA-256 mismatch`);
    }
    let document: CapacityScalingCampaignResult;
    try {
      document = JSON.parse(Buffer.from(body).toString('utf8')) as CapacityScalingCampaignResult;
    } catch {
      throw new Error(`scaling campaign ${reference.campaign_id} evidence object is not JSON`);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document) ||
        canonicalSha256(document) !== reference.evidence_sha256 ||
        document.campaign_id !== reference.campaign_id ||
        document.submission_sha256 !== reference.submission_sha256 ||
        String(row.outcome) !== document.outcome ||
        String(row.capacity_claim) !== document.capacity_claim ||
        String(row.state) !== terminalState(document.outcome)) {
      throw new Error(`scaling campaign ${reference.campaign_id} terminal evidence mismatch`);
    }
    return structuredClone(document);
  }
}

export interface CapacityPlatformCampaignRecord {
  state: 'finalizing' | 'completed' | 'failed' | 'not_run';
  submission_sha256: string;
  outcome: string;
  capacity_claim: 'none' | 'platform_pass';
  controller_lease_epoch: string;
  evidence_object_uri: string;
  evidence_sha256: string;
  evidence_byte_size: number;
}

export interface CapacityPlatformCampaignControl {
  ensureCampaign(input: {
    submission: CapacityPlatformCampaignSubmission;
    submission_sha256: string;
    result: CapacityPlatformCampaignResult;
    now: string;
  }): Promise<CapacityPlatformCampaignRecord>;
  claimCampaign(input: {
    platform_campaign_id: string;
    submission_sha256: string;
    controller_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityPlatformCampaignRecord>;
  completeCampaign(input: {
    platform_campaign_id: string;
    submission_sha256: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: CapacityPlatformCampaignResult['outcome'];
    capacity_claim: CapacityPlatformCampaignResult['capacity_claim'];
    evidence_object_uri: string;
    evidence_sha256: string;
    evidence_byte_size: number;
    failure_code: string;
    now: string;
  }): Promise<CapacityPlatformCampaignRecord>;
}

export class CapacityPlatformCampaignEvidenceFinalizer {
  readonly #control: CapacityPlatformCampaignControl;
  readonly #scalingSource: CapacityScalingCampaignEvidenceSource;
  readonly #endpointSource: PostgresVerifiedCapacityRunEvidenceSource;
  readonly #objectStore: CapacityEvidenceObjectStore;
  readonly #controllerId: string;
  readonly #leaseTtlMs: number;
  readonly #evidencePrefix: string;
  readonly #now: () => string;

  constructor(input: {
    control: CapacityPlatformCampaignControl;
    scaling_source: CapacityScalingCampaignEvidenceSource;
    endpoint_source: PostgresVerifiedCapacityRunEvidenceSource;
    object_store: CapacityEvidenceObjectStore;
    controller_id: string;
    lease_ttl_ms: number;
    evidence_prefix: string;
    now?: () => string;
  }) {
    this.#control = input.control;
    this.#scalingSource = input.scaling_source;
    this.#endpointSource = input.endpoint_source;
    this.#objectStore = input.object_store;
    safeId(input.controller_id, 'controller_id');
    this.#controllerId = input.controller_id;
    this.#leaseTtlMs = boundedInteger(input.lease_ttl_ms, 1_000, 300_000, 'lease_ttl_ms');
    this.#evidencePrefix = evidencePrefix(input.evidence_prefix);
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async finalize(input: {
    contract: Parameters<typeof finalizeCapacityPlatformCampaign>[0]['contract'];
    submission: CapacityPlatformCampaignSubmission;
  }, signal?: AbortSignal): Promise<CapacityPlatformCampaignResult> {
    const activeSignal = signal ?? new AbortController().signal;
    const result = await finalizeCapacityPlatformCampaign({
      ...input,
      load_scaling_campaign: (reference) => this.#scalingSource.load(reference, activeSignal),
      load_endpoint_run: (reference) => this.#endpointSource.load(reference, activeSignal)
    });
    const body = Buffer.from(canonicalJson(result));
    if (body.byteLength > 16 * 1024 * 1024) throw new Error('platform campaign evidence is too large');
    const evidenceSha256 = sha256(body);
    const now = validTimestamp(this.#now());
    let record = await this.#control.ensureCampaign({
      submission: input.submission,
      submission_sha256: result.submission_sha256,
      result,
      now
    });
    if (record.state !== 'finalizing') {
      assertTerminal(record, result, evidenceSha256, body.byteLength);
      return result;
    }
    record = await this.#control.claimCampaign({
      platform_campaign_id: result.platform_campaign_id,
      submission_sha256: result.submission_sha256,
      controller_id: this.#controllerId,
      lease_ttl_ms: this.#leaseTtlMs,
      now
    });
    const uploaded = await this.#objectStore.put({
      key: `${this.#evidencePrefix}/${result.platform_campaign_id}/platform-${evidenceSha256}.json`,
      body,
      sha256: evidenceSha256,
      content_type: 'application/json',
      signal: activeSignal
    });
    record = await this.#control.completeCampaign({
      platform_campaign_id: result.platform_campaign_id,
      submission_sha256: result.submission_sha256,
      controller_id: this.#controllerId,
      controller_lease_epoch: record.controller_lease_epoch,
      outcome: result.outcome,
      capacity_claim: result.capacity_claim,
      evidence_object_uri: uploaded.object_uri,
      evidence_sha256: evidenceSha256,
      evidence_byte_size: body.byteLength,
      failure_code: result.outcome === 'passed' ? '' : `capacity_platform_${result.outcome}`,
      now: validTimestamp(this.#now())
    });
    assertTerminal(record, result, evidenceSha256, body.byteLength);
    return result;
  }
}

export class PostgresCapacityPlatformCampaignRepository
implements CapacityPlatformCampaignControl {
  readonly #pg: CapacityScalingPgQueryable;

  constructor(pg: CapacityScalingPgQueryable) {
    this.#pg = pg;
  }

  async ensureCampaign(input: Parameters<CapacityPlatformCampaignControl['ensureCampaign']>[0]): Promise<CapacityPlatformCampaignRecord> {
    const result = await this.#pg.query(
      `WITH platform AS (
         INSERT INTO ivekit_capacity_platform_campaigns
           (platform_campaign_id, contract_id, contract_sha256, submission_sha256,
            submission, mode, profile_id, profile_sha256, scaling_campaign_count,
            endpoint_run_id, endpoint_manifest_sha256, endpoint_evidence_sha256,
            state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12,
           'finalizing', $13::timestamptz, $13::timestamptz)
         ON CONFLICT (platform_campaign_id) DO UPDATE
           SET updated_at = ivekit_capacity_platform_campaigns.updated_at
         WHERE ivekit_capacity_platform_campaigns.submission_sha256 = EXCLUDED.submission_sha256
           AND ivekit_capacity_platform_campaigns.contract_sha256 = EXCLUDED.contract_sha256
         RETURNING platform_campaign_id
       ), source_input AS (
         SELECT * FROM jsonb_to_recordset($14::jsonb) AS source(
           campaign_id text, submission_sha256 text, evidence_sha256 text
         )
       ), inserted_sources AS (
         INSERT INTO ivekit_capacity_platform_scaling_refs
           (platform_campaign_id, campaign_id, submission_sha256, evidence_sha256, created_at)
         SELECT $1, source.campaign_id, source.submission_sha256, source.evidence_sha256,
           $13::timestamptz
         FROM source_input source JOIN platform ON true
         ON CONFLICT DO NOTHING
         RETURNING campaign_id
       )
       SELECT target.state, target.submission_sha256, target.outcome,
         target.capacity_claim, target.controller_lease_epoch,
         target.evidence_object_uri, target.evidence_sha256, target.evidence_byte_size,
         (SELECT COUNT(*)::integer FROM ivekit_capacity_platform_scaling_refs refs
          WHERE refs.platform_campaign_id = target.platform_campaign_id) AS reference_count
       FROM ivekit_capacity_platform_campaigns target
       WHERE target.platform_campaign_id = $1 AND target.submission_sha256 = $4`,
      [
        input.submission.platform_campaign_id,
        input.submission.contract_id,
        input.submission.contract_sha256,
        input.submission_sha256,
        JSON.stringify(input.submission),
        input.submission.mode,
        input.submission.profile_id,
        input.submission.profile_sha256,
        input.submission.scaling_campaigns.length,
        input.submission.endpoint_run.run_id,
        input.submission.endpoint_run.manifest_sha256,
        input.submission.endpoint_run.evidence_manifest_sha256,
        input.now,
        JSON.stringify(input.submission.scaling_campaigns)
      ]
    );
    const row = result.rows[0];
    if (!row || Number(row.reference_count) !== input.submission.scaling_campaigns.length) {
      throw new Error('platform campaign immutable registration failed');
    }
    return platformRecord(row);
  }

  async claimCampaign(input: Parameters<CapacityPlatformCampaignControl['claimCampaign']>[0]): Promise<CapacityPlatformCampaignRecord> {
    const expiresAt = new Date(Date.parse(input.now) + input.lease_ttl_ms).toISOString();
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_platform_campaigns
       SET controller_lease_epoch = CASE
             WHEN controller_id = $3 AND controller_lease_expires_at > $4::timestamptz
               THEN controller_lease_epoch
             ELSE controller_lease_epoch + 1
           END,
           controller_id = $3, controller_lease_expires_at = $5::timestamptz,
           updated_at = $4::timestamptz
       WHERE platform_campaign_id = $1 AND submission_sha256 = $2
         AND state = 'finalizing'
         AND (controller_id = $3 OR controller_lease_expires_at IS NULL
           OR controller_lease_expires_at <= $4::timestamptz)
       RETURNING state, submission_sha256, outcome, capacity_claim,
         controller_lease_epoch, evidence_object_uri, evidence_sha256, evidence_byte_size`,
      [input.platform_campaign_id, input.submission_sha256, input.controller_id, input.now, expiresAt]
    );
    if (!result.rows[0]) throw new Error('platform campaign lease is unavailable');
    return platformRecord(result.rows[0]);
  }

  async completeCampaign(input: Parameters<CapacityPlatformCampaignControl['completeCampaign']>[0]): Promise<CapacityPlatformCampaignRecord> {
    const state = terminalState(input.outcome);
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_platform_campaigns
       SET state = $5, outcome = $6, capacity_claim = $7,
         evidence_object_uri = $8, evidence_sha256 = $9, evidence_byte_size = $10,
         failure_code = $11, completed_at = $12::timestamptz, updated_at = $12::timestamptz
       WHERE platform_campaign_id = $1 AND submission_sha256 = $2
         AND controller_id = $3 AND controller_lease_epoch = $4::bigint
         AND controller_lease_expires_at > $12::timestamptz AND state = 'finalizing'
       RETURNING state, submission_sha256, outcome, capacity_claim,
         controller_lease_epoch, evidence_object_uri, evidence_sha256, evidence_byte_size`,
      [
        input.platform_campaign_id, input.submission_sha256, input.controller_id,
        input.controller_lease_epoch, state, input.outcome, input.capacity_claim,
        input.evidence_object_uri, input.evidence_sha256, input.evidence_byte_size,
        input.failure_code, input.now
      ]
    );
    if (!result.rows[0]) throw new Error('platform campaign finalization fence rejected the update');
    return platformRecord(result.rows[0]);
  }
}

function platformRecord(row: Record<string, unknown>): CapacityPlatformCampaignRecord {
  const state = String(row.state);
  const claim = String(row.capacity_claim);
  if (!['finalizing', 'completed', 'failed', 'not_run'].includes(state) ||
      !['none', 'platform_pass'].includes(claim)) {
    throw new Error('platform campaign database record is invalid');
  }
  return {
    state: state as CapacityPlatformCampaignRecord['state'],
    submission_sha256: String(row.submission_sha256 || ''),
    outcome: String(row.outcome || ''),
    capacity_claim: claim as CapacityPlatformCampaignRecord['capacity_claim'],
    controller_lease_epoch: decimalEpoch(row.controller_lease_epoch),
    evidence_object_uri: String(row.evidence_object_uri || ''),
    evidence_sha256: String(row.evidence_sha256 || ''),
    evidence_byte_size: Number(row.evidence_byte_size || 0)
  };
}

function assertTerminal(
  record: CapacityPlatformCampaignRecord,
  result: CapacityPlatformCampaignResult,
  evidenceSha256: string,
  byteSize: number
): void {
  if (record.state !== terminalState(result.outcome) || record.outcome !== result.outcome ||
      record.capacity_claim !== result.capacity_claim || !record.evidence_object_uri ||
      record.evidence_sha256 !== evidenceSha256 || record.evidence_byte_size !== byteSize) {
    throw new Error('platform campaign terminal evidence mismatch');
  }
}

function terminalState(outcome: string): CapacityPlatformCampaignRecord['state'] {
  return outcome === 'passed' ? 'completed' : outcome === 'not_run' ? 'not_run' : 'failed';
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
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) throw new Error('platform campaign lease epoch is invalid');
  return text;
}

function safeId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new Error(`platform campaign ${field} is invalid`);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`platform campaign ${field} is invalid`);
  }
  return value;
}

function evidencePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.length > 512 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) ||
      normalized.split('/').some((part) => !part || part === '..')) {
    throw new Error('platform campaign evidence prefix is invalid');
  }
  return normalized;
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('platform campaign timestamp is invalid');
  return new Date(value).toISOString();
}
