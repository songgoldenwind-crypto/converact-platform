import type { VoiceCallUnitOfWork, VoiceCompliancePort } from './ports.js';
import type { VoiceBusinessRef, VoiceCommandKind, VoiceConsent, VoicePolicy } from './types.js';
import { VoiceError } from './errors.js';

export interface VoicePolicyComplianceServiceOptions {
  unit_of_work: VoiceCallUnitOfWork;
  now?: () => Date;
}

export class VoicePolicyComplianceService implements VoiceCompliancePort {
  readonly #unitOfWork: VoiceCallUnitOfWork;
  readonly #now: () => Date;

  constructor(options: VoicePolicyComplianceServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#now = options.now ?? (() => new Date());
  }

  authorize(input: {
    tenant_id: string;
    call_id: string;
    command: VoiceCommandKind;
    actor_identity: string;
    business_ref?: VoiceBusinessRef;
  }): Promise<{ allowed: boolean; reason: string; evidence_ref: string }> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const callId = boundedIdentifier(input.call_id);
    boundedIdentifier(input.actor_identity);
    return this.#unitOfWork.run(tenantId, async ({ configuration }) => {
      const policy = await configuration.getPolicy(tenantId);
      if (!policy || policy.status !== 'active') return denied('policy_inactive');

      if (input.command === 'originate') {
        if (!policy.require_outbound_consent) return policyAllowed(policy);
        const ref = businessReference(input.business_ref);
        if (!ref) return denied('consent_required');
        const page = await configuration.listConsents({
          tenant_id: tenantId,
          subject_ref_type: ref.type,
          subject_ref_id: ref.id,
          limit: 100
        });
        const match = page.items.find((consent) =>
          consent.consent_type === 'outbound_call'
          && consent.business_ref_type === ref.type
          && consent.business_ref_id === ref.id
          && currentConsent(consent, this.#now()));
        return match ? consentAllowed(match) : denied('consent_required');
      }

      if (isRecordingCommand(input.command)) {
        if (policy.recording_mode === 'disabled') return denied('recording_disabled');
        if (policy.recording_mode === 'always') return policyAllowed(policy);
        const page = await configuration.listConsents({
          tenant_id: tenantId,
          subject_ref_type: 'call',
          subject_ref_id: callId,
          limit: 100
        });
        const match = page.items.find((consent) =>
          consent.consent_type === 'recording' && currentConsent(consent, this.#now()));
        return match ? consentAllowed(match) : denied('consent_required');
      }

      return policyAllowed(policy);
    });
  }
}

function businessReference(value: VoiceBusinessRef | undefined): VoiceBusinessRef | null {
  if (!value) return null;
  return { type: boundedIdentifier(value.type), id: boundedIdentifier(value.id) };
}

function currentConsent(consent: VoiceConsent, now: Date): boolean {
  return consent.status === 'granted'
    && Boolean(consent.evidence_ref)
    && (!consent.expires_at || new Date(consent.expires_at).getTime() > now.getTime());
}

function policyAllowed(policy: VoicePolicy): { allowed: true; reason: string; evidence_ref: string } {
  return {
    allowed: true,
    reason: 'policy',
    evidence_ref: `voice-policy:${boundedIdentifier(policy.id)}:${policy.revision}`
  };
}

function consentAllowed(consent: VoiceConsent): { allowed: true; reason: string; evidence_ref: string } {
  return { allowed: true, reason: 'consent', evidence_ref: consent.evidence_ref };
}

function denied(reason: string): { allowed: false; reason: string; evidence_ref: '' } {
  return { allowed: false, reason, evidence_ref: '' };
}

function isRecordingCommand(command: VoiceCommandKind): boolean {
  return command === 'recording_start' || command === 'recording_pause'
    || command === 'recording_resume' || command === 'recording_stop';
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return result;
}
