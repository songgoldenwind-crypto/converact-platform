import { types as utilTypes } from 'node:util';

import {
  deriveCallId,
  type CallId,
  VoiceFoundationIdentifierError
} from './foundation-identifiers.js';
import {
  getTrustedExistingVoiceCall,
  isTrustedPostgresVoiceCallStore,
  PostgresVoiceCallStore
} from './postgres/call-store.js';

const PROJECTION_ADAPTER_ISSUER = Symbol('voice-call-projection-id-adapter-issuer');
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEGACY_VCALL_PATTERN = /^vcall_[A-Za-z0-9][A-Za-z0-9._:@/-]{0,120}$/;
const LEGACY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Attests an existing legacy control-plane projection before deriving the
 * candidate CallId that the native RustPBX authority may adopt. This adapter
 * neither owns an active Call nor promotes provider/SIP identifiers.
 */
export class VoiceCallProjectionIdAdapter {
  readonly #calls: PostgresVoiceCallStore;

  private constructor(
    issuer: typeof PROJECTION_ADAPTER_ISSUER,
    calls: PostgresVoiceCallStore
  ) {
    if (issuer !== PROJECTION_ADAPTER_ISSUER) throw invalidLegacyCallId();
    this.#calls = calls;
    Object.freeze(this);
  }

  static bind(calls: PostgresVoiceCallStore): VoiceCallProjectionIdAdapter {
    if (!isTrustedPostgresVoiceCallStore(calls)) {
      throw invalidLegacyCallId();
    }
    return new VoiceCallProjectionIdAdapter(PROJECTION_ADAPTER_ISSUER, calls);
  }

  async resolveExisting(
    tenantIdInput: string,
    legacyCallIdInput: string
  ): Promise<CallId> {
    const tenantId = legacyTenantId(tenantIdInput);
    const format = legacyCallIdFormat(legacyCallIdInput);
    const stored = await getTrustedExistingVoiceCall(
      this.#calls,
      tenantId,
      legacyCallIdInput
    );
    if (typeof stored !== 'object' || stored === null ||
        utilTypes.isProxy(stored) ||
        stored.id !== legacyCallIdInput ||
        stored.tenant_id !== tenantId) {
      throw invalidLegacyCallId();
    }
    return deriveCallId(
      tenantId,
      'legacy-voice-call-repository',
      format,
      legacyCallIdInput
    );
  }
}

Object.freeze(VoiceCallProjectionIdAdapter.prototype);
Object.freeze(VoiceCallProjectionIdAdapter);

/** @deprecated Compatibility export; this object is not a Call authority. */
export const VoiceCallIdAuthorityAdapter = VoiceCallProjectionIdAdapter;

function legacyTenantId(value: unknown): string {
  if (typeof value !== 'string' || !TENANT_ID_PATTERN.test(value)) {
    throw invalidLegacyCallId();
  }
  return value;
}

function legacyCallIdFormat(value: unknown): 'vcall' | 'uuid' {
  if (typeof value !== 'string') throw invalidLegacyCallId();
  if (LEGACY_VCALL_PATTERN.test(value)) return 'vcall';
  if (LEGACY_UUID_PATTERN.test(value)) return 'uuid';
  throw invalidLegacyCallId();
}

function invalidLegacyCallId(): VoiceFoundationIdentifierError {
  return new VoiceFoundationIdentifierError(
    'voice_foundation_legacy_call_id_invalid'
  );
}
