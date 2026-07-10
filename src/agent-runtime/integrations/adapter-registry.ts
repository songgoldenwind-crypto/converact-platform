import { ProviderGatewayClient } from './provider-gateway-client.js';
import type {
  AdapterRegistryEntry,
  AdapterRegistryLike,
  JsonRecord,
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderAdapterDefinition
} from './provider-runtime-types.js';

const providerGatewayClient = new ProviderGatewayClient();
export class AdapterRegistry implements AdapterRegistryLike {
  adapters: Map<string, AdapterRegistryEntry>;

  constructor() {
    this.adapters = new Map();
  }

  register(definition: ProviderAdapterDefinition, adapter: ProviderAdapter): void {
    if (!definition?.integration_id) throw new Error('integration_id is required');
    if (this.adapters.has(definition.integration_id)) throw new Error(`duplicate adapter: ${definition.integration_id}`);
    this.adapters.set(definition.integration_id, Object.freeze({ definition: Object.freeze({ ...definition }), adapter }));
  }

  get(integrationId: string): AdapterRegistryEntry {
    const entry = this.adapters.get(integrationId);
    if (!entry) throw new Error(`adapter not registered: ${integrationId}`);
    return entry;
  }

  has(integrationId: string): boolean {
    return this.adapters.has(integrationId);
  }

  list(): ProviderAdapterDefinition[] {
    return [...this.adapters.values()].map((entry) => entry.definition);
  }
}

export function registerDefaultAdapters(adapterRegistry: AdapterRegistryLike): void {
  for (const definition of [
    {
      integration_id: 'espocrm',
      adapter_type: 'http_adapter',
      status: 'planned',
      operations: ['contact.sync', 'opportunity.sync', 'task.sync']
    },
    {
      integration_id: 'mautic',
      adapter_type: 'http_adapter',
      status: 'planned',
      operations: ['segment.sync', 'campaign.queue', 'lead_score.sync']
    },
    {
      integration_id: 'chatwoot',
      adapter_type: 'http_adapter',
      status: 'planned',
      operations: ['conversation.read', 'message.draft', 'message.queue_for_approval']
    },
    {
      integration_id: 'posthog',
      adapter_type: 'http_adapter',
      status: 'planned',
      operations: ['event.track', 'funnel.read', 'cohort.read']
    },
    {
      integration_id: 'calcom',
      adapter_type: 'http_adapter',
      status: 'planned',
      operations: ['availability.read', 'booking.create', 'booking.read']
    },
    {
      integration_id: 'perplexica',
      adapter_type: 'http_adapter',
      status: 'active',
      operations: ['search.query', 'search.discover', 'search.followup']
    },
    {
      integration_id: 'open-notebook',
      adapter_type: 'http_adapter',
      status: 'active',
      operations: ['notebook.query', 'notebook.audio_overview', 'source.sync', 'notebook.transform']
    },
    {
      integration_id: 'amap-place-search',
      adapter_type: 'http_adapter',
      status: 'planned',
      operations: ['place.search', 'place.enrich', 'review.list', 'route.matrix']
    },
    {
      integration_id: 'baidu-place-search',
      adapter_type: 'http_adapter',
      status: 'planned',
      operations: ['place.search', 'place.enrich', 'review.list', 'route.matrix']
    },
    {
      integration_id: 'openai-compatible',
      adapter_type: 'model_provider',
      status: 'active',
      operations: ['model.complete']
    },
    {
      integration_id: 'asterisk',
      adapter_type: 'voice_adapter',
      status: 'planned',
      operations: ['call.queue_for_approval', 'call_result.ingest']
    },
    {
      integration_id: 'freeswitch',
      adapter_type: 'voice_adapter',
      status: 'planned',
      operations: ['call.queue_for_approval', 'call_result.ingest']
    },
    {
      integration_id: 'rustpbx',
      adapter_type: 'voice_adapter',
      status: 'active',
      operations: ['pbx.configure', 'call.queue_for_approval', 'call_result.ingest', 'sip_route.test']
    },
    {
      integration_id: 'mcp-playwright',
      adapter_type: 'mcp',
      status: 'planned',
      operations: ['browser.snapshot', 'landing_page.qa']
    },
    {
      integration_id: 'mcp-github',
      adapter_type: 'mcp',
      status: 'planned',
      operations: ['repo.read', 'issue.create_approval_required']
    }
  ]) {
    adapterRegistry.register(definition, createDefaultAdapter(definition));
  }
}

function createDefaultAdapter(definition) {
  if (definition.integration_id === 'perplexica') return createPerplexicaAdapter(definition);
  if (definition.integration_id === 'open-notebook') return createOpenNotebookAdapter(definition);
  if (['amap-place-search', 'baidu-place-search'].includes(definition.integration_id)) return createGeoBusinessAdapter(definition);
  if (definition.integration_id === 'openai-compatible') return createOpenAICompatibleModelAdapter(definition);
  if (definition.integration_id === 'rustpbx') return createRustpbxAdapter(definition);
  return createStubAdapter(definition);
}

function createStubAdapter(definition) {
  return {
    async health() {
      return { status: 'not_configured', integration_id: definition.integration_id };
    },
    async execute(operation) {
      if (!definition.operations.includes(operation)) throw new Error(`operation not supported: ${operation}`);
      return { status: 'planned', integration_id: definition.integration_id, operation };
    }
  };
}

function createPerplexicaAdapter(definition) {
  return createHttpJsonAdapter(definition, {
    defaultHealthPath: '/api/health',
    operations: {
      'search.query': {
        defaultPath: '/api/search/query',
        buildBody: ({ input }) => ({
          query: input.query,
          search_mode: input.search_mode || 'balanced',
          limit: input.limit || 5,
          domain_filters: input.domain_filters || [],
          conversation_id: input.conversation_id || ''
        }),
        normalize: ({ data, input }) => normalizeSearchResponse(data, input.query)
      },
      'search.discover': {
        defaultPath: '/api/search/discover',
        buildBody: ({ input }) => ({
          query: input.query,
          search_mode: input.search_mode || 'discovery',
          limit: input.limit || 5,
          domain_filters: input.domain_filters || []
        }),
        normalize: ({ data, input }) => normalizeSearchResponse(data, input.query)
      },
      'search.followup': {
        defaultPath: '/api/search/followup',
        buildBody: ({ input }) => ({
          query: input.query,
          conversation_id: input.conversation_id || '',
          search_mode: input.search_mode || 'followup',
          limit: input.limit || 5
        }),
        normalize: ({ data, input }) => normalizeSearchResponse(data, input.query)
      }
    }
  });
}

function createOpenNotebookAdapter(definition) {
  return createHttpJsonAdapter(definition, {
    defaultHealthPath: '/api/health',
    operations: {
      'notebook.query': {
        defaultPath: '/api/notebook/query',
        buildBody: ({ input }) => ({
          notebook_id: input.notebook_id,
          query: input.query,
          limit: input.limit || 5,
          source_refs: input.source_refs || []
        }),
        normalize: ({ data, input }) => normalizeNotebookQueryResponse(data, input)
      },
      'notebook.audio_overview': {
        defaultPath: '/api/notebook/audio-overview',
        buildBody: ({ input }) => ({
          notebook_id: input.notebook_id,
          notebook_title: input.notebook_title || '',
          focus: input.focus || '',
          limit: input.limit || 6,
          source_refs: input.source_refs || []
        }),
        normalize: ({ data, input }) => normalizeNotebookAudioResponse(data, input)
      },
      'source.sync': {
        defaultPath: '/api/source/sync',
        buildBody: ({ input }) => input,
        normalize: ({ data }) => ({ status: 'success', synced: data.synced ?? true, raw: data })
      },
      'notebook.transform': {
        defaultPath: '/api/notebook/transform',
        buildBody: ({ input }) => input,
        normalize: ({ data }) => ({ status: 'success', result: data.result || data, raw: data })
      }
    }
  });
}

function createRustpbxAdapter(definition) {
  return createHttpJsonAdapter(definition, {
    defaultHealthPath: '/api/health',
    operations: {
      'pbx.configure': {
        defaultPath: '/api/pbx/configure',
        buildBody: ({ input }) => input,
        normalize: ({ data }) => ({ status: data.status || 'configured', config_result: data, raw: data })
      },
      'call.queue_for_approval': {
        defaultPath: '/api/calls/queue',
        buildBody: ({ input }) => ({
          lead_id: input.lead_id || '',
          customer_id: input.customer_id || '',
          phone: input.phone || '',
          script: input.script || '',
          route_id: input.route_id || 'default',
          sip_endpoint: input.sip_endpoint || '',
          idempotency_key: input.idempotency_key || '',
          recording: input.recording || { enabled: false, mode: 'disabled', retention_days: 0 }
        }),
        normalize: ({ data, input }) => ({
          status: data.status || 'queued',
          provider: 'rustpbx',
          external_call_id: data.call_id || data.external_call_id || data.delivery_id || '',
          route_id: data.route_id || input.route_id || 'default',
          sip_endpoint: data.sip_endpoint || input.sip_endpoint || '',
          raw: data
        })
      },
      'call_result.ingest': {
        defaultPath: '/api/calls/events',
        buildBody: ({ input }) => input,
        normalize: ({ data }) => ({ status: data.status || 'accepted', event_result: data, raw: data })
      },
      'sip_route.test': {
        defaultPath: '/api/routes/test',
        buildBody: ({ input }) => ({
          route_id: input.route_id || 'default',
          lead_id: input.lead_id || '',
          sip_endpoint: input.sip_endpoint || ''
        }),
        normalize: ({ data, input }) => ({
          provider: 'rustpbx',
          route_id: data.route_id || input.route_id || 'default',
          status: data.status || 'healthy',
          outbound_requires_approval: true,
          sip_endpoint: data.sip_endpoint || input.sip_endpoint || '',
          raw: data
        })
      }
    }
  });
}

function createGeoBusinessAdapter(definition) {
  return createHttpJsonAdapter(definition, {
    defaultHealthPath: '/api/health',
    operations: {
      'place.search': {
        defaultPath: '/api/places/search',
        buildBody: ({ input }) => ({
          query: input.query || '',
          business_type: input.business_type || '',
          city: input.city || '',
          region: input.region || '',
          country_code: input.country_code || '',
          area_hint: input.area_hint || '',
          limit: input.limit || 10,
          filters: input.filters || {}
        }),
        normalize: ({ data, input }) => normalizeGeoPlaceSearchResponse(data, input, definition)
      },
      'place.enrich': {
        defaultPath: '/api/places/enrich',
        buildBody: ({ input }) => input,
        normalize: ({ data, input }) => ({
          status: 'success',
          provider: definition.integration_id,
          place: normalizeGeoPlace(data.place || data.result || data, input),
          raw: data
        })
      },
      'review.list': {
        defaultPath: '/api/reviews/list',
        buildBody: ({ input }) => ({
          external_place_id: input.external_place_id || '',
          place_key: input.place_key || '',
          place_name: input.place_name || '',
          city: input.city || '',
          region: input.region || '',
          country_code: input.country_code || '',
          limit: input.limit || 20
        }),
        normalize: ({ data, input }) => normalizeGeoReviewListResponse(data, input, definition)
      },
      'route.matrix': {
        defaultPath: '/api/routes/matrix',
        buildBody: ({ input }) => input,
        normalize: ({ data }) => ({
          status: 'success',
          matrix: data.matrix || data.routes || [],
          raw: data
        })
      }
    }
  });
}

function createOpenAICompatibleModelAdapter(definition) {
  return createHttpJsonAdapter(definition, {
    defaultHealthPath: '/v1/models',
    operations: {
      'model.complete': {
        defaultPath: '/v1/chat/completions',
        buildBody: ({ input, config }) => ({
          model: resolveModelName(input, config),
          messages: normalizeModelMessages(input),
          temperature: input.temperature ?? 0.2,
          max_tokens: input.max_tokens || input.max_output_tokens || 1024,
          response_format: input.response_format || undefined
        }),
        normalize: ({ data, input, config }) => normalizeModelCompletion(data, input, config)
      }
    }
  });
}

function createHttpJsonAdapter(definition, { defaultHealthPath = '/health', operations }) {
  return {
    async health({ config = {}, secrets = {} }: ProviderAdapterContext = {}) {
      const runtimeConfig = config || {};
      if (!runtimeConfig.base_url) return { status: 'not_configured', integration_id: definition.integration_id };
      const request = {
        url: joinUrl(runtimeConfig.base_url, runtimeConfig.health_path || defaultHealthPath),
        method: runtimeConfig.health_method || 'GET',
        headers: buildHeaders(runtimeConfig, secrets),
        timeout_ms: Number(runtimeConfig.request_timeout_ms || 800)
      };
      try {
        const gatewayResponse = providerGatewayClient.isConfigured(runtimeConfig)
          ? await providerGatewayClient.health({
              integrationId: definition.integration_id,
              request,
              runtimeConfig
            })
          : null;
        const response = gatewayResponse
          ? null
          : await fetch(request.url, {
              method: request.method,
              headers: request.headers,
              signal: AbortSignal.timeout(request.timeout_ms)
            });
        const data = gatewayResponse?.body || await parseHttpResponse(response);
        const ok = gatewayResponse
          ? Number(gatewayResponse.status_code || 500) >= 200 && Number(gatewayResponse.status_code || 500) < 400
          : response.ok;
        return {
          status: ok ? 'healthy' : 'degraded',
          integration_id: definition.integration_id,
          http_status: gatewayResponse?.status_code || response.status,
          body: summarizeResponseBody(data),
          language_boundary: gatewayResponse ? 'go_provider_gateway' : 'direct_http'
        };
      } catch (error) {
        return {
          status: 'degraded',
          integration_id: definition.integration_id,
          error: error.message
        };
      }
    },
    async execute(operation: string, context: ProviderAdapterContext = {}) {
      const spec = operations[operation];
      if (!spec) throw new Error(`operation not supported: ${operation}`);
      const runtimeConfig = context.config || {};
      if (!runtimeConfig.base_url) throw new Error(`adapter base_url is required for ${definition.integration_id}`);
      const requestBody = spec.buildBody ? spec.buildBody({ input: context.input || {}, config: runtimeConfig }) : (context.input || {});
      const headers = buildHeaders(runtimeConfig, context.secrets || {});
      if (requestBody !== undefined) headers['content-type'] = 'application/json';
      const request = {
        url: joinUrl(runtimeConfig.base_url, resolveOperationPath(runtimeConfig, operation, spec.defaultPath)),
        method: spec.method || 'POST',
        headers,
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
        timeout_ms: Number(runtimeConfig.request_timeout_ms || 1500)
      };
      const gatewayResponse = providerGatewayClient.isConfigured(runtimeConfig)
        ? await providerGatewayClient.execute({
            integrationId: definition.integration_id,
            operation,
            request,
            runtimeConfig
          })
        : null;
      const response = gatewayResponse
        ? null
        : await fetch(request.url, {
            method: request.method,
            headers,
            body: request.body,
            signal: AbortSignal.timeout(request.timeout_ms)
          });
      const data = gatewayResponse?.body || await parseHttpResponse(response);
      const responseOk = gatewayResponse
        ? Number(gatewayResponse.status_code || 500) >= 200 && Number(gatewayResponse.status_code || 500) < 400
        : response.ok;
      if (!responseOk) {
        throw new Error(data?.error || data?.message || `${definition.integration_id} ${operation} failed with ${gatewayResponse?.status_code || response.status}`);
      }
      const normalized = spec.normalize
        ? spec.normalize({ data, input: context.input || {}, config: runtimeConfig, response })
        : { status: 'success', data };
      if (normalized && typeof normalized === 'object') {
        normalized.language_boundary = gatewayResponse ? 'go_provider_gateway' : 'direct_http';
      }
      return normalized;
    }
  };
}

function buildHeaders(config, secrets) {
  const headers = {
    accept: 'application/json',
    ...(config.default_headers || {})
  };
  const authSecretKey = config.auth_secret_key || '';
  if (authSecretKey && secrets[authSecretKey]) {
    const scheme = config.auth_scheme === 'none' ? '' : (config.auth_scheme || 'Bearer');
    headers[config.auth_header_name || 'authorization'] = scheme
      ? `${scheme} ${secrets[authSecretKey]}`
      : secrets[authSecretKey];
  }
  return headers;
}

function resolveOperationPath(config, operation, defaultPath) {
  return config.operation_paths?.[operation]
    || config[`${operation.replaceAll('.', '_')}_path`]
    || defaultPath;
}

function joinUrl(baseUrl, path) {
  return new URL(path, String(baseUrl).endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function parseHttpResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function normalizeSearchResponse(data, query) {
  const citations = normalizeCitations(data.citations || data.sources || data.results || []);
  return {
    status: 'success',
    summary: data.summary || data.answer || data.message || `Live provider returned ${citations.length} citation(s) for "${query}".`,
    citations,
    results: Array.isArray(data.results) ? data.results : [],
    raw: data
  };
}

function normalizeNotebookQueryResponse(data, input) {
  return {
    status: 'success',
    notebook_id: data.notebook_id || input.notebook_id,
    answer: data.answer || data.summary || `Notebook "${input.notebook_id}" answered "${input.query}".`,
    citations: normalizeCitations(data.citations || data.sources || data.results || []),
    raw: data
  };
}

function normalizeNotebookAudioResponse(data, input) {
  return {
    status: 'success',
    notebook_id: data.notebook_id || input.notebook_id,
    citations: normalizeCitations(data.citations || data.sources || []),
    script_outline: normalizeScriptOutline(data, input),
    audio_url: data.audio_url || data.audioUrl || '',
    raw: data
  };
}

function normalizeModelCompletion(data: JsonRecord, input: JsonRecord, config: JsonRecord = {}) {
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice?.message?.content || data.content || data.text || '';
  const usage = {
    input_tokens: Number(data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0),
    output_tokens: Number(data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0),
    total_tokens: Number(data.usage?.total_tokens ?? 0)
  };
  if (!usage.total_tokens) usage.total_tokens = usage.input_tokens + usage.output_tokens;
  return {
    provider: 'openai-compatible',
    model: data.model || input.model || config.default_model || config.model || '',
    content,
    structured_output: tryParseJson(content),
    usage,
    cost: data.cost || { amount: 0, currency: 'USD' },
    finish_reason: choice?.finish_reason || data.finish_reason || '',
    raw: data
  };
}

function normalizeGeoPlaceSearchResponse(data, input, definition) {
  const rawPlaces = Array.isArray(data.places) ? data.places : (Array.isArray(data.results) ? data.results : []);
  const places = rawPlaces.map((place) => normalizeGeoPlace(place, input));
  return {
    status: 'success',
    provider: definition.integration_id,
    query: input.query || '',
    places,
    raw: data
  };
}

function normalizeGeoReviewListResponse(data, input, definition) {
  const rawReviews = Array.isArray(data.reviews) ? data.reviews : (Array.isArray(data.results) ? data.results : []);
  const reviews = rawReviews.map((review, index) => normalizeGeoReview(review, input, index));
  return {
    status: 'success',
    provider: definition.integration_id,
    external_place_id: input.external_place_id || '',
    reviews,
    raw: data
  };
}

function normalizeModelMessages(input) {
  if (Array.isArray(input.messages) && input.messages.length) return input.messages;
  if (input.prompt) return [{ role: 'user', content: String(input.prompt) }];
  return [{ role: 'user', content: JSON.stringify(input.input || {}) }];
}

function resolveModelName(input: JsonRecord, config: JsonRecord = {}) {
  const model = input.model || config.default_model || config.model;
  if (!model) throw new Error('model is required for openai-compatible completions');
  return model;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeScriptOutline(data, input) {
  if (data.script_outline && typeof data.script_outline === 'object') return data.script_outline;
  if (data.outline && typeof data.outline === 'object') return data.outline;
  return {
    title: `${input.notebook_title || input.notebook_id || 'Notebook'} audio overview`,
    focus: input.focus || input.notebook_title || input.notebook_id || '',
    segments: Array.isArray(data.segments) ? data.segments : [
      'Opening context and research goal',
      'Key findings grounded in cited notebook sources',
      'Implications for tenant operations or lead follow-up',
      'Open questions and next research actions'
    ],
    source_titles: normalizeCitations(data.citations || data.sources || []).map((citation) => citation.title)
  };
}

function normalizeCitations(rawCitations) {
  return (Array.isArray(rawCitations) ? rawCitations : []).map((citation, index) => {
    if (typeof citation === 'string') {
      return {
        ref_type: 'external',
        ref_id: `provider-citation-${index + 1}`,
        title: citation,
        score: 1,
        slug: '',
        uri: '',
        excerpt: citation
      };
    }
    return {
      ref_type: citation.ref_type || 'external',
      ref_id: citation.ref_id || citation.id || `provider-citation-${index + 1}`,
      title: citation.title || citation.name || citation.url || `Provider citation ${index + 1}`,
      score: Number(citation.score ?? citation.rank ?? 1),
      slug: citation.slug || '',
      uri: citation.uri || citation.url || '',
      excerpt: citation.excerpt || citation.snippet || citation.summary || citation.content || ''
    };
  });
}

function normalizeGeoPlace(place, input) {
  const location = place.location || {};
  return {
    external_place_id: place.external_place_id || place.place_id || place.id || '',
    name: place.name || place.title || input.query || 'Unknown place',
    business_type: place.business_type || place.type || input.business_type || '',
    address: place.address || place.formatted_address || '',
    city: place.city || input.city || '',
    region: place.region || place.state || input.region || '',
    country_code: place.country_code || input.country_code || '',
    phone: place.phone || place.telephone || '',
    whatsapp: place.whatsapp || '',
    website: place.website || place.url || '',
    emails: normalizeStringArray(place.emails || place.email || []),
    social_profiles: normalizeStringArray(place.social_profiles || place.socials || []),
    opening_hours: normalizeStringArray(place.opening_hours || place.hours || []),
    rating: normalizeNumber(place.rating),
    review_count: Number(place.review_count ?? place.reviews_count ?? place.reviewCount ?? 0),
    lat: normalizeNumber(place.lat ?? place.latitude ?? location.lat ?? location.latitude),
    lng: normalizeNumber(place.lng ?? place.longitude ?? location.lng ?? location.longitude),
    metadata: {
      source_payload: place
    }
  };
}

function normalizeGeoReview(review, input, index) {
  return {
    external_review_id: review.external_review_id || review.review_id || review.id || '',
    review_key: review.review_key || review.review_id || review.id || `${input.external_place_id || input.place_key || 'review'}-${index + 1}`,
    rating: normalizeNumber(review.rating),
    author_name: review.author_name || review.author || '',
    language_code: review.language_code || review.language || '',
    published_at: review.published_at || review.created_at || review.date || null,
    content: review.content || review.text || review.comment || '',
    metadata: {
      source_payload: review
    }
  };
}

function summarizeResponseBody(data) {
  if (data == null) return null;
  if (typeof data === 'string') return data.slice(0, 160);
  if (typeof data.text === 'string') return data.text.slice(0, 160);
  return {
    status: data.status || '',
    ok: data.ok ?? undefined,
    message: data.message || ''
  };
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
