import { randomUUID } from 'node:crypto';

import { safeVoiceProviderPayload } from './canonical.js';
import { VoiceError } from './errors.js';
import type { VoiceProviderEventUnitOfWorkContext } from './ports.js';
import type { VoiceCall, VoiceProviderEvent, VoiceRecording } from './types.js';

export interface VoiceRecordingServiceOptions {
  id?: () => string;
  now?: () => Date;
  lookup?: (input: {
    tenant_id: string;
    profile_id: string;
    provider_recording_id: string;
  }) => Promise<VoiceRecordingLookupResult>;
}

export interface VoiceRecordingLookupResult {
  state: 'processing' | 'available' | 'failed' | 'unknown';
  object_ref?: string;
  evidence_ref?: string;
  checksum?: string;
  duration_ms?: number | null;
  captured_at?: string | null;
}

export class VoiceRecordingService {
  readonly #id: () => string;
  readonly #now: () => Date;
  readonly #lookup?: VoiceRecordingServiceOptions['lookup'];

  constructor(options: VoiceRecordingServiceOptions = {}) {
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#lookup = options.lookup;
  }

  async project(
    context: VoiceProviderEventUnitOfWorkContext,
    call: VoiceCall,
    event: VoiceProviderEvent
  ): Promise<VoiceRecording | null> {
    const providerRecordingId = optionalText(event.safe_payload.recording_id, 256);
    if (!providerRecordingId) return null;
    const policy = await context.configuration.getPolicy(call.tenant_id);
    if (!policy || policy.status !== 'active' || policy.recording_mode === 'disabled') throw complianceDenied();
    let objectRef = optionalText(event.safe_payload.recording_object_ref, 2_048);
    let providerEvidenceRef = optionalText(event.safe_payload.recording_evidence_ref, 2_048);
    let checksum = optionalText(event.safe_payload.recording_checksum, 256);
    let capturedAt = optionalTimestamp(event.safe_payload.captured_at) ?? event.occurred_at;
    let durationMs = optionalNonNegativeInteger(event.safe_payload.duration_ms);
    let consentId: string | null = null;
    let evidenceRef = providerEvidenceRef;
    if (policy.recording_mode === 'consent_required') {
      const page = await context.configuration.listConsents({
        tenant_id: call.tenant_id, subject_ref_type: 'call', subject_ref_id: call.id, limit: 100
      });
      const now = this.#now().getTime();
      const consent = page.items.find((candidate) => candidate.consent_type === 'recording'
        && candidate.status === 'granted' && Boolean(candidate.evidence_ref)
        && (!candidate.expires_at || new Date(candidate.expires_at).getTime() > now));
      if (!consent) throw complianceDenied();
      consentId = consent.id;
      evidenceRef = consent.evidence_ref;
    }
    if (!objectRef || !providerEvidenceRef || !checksum) {
      if (!this.#lookup) throw providerPayloadInvalid();
      const found = await this.#lookup({
        tenant_id: call.tenant_id,
        profile_id: call.provider_profile_id,
        provider_recording_id: providerRecordingId
      });
      if (found.state === 'processing' || found.state === 'unknown') {
        throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
      }
      if (found.state !== 'available') throw providerPayloadInvalid();
      objectRef ||= optionalText(found.object_ref, 2_048);
      providerEvidenceRef ||= optionalText(found.evidence_ref, 2_048);
      checksum ||= optionalText(found.checksum, 256);
      capturedAt ||= optionalTimestamp(found.captured_at);
      durationMs ??= optionalNonNegativeInteger(found.duration_ms);
    }
    if (!objectRef || !providerEvidenceRef || !checksum) throw providerPayloadInvalid();
    capturedAt ??= this.#now().toISOString();
    if (policy.recording_mode !== 'consent_required') evidenceRef = providerEvidenceRef;
    const timestamp = this.#now().toISOString();
    const retentionUntil = new Date(this.#now().getTime() + policy.recording_retention_days * 86_400_000).toISOString();
    const recording: VoiceRecording = {
      id: boundedIdentifier(this.#id()), tenant_id: call.tenant_id, call_id: call.id,
      profile_id: call.provider_profile_id, provider_recording_id: providerRecordingId,
      status: 'available', recording_mode: policy.recording_mode, consent_id: consentId,
      object_ref: objectRef, evidence_ref: evidenceRef, checksum, duration_ms: durationMs,
      retention_until: retentionUntil, captured_at: capturedAt, deleted_at: null,
      metadata: safeVoiceProviderPayload({
        source_event_id: event.id,
        provider_evidence_ref: providerEvidenceRef
      }),
      created_at: timestamp, updated_at: timestamp
    };
    const existing = await context.recordings.getRecording(call.tenant_id, recording.id);
    if (!existing) return context.recordings.insertRecording(recording);
    return context.recordings.updateRecording({
      ...existing,
      status: recording.status,
      object_ref: recording.object_ref,
      evidence_ref: recording.evidence_ref,
      checksum: recording.checksum,
      duration_ms: recording.duration_ms,
      retention_until: recording.retention_until,
      captured_at: recording.captured_at,
      metadata: recording.metadata,
      updated_at: timestamp
    });
  }
}

function optionalText(value: unknown, max: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw protocolMismatch();
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(new Date(value).getTime())) throw protocolMismatch();
  return new Date(value).toISOString();
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw protocolMismatch();
  return Number(value);
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) throw protocolMismatch();
  return result;
}

function protocolMismatch(): VoiceError {
  return new VoiceError({ code: 'protocol_mismatch', status: 422 });
}

function complianceDenied(): VoiceError {
  return new VoiceError({ code: 'compliance_denied', status: 403 });
}

function providerPayloadInvalid(): VoiceError {
  return new VoiceError({ code: 'provider_payload_invalid', status: 422 });
}
