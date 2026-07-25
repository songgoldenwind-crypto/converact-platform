import type { PgQueryable } from '../../db-pg.js';
import type {
  IntelligenceProviderCapability,
  IntelligenceProviderProfile,
  IntelligenceProviderRegistry
} from './intelligence-provider-registry.js';

export interface IntelligencePolicyUpdate {
  ocr_enabled: boolean;
  asr_enabled: boolean;
  quality_review_enabled: boolean;
  translation_enabled: boolean;
  realtime_speech_enabled?: boolean;
  tts_enabled?: boolean;
  model_gateway_enabled?: boolean;
  ocr_profile_id?: string;
  asr_profile_id?: string;
  quality_profile_id?: string;
  translation_profile_id?: string;
  realtime_speech_profile_id?: string;
  tts_profile_id?: string;
  model_gateway_profile_id?: string;
  ocr_profile_ids?: string[];
  asr_profile_ids?: string[];
  quality_profile_ids?: string[];
  translation_profile_ids?: string[];
  realtime_speech_profile_ids?: string[];
  tts_profile_ids?: string[];
  model_gateway_profile_ids?: string[];
  allow_third_party: boolean;
  auto_ocr: boolean;
  auto_asr: boolean;
  auto_quality_review: boolean;
  auto_translation: boolean;
  translation_target_languages: string[];
  min_ocr_confidence: number;
  min_asr_confidence: number;
}

export interface IntelligencePolicy extends IntelligencePolicyUpdate {
  realtime_speech_enabled: boolean;
  tts_enabled: boolean;
  model_gateway_enabled: boolean;
  ocr_profile_id: string;
  asr_profile_id: string;
  quality_profile_id: string;
  translation_profile_id: string;
  realtime_speech_profile_id: string;
  tts_profile_id: string;
  model_gateway_profile_id: string;
  ocr_profile_ids: string[];
  asr_profile_ids: string[];
  quality_profile_ids: string[];
  translation_profile_ids: string[];
  realtime_speech_profile_ids: string[];
  tts_profile_ids: string[];
  model_gateway_profile_ids: string[];
  tenant_id: string;
  configured: boolean;
  version: number;
  updated_by: string;
  created_at: string | null;
  updated_at: string | null;
}

type NormalizedIntelligencePolicyUpdate = IntelligencePolicyUpdate & {
  realtime_speech_enabled: boolean;
  tts_enabled: boolean;
  model_gateway_enabled: boolean;
  ocr_profile_id: string;
  asr_profile_id: string;
  quality_profile_id: string;
  translation_profile_id: string;
  realtime_speech_profile_id: string;
  tts_profile_id: string;
  model_gateway_profile_id: string;
  ocr_profile_ids: string[];
  asr_profile_ids: string[];
  quality_profile_ids: string[];
  translation_profile_ids: string[];
  realtime_speech_profile_ids: string[];
  tts_profile_ids: string[];
  model_gateway_profile_ids: string[];
};

export class IntelligencePolicyStore {
  constructor(
    private readonly pg: PgQueryable,
    private readonly registry: IntelligenceProviderRegistry
  ) {}

  async getEffectivePolicy(tenantIdInput: string): Promise<IntelligencePolicy> {
    const tenantId = requiredText(tenantIdInput, 'tenant_id');
    const result = await this.pg.query(
      'SELECT * FROM collaboration_intelligence_policies WHERE tenant_id = $1',
      [tenantId]
    );
    return result.rows[0] ? decodePolicy(result.rows[0]) : this.defaultPolicy(tenantId);
  }

  async updatePolicy(input: {
    tenant_id: string;
    actor_identity: string;
    expected_version: number;
    policy: IntelligencePolicyUpdate;
  }): Promise<IntelligencePolicy> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id');
    const actor = requiredText(input.actor_identity, 'actor_identity').slice(0, 200);
    const expectedVersion = boundedInteger(input.expected_version, 0, 2_147_483_647, 'expected_version');
    const policy = this.normalizeUpdate(input.policy);
    const existing = await this.getEffectivePolicy(tenantId);
    if (existing.version !== expectedVersion) throw policyError('intelligence policy version conflict', 409);

    const result = await this.pg.query(
      `INSERT INTO collaboration_intelligence_policies
        (tenant_id, ocr_enabled, asr_enabled, quality_review_enabled, translation_enabled,
         realtime_speech_enabled, tts_enabled, model_gateway_enabled,
         ocr_profile_id, asr_profile_id, quality_profile_id, translation_profile_id,
         realtime_speech_profile_id, tts_profile_id, model_gateway_profile_id,
         ocr_profile_ids, asr_profile_ids, quality_profile_ids, translation_profile_ids,
         realtime_speech_profile_ids, tts_profile_ids, model_gateway_profile_ids,
         allow_third_party, auto_ocr, auto_asr, auto_quality_review, auto_translation,
         translation_target_languages, min_ocr_confidence, min_asr_confidence,
         version, updated_by)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15,
         $16::TEXT[], $17::TEXT[], $18::TEXT[], $19::TEXT[],
         $20::TEXT[], $21::TEXT[], $22::TEXT[],
         $23, $24, $25, $26, $27, $28::TEXT[], $29, $30, 1, $31)
       ON CONFLICT (tenant_id) DO UPDATE SET
         ocr_enabled = EXCLUDED.ocr_enabled,
         asr_enabled = EXCLUDED.asr_enabled,
         quality_review_enabled = EXCLUDED.quality_review_enabled,
         translation_enabled = EXCLUDED.translation_enabled,
         realtime_speech_enabled = EXCLUDED.realtime_speech_enabled,
         tts_enabled = EXCLUDED.tts_enabled,
         model_gateway_enabled = EXCLUDED.model_gateway_enabled,
         ocr_profile_id = EXCLUDED.ocr_profile_id,
         asr_profile_id = EXCLUDED.asr_profile_id,
         quality_profile_id = EXCLUDED.quality_profile_id,
         translation_profile_id = EXCLUDED.translation_profile_id,
         realtime_speech_profile_id = EXCLUDED.realtime_speech_profile_id,
         tts_profile_id = EXCLUDED.tts_profile_id,
         model_gateway_profile_id = EXCLUDED.model_gateway_profile_id,
         ocr_profile_ids = EXCLUDED.ocr_profile_ids,
         asr_profile_ids = EXCLUDED.asr_profile_ids,
         quality_profile_ids = EXCLUDED.quality_profile_ids,
         translation_profile_ids = EXCLUDED.translation_profile_ids,
         realtime_speech_profile_ids = EXCLUDED.realtime_speech_profile_ids,
         tts_profile_ids = EXCLUDED.tts_profile_ids,
         model_gateway_profile_ids = EXCLUDED.model_gateway_profile_ids,
         allow_third_party = EXCLUDED.allow_third_party,
         auto_ocr = EXCLUDED.auto_ocr,
         auto_asr = EXCLUDED.auto_asr,
         auto_quality_review = EXCLUDED.auto_quality_review,
         auto_translation = EXCLUDED.auto_translation,
         translation_target_languages = EXCLUDED.translation_target_languages,
         min_ocr_confidence = EXCLUDED.min_ocr_confidence,
         min_asr_confidence = EXCLUDED.min_asr_confidence,
         version = collaboration_intelligence_policies.version + 1,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       WHERE collaboration_intelligence_policies.version = $32
       RETURNING *`,
      [
        tenantId,
        policy.ocr_enabled,
        policy.asr_enabled,
        policy.quality_review_enabled,
        policy.translation_enabled,
        policy.realtime_speech_enabled,
        policy.tts_enabled,
        policy.model_gateway_enabled,
        policy.ocr_profile_id,
        policy.asr_profile_id,
        policy.quality_profile_id,
        policy.translation_profile_id,
        policy.realtime_speech_profile_id,
        policy.tts_profile_id,
        policy.model_gateway_profile_id,
        policy.ocr_profile_ids,
        policy.asr_profile_ids,
        policy.quality_profile_ids,
        policy.translation_profile_ids,
        policy.realtime_speech_profile_ids,
        policy.tts_profile_ids,
        policy.model_gateway_profile_ids,
        policy.allow_third_party,
        policy.auto_ocr,
        policy.auto_asr,
        policy.auto_quality_review,
        policy.auto_translation,
        policy.translation_target_languages,
        policy.min_ocr_confidence,
        policy.min_asr_confidence,
        actor,
        expectedVersion
      ]
    );
    if (!result.rows[0]) throw policyError('intelligence policy version conflict', 409);
    return decodePolicy(result.rows[0]);
  }

  private defaultPolicy(tenantId: string): IntelligencePolicy {
    const ocr = this.registry.defaultProfile('ocr');
    const asr = this.registry.defaultProfile('asr');
    const quality = this.registry.defaultProfile('quality_review');
    const defaults = [ocr, asr, quality].filter(Boolean) as IntelligenceProviderProfile[];
    return {
      tenant_id: tenantId,
      configured: false,
      ocr_enabled: true,
      asr_enabled: true,
      quality_review_enabled: true,
      translation_enabled: false,
      realtime_speech_enabled: false,
      tts_enabled: false,
      model_gateway_enabled: false,
      ocr_profile_id: ocr?.id || '',
      asr_profile_id: asr?.id || '',
      quality_profile_id: quality?.id || '',
      translation_profile_id: '',
      realtime_speech_profile_id: '',
      tts_profile_id: '',
      model_gateway_profile_id: '',
      ocr_profile_ids: ocr ? [ocr.id] : [],
      asr_profile_ids: asr ? [asr.id] : [],
      quality_profile_ids: quality ? [quality.id] : [],
      translation_profile_ids: [],
      realtime_speech_profile_ids: [],
      tts_profile_ids: [],
      model_gateway_profile_ids: [],
      allow_third_party: defaults.some((profile) => profile.mode === 'third_party'),
      auto_ocr: true,
      auto_asr: true,
      auto_quality_review: Boolean(quality),
      auto_translation: false,
      translation_target_languages: [],
      min_ocr_confidence: 0,
      min_asr_confidence: 0,
      version: 0,
      updated_by: '',
      created_at: null,
      updated_at: null
    };
  }

  private normalizeUpdate(input: IntelligencePolicyUpdate): NormalizedIntelligencePolicyUpdate {
    if (!input || typeof input !== 'object') throw policyError('policy is required', 400);
    const allowThirdParty = requiredBoolean(input.allow_third_party, 'allow_third_party');
    const ocrRoute = this.normalizeProfileRoute(
      input.ocr_profile_ids, input.ocr_profile_id, 'ocr', allowThirdParty, 'ocr_profile_ids'
    );
    const asrRoute = this.normalizeProfileRoute(
      input.asr_profile_ids, input.asr_profile_id, 'asr', allowThirdParty, 'asr_profile_ids'
    );
    const qualityRoute = this.normalizeProfileRoute(
      input.quality_profile_ids, input.quality_profile_id, 'quality_review', allowThirdParty,
      'quality_profile_ids'
    );
    const translationRoute = this.normalizeProfileRoute(
      input.translation_profile_ids, input.translation_profile_id, 'translation', allowThirdParty,
      'translation_profile_ids'
    );
    const realtimeSpeechRoute = this.normalizeProfileRoute(
      input.realtime_speech_profile_ids, input.realtime_speech_profile_id,
      'realtime_speech', allowThirdParty, 'realtime_speech_profile_ids'
    );
    const ttsRoute = this.normalizeProfileRoute(
      input.tts_profile_ids, input.tts_profile_id, 'tts', allowThirdParty, 'tts_profile_ids'
    );
    const modelGatewayRoute = this.normalizeProfileRoute(
      input.model_gateway_profile_ids, input.model_gateway_profile_id,
      'model_gateway', allowThirdParty, 'model_gateway_profile_ids'
    );
    const normalized = {
      ocr_enabled: requiredBoolean(input.ocr_enabled, 'ocr_enabled'),
      asr_enabled: requiredBoolean(input.asr_enabled, 'asr_enabled'),
      quality_review_enabled: requiredBoolean(input.quality_review_enabled, 'quality_review_enabled'),
      translation_enabled: requiredBoolean(input.translation_enabled, 'translation_enabled'),
      realtime_speech_enabled: optionalBoolean(
        input.realtime_speech_enabled, false, 'realtime_speech_enabled'
      ),
      tts_enabled: optionalBoolean(input.tts_enabled, false, 'tts_enabled'),
      model_gateway_enabled: optionalBoolean(
        input.model_gateway_enabled, false, 'model_gateway_enabled'
      ),
      ocr_profile_id: ocrRoute[0] || '',
      asr_profile_id: asrRoute[0] || '',
      quality_profile_id: qualityRoute[0] || '',
      translation_profile_id: translationRoute[0] || '',
      realtime_speech_profile_id: realtimeSpeechRoute[0] || '',
      tts_profile_id: ttsRoute[0] || '',
      model_gateway_profile_id: modelGatewayRoute[0] || '',
      ocr_profile_ids: ocrRoute,
      asr_profile_ids: asrRoute,
      quality_profile_ids: qualityRoute,
      translation_profile_ids: translationRoute,
      realtime_speech_profile_ids: realtimeSpeechRoute,
      tts_profile_ids: ttsRoute,
      model_gateway_profile_ids: modelGatewayRoute,
      allow_third_party: allowThirdParty,
      auto_ocr: requiredBoolean(input.auto_ocr, 'auto_ocr'),
      auto_asr: requiredBoolean(input.auto_asr, 'auto_asr'),
      auto_quality_review: requiredBoolean(input.auto_quality_review, 'auto_quality_review'),
      auto_translation: requiredBoolean(input.auto_translation, 'auto_translation'),
      translation_target_languages: normalizeLanguages(input.translation_target_languages),
      min_ocr_confidence: confidence(input.min_ocr_confidence, 'min_ocr_confidence'),
      min_asr_confidence: confidence(input.min_asr_confidence, 'min_asr_confidence')
    } satisfies NormalizedIntelligencePolicyUpdate;
    if (normalized.auto_ocr && !normalized.ocr_enabled) {
      throw policyError('auto_ocr requires ocr_enabled', 400);
    }
    if (normalized.auto_asr && !normalized.asr_enabled) {
      throw policyError('auto_asr requires asr_enabled', 400);
    }
    if (normalized.auto_quality_review && !normalized.quality_review_enabled) {
      throw policyError('auto_quality_review requires quality_review_enabled', 400);
    }
    if (normalized.auto_translation && !normalized.translation_enabled) {
      throw policyError('auto_translation requires translation_enabled', 400);
    }
    if (normalized.auto_translation && normalized.translation_target_languages.length === 0) {
      throw policyError('auto_translation requires at least one target language', 400);
    }
    return normalized;
  }

  private normalizeProfileRoute(
    value: unknown,
    legacyPrimary: unknown,
    capability: IntelligenceProviderCapability,
    allowThirdParty: boolean,
    field: string
  ): string[] {
    const explicitPrimary = profileId(legacyPrimary);
    if (value !== undefined && explicitPrimary) {
      this.registry.requireProfile(explicitPrimary, capability);
    }
    const source = value === undefined
      ? (explicitPrimary ? [explicitPrimary] : [])
      : value;
    if (!Array.isArray(source)) throw policyError(`${field} must be an array`, 400);
    if (source.length > 10) throw policyError(`${field} cannot exceed 10 entries`, 400);
    const route: string[] = [];
    for (const raw of source) {
      const id = profileId(raw);
      if (!id) throw policyError(`${field} cannot contain an empty profile id`, 400);
      if (route.includes(id)) throw policyError(`${field} contains duplicate profile: ${id}`, 400);
      const profile = this.registry.requireProfile(id, capability);
      if (profile.mode === 'third_party' && !allowThirdParty) {
        throw policyError(`third-party provider profile ${id} is not allowed`, 400);
      }
      route.push(id);
    }
    if (value !== undefined && explicitPrimary && route[0] !== explicitPrimary) {
      throw policyError(`${field} first profile must match the legacy primary profile`, 400);
    }
    return route;
  }
}

function decodePolicy(row: Record<string, unknown>): IntelligencePolicy {
  return {
    tenant_id: String(row.tenant_id),
    configured: true,
    ocr_enabled: booleanValue(row.ocr_enabled),
    asr_enabled: booleanValue(row.asr_enabled),
    quality_review_enabled: booleanValue(row.quality_review_enabled),
    translation_enabled: booleanValue(row.translation_enabled),
    realtime_speech_enabled: booleanValue(row.realtime_speech_enabled),
    tts_enabled: booleanValue(row.tts_enabled),
    model_gateway_enabled: booleanValue(row.model_gateway_enabled),
    ocr_profile_id: String(row.ocr_profile_id || ''),
    asr_profile_id: String(row.asr_profile_id || ''),
    quality_profile_id: String(row.quality_profile_id || ''),
    translation_profile_id: String(row.translation_profile_id || ''),
    realtime_speech_profile_id: String(row.realtime_speech_profile_id || ''),
    tts_profile_id: String(row.tts_profile_id || ''),
    model_gateway_profile_id: String(row.model_gateway_profile_id || ''),
    ocr_profile_ids: routeArray(row.ocr_profile_ids, row.ocr_profile_id),
    asr_profile_ids: routeArray(row.asr_profile_ids, row.asr_profile_id),
    quality_profile_ids: routeArray(row.quality_profile_ids, row.quality_profile_id),
    translation_profile_ids: routeArray(row.translation_profile_ids, row.translation_profile_id),
    realtime_speech_profile_ids: routeArray(
      row.realtime_speech_profile_ids, row.realtime_speech_profile_id
    ),
    tts_profile_ids: routeArray(row.tts_profile_ids, row.tts_profile_id),
    model_gateway_profile_ids: routeArray(
      row.model_gateway_profile_ids, row.model_gateway_profile_id
    ),
    allow_third_party: booleanValue(row.allow_third_party),
    auto_ocr: booleanValue(row.auto_ocr),
    auto_asr: booleanValue(row.auto_asr),
    auto_quality_review: booleanValue(row.auto_quality_review),
    auto_translation: booleanValue(row.auto_translation),
    translation_target_languages: textArray(row.translation_target_languages),
    min_ocr_confidence: Number(row.min_ocr_confidence || 0),
    min_asr_confidence: Number(row.min_asr_confidence || 0),
    version: Number(row.version || 0),
    updated_by: String(row.updated_by || ''),
    created_at: row.created_at ? String(row.created_at) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null
  };
}

function normalizeLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) throw policyError('translation_target_languages must be an array', 400);
  if (value.length > 10) throw policyError('translation_target_languages cannot exceed 10 entries', 400);
  const languages = new Set<string>();
  for (const item of value) {
    const raw = String(item || '').trim();
    if (!raw || raw.length > 35) throw policyError('translation target language is invalid', 400);
    try {
      const canonical = Intl.getCanonicalLocales(raw)[0];
      if (!canonical) throw new Error('missing locale');
      languages.add(canonical);
    } catch {
      throw policyError(`translation target language is invalid: ${raw}`, 400);
    }
  }
  return [...languages];
}

function profileId(value: unknown): string {
  const id = String(value || '').trim();
  if (id && !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw policyError('provider profile id is invalid', 400);
  return id;
}

function confidence(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw policyError(`${field} must be between 0 and 1`, 400);
  }
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw policyError(`${field} must be a boolean`, 400);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  return value === undefined ? fallback : requiredBoolean(value, field);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value || '[]')) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function routeArray(value: unknown, legacyPrimary: unknown): string[] {
  const route = textArray(value).filter(Boolean);
  if (route.length) return route;
  const primary = String(legacyPrimary || '').trim();
  return primary ? [primary] : [];
}

function requiredText(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text) throw policyError(`${field} is required`, 400);
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw policyError(`${field} must be an integer between ${min} and ${max}`, 400);
  }
  return parsed;
}

function policyError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}
