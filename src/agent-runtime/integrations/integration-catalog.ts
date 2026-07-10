import { defaultIntegrationCatalog, defaultSkillCatalog } from './default-catalog.js';
import type { IntegrationCatalogEntry, JsonRecord } from './provider-runtime-types.js';

export interface IntegrationCatalogFilter {
  category?: string;
  source_type?: string;
  capability?: string;
  min_stability?: number;
}

export interface IntegrationRecommendationInput extends IntegrationCatalogFilter {
  capabilities?: string[];
  categories?: string[];
  include_experimental?: boolean;
  limit?: number;
}

export type RecommendedIntegrationEntry = IntegrationCatalogEntry & { recommendation_score: number };

export class IntegrationCatalog {
  entries: Map<string, IntegrationCatalogEntry>;

  constructor(entries: IntegrationCatalogEntry[] = [...defaultIntegrationCatalog, ...defaultSkillCatalog]) {
    this.entries = new Map(entries.map((entry) => [entry.id, normalizeEntry(entry)]));
  }

  list(filter: IntegrationCatalogFilter = {}): IntegrationCatalogEntry[] {
    return [...this.entries.values()]
      .filter((entry) => !filter.category || entry.category === filter.category)
      .filter((entry) => !filter.source_type || entry.source_type === filter.source_type)
      .filter((entry) => !filter.capability || entry.capabilities.includes(filter.capability))
      .filter((entry) => !filter.min_stability || entry.stability_score >= Number(filter.min_stability))
      .sort((a, b) => b.stability_score - a.stability_score || a.name.localeCompare(b.name));
  }

  get(id: string): IntegrationCatalogEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`integration not found: ${id}`);
    return entry;
  }

  recommend(input: IntegrationRecommendationInput = {}): RecommendedIntegrationEntry[] {
    const capabilities = new Set(input.capabilities || []);
    const categories = new Set(input.categories || []);
    const minStability = input.min_stability ?? 70;
    const includeExperimental = Boolean(input.include_experimental);

    return this.list()
      .map((entry) => ({
        ...entry,
        recommendation_score: scoreEntry(entry, { capabilities, categories, minStability, includeExperimental })
      }))
      .filter((entry) => entry.recommendation_score > 0)
      .sort((a, b) => b.recommendation_score - a.recommendation_score || b.stability_score - a.stability_score)
      .slice(0, input.limit || 10);
  }

  stableStackForOPC(): JsonRecord {
    const core = getMany(this, [
      'opc-native-crm',
      'opc-native-wiki',
      'chatwoot',
      'posthog',
      'calcom',
      'rustpbx',
      'opc-native-webrtc',
      'mcp-playwright',
      'skill.lead_qualification',
      'skill.crm_followup',
      'skill.weekly_review'
    ]);
    const optional = {
      crm_external: getMany(this, ['espocrm', 'twenty-crm']),
      voice: getMany(this, ['rustpbx', 'opc-native-webrtc']),
      voice_heavy_fallbacks: getMany(this, ['asterisk', 'freeswitch']),
      marketing_automation: getMany(this, ['mautic']),
      workflow_automation: getMany(this, ['n8n']),
      model_provider: getMany(this, ['openai-compatible']),
      ai_workers: getMany(this, ['opc-ai-worker']),
      search: getMany(this, ['perplexica']),
      notebook: getMany(this, ['open-notebook']),
      geo_business_data: getMany(this, ['amap-place-search', 'baidu-place-search']),
      rag: getMany(this, ['anythingllm']),
      knowledge_base_references: getMany(this, ['llm-wiki']),
      newsletter: getMany(this, ['listmonk'])
    };

    return {
      profile: 'lean_opc_default',
      principle: 'Use OPC-native core first. For voice, prefer lightweight RustPBX plus the native WebRTC boundary; keep Asterisk/FreeSWITCH only as heavy fallbacks.',
      core,
      optional,
      crm: getMany(this, ['opc-native-crm']),
      knowledge_base: getMany(this, ['opc-native-wiki']),
      voice: optional.voice,
      voice_heavy_fallbacks: optional.voice_heavy_fallbacks,
      marketing_automation: optional.marketing_automation,
      customer_messaging: getMany(this, ['chatwoot']),
      analytics: getMany(this, ['posthog']),
      workflow_automation: optional.workflow_automation,
      model_provider: optional.model_provider,
      ai_workers: optional.ai_workers,
      search: optional.search,
      notebook: optional.notebook,
      geo_business_data: optional.geo_business_data,
      rag: optional.rag,
      knowledge_base_references: optional.knowledge_base_references,
      mcp: getMany(this, ['mcp-playwright']),
      skills: getMany(this, ['skill.lead_qualification', 'skill.crm_followup', 'skill.weekly_review'])
    };
  }
}

function normalizeEntry(entry: IntegrationCatalogEntry): IntegrationCatalogEntry {
  return Object.freeze({
    metadata: {},
    deployment_modes: [],
    capabilities: [],
    adoption_tier: 'optional',
    ...entry
  });
}

function getMany(catalog: IntegrationCatalog, ids: string[]): IntegrationCatalogEntry[] {
  return ids.map((id) => catalog.get(id));
}

function scoreEntry(
  entry: IntegrationCatalogEntry,
  { capabilities, categories, minStability, includeExperimental }: {
    capabilities: Set<string>;
    categories: Set<string>;
    minStability: number;
    includeExperimental: boolean;
  }
): number {
  if (entry.stability_score < minStability) return 0;
  if (!includeExperimental && ['experimental', 'research'].includes(entry.maturity)) return 0;

  let score = entry.stability_score;
  if (categories.size) score += categories.has(entry.category) ? 30 : -40;
  if (capabilities.size) {
    const matched = entry.capabilities.filter((capability) => capabilities.has(capability)).length;
    score += matched * 12;
    if (!matched) score -= 20;
  }
  if (entry.adapter_status === 'native') score += 12;
  if (entry.adapter_status === 'http_adapter' || entry.adapter_status === 'mcp') score += 8;
  if (entry.maturity === 'production') score += 15;
  if (entry.default_risk_level === 'R3') score -= 5;
  return Math.max(0, score);
}
