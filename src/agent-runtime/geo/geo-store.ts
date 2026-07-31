import { createHash } from 'node:crypto';

import { AIWorkerClient } from '../ai/ai-worker-client.js';
import { all, id, json, one, parseJson, run } from '../../db.js';
import type {
  IntegrationConfigStoreLike,
  JsonRecord,
  ProviderSelection
} from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface GeoProviderRegistryStoreLike {
  adapterRegistry: { has: (integrationId: string) => boolean };
  integrationConfigStore: IntegrationConfigStoreLike;
  previewSelection: (input: JsonRecord) => ProviderSelection;
  executeProviderOperation: (input: JsonRecord) => Promise<JsonRecord>;
}

function ensureTenant(input: JsonRecord) {
  if (!input?.tenant_id) {
    throw new Error('tenant_id is required');
  }
}

function normalizeWorkspaceId(input: JsonRecord): string {
  return input.workspace_id || 'default';
}

function hashKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function decodeSession(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    filters: parseJson(row.filters, {}),
  };
}

function decodePlace(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    emails: parseJson(row.emails, []),
    social_profiles: parseJson(row.social_profiles, []),
    opening_hours: parseJson(row.opening_hours, []),
    metadata: parseJson(row.metadata, {}),
  };
}

function decodeReview(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    metadata: parseJson(row.metadata, {}),
  };
}

function decodeInsight(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    pain_signals: parseJson(row.pain_signals, []),
    source_review_ids: parseJson(row.source_review_ids, []),
  };
}

function decodeDraft(row: JsonRecord | null | undefined): JsonRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    personalization_points: parseJson(row.personalization_points, []),
  };
}

function summarizeReview(text: unknown): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Customers left limited detail, but the account should be reviewed manually.';
  }
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function normalizePainSignals(payload, reviews) {
  if (Array.isArray(payload?.pain_signals) && payload.pain_signals.length > 0) {
    return payload.pain_signals.map((signal, index) => ({
      signal: signal.signal || signal.theme || `Pain signal ${index + 1}`,
      evidence_review_id: signal.evidence_review_id || signal.review_id || reviews[index]?.id || null,
      evidence: signal.evidence || signal.quote || '',
      urgency: signal.urgency || 'medium',
    }));
  }
  return reviews.slice(0, 3).map((review, index) => ({
    signal: summarizeReview(review.content),
    evidence_review_id: review.id,
    evidence: review.content,
    urgency: index === 0 ? 'high' : 'medium',
  }));
}

function normalizeInsightPayload(modelOutput, reviews) {
  const structured = modelOutput?.structured_output && typeof modelOutput.structured_output === 'object'
    ? modelOutput.structured_output
    : {};
  const summary = structured.summary
    || modelOutput?.content
    || 'Generated a first-pass pain insight from available place reviews.';
  return {
    summary,
    pain_signals: normalizePainSignals(structured, reviews),
  };
}

function normalizeOutreachPayload(modelOutput, place, input) {
  const structured = modelOutput?.structured_output && typeof modelOutput.structured_output === 'object'
    ? modelOutput.structured_output
    : {};
  const defaultSubject = `${place.name} x ${input.channel || 'email'} outreach`;
  const defaultMessage = modelOutput?.content
    || `Hi ${place.name}, I reviewed recent customer feedback and prepared a tailored ${input.channel || 'email'} outreach draft for ${input.product_offer}.`;
  const personalizationPoints = Array.isArray(structured.personalization_points) && structured.personalization_points.length > 0
    ? structured.personalization_points
    : [place.city, place.business_type, input.product_offer].filter(Boolean);
  return {
    subject: structured.subject || defaultSubject,
    message: structured.message || defaultMessage,
    personalization_points: personalizationPoints,
  };
}

function renderInsightPrompt(place, reviews, input) {
  const reviewBlock = reviews.map((review, index) => {
    return `${index + 1}. rating=${review.rating ?? 'n/a'} author=${review.author_name || 'anonymous'} content=${review.content || '(empty)'}`;
  }).join('\n');
  return [
    'You are preparing B2B outbound research for a local-business lead discovery workflow.',
    `Business name: ${place.name}`,
    `Business type: ${place.business_type || 'unknown'}`,
    `City/region: ${[place.city, place.region].filter(Boolean).join(', ') || 'unknown'}`,
    `Product offer: ${input.offer_context || 'not provided'}`,
    'Review evidence:',
    reviewBlock,
    'Return a JSON object with:',
    '1. summary: concise pain summary',
    '2. pain_signals: array of { signal, evidence_review_id, evidence, urgency }',
  ].join('\n');
}

function renderOutreachPrompt(place, insight, input) {
  const painSignals = Array.isArray(insight?.pain_signals) && insight.pain_signals.length > 0
    ? insight.pain_signals.map((signal, index) => `${index + 1}. ${signal.signal}`).join('\n')
    : 'No structured pain signals were provided.';
  return [
    'You are preparing a highly personalized B2B outbound draft.',
    `Channel: ${input.channel || 'email'}`,
    `Business name: ${place.name}`,
    `Business type: ${place.business_type || 'unknown'}`,
    `City/region: ${[place.city, place.region].filter(Boolean).join(', ') || 'unknown'}`,
    `Product offer: ${input.product_offer}`,
    `Offer summary: ${input.offer_summary || ''}`,
    `Pain insight summary: ${insight?.summary || 'No insight summary available.'}`,
    'Pain signals:',
    painSignals,
    'Return a JSON object with:',
    '1. subject',
    '2. message',
    '3. personalization_points: array of short strings',
  ].join('\n');
}

export class GeoStore {
  db: unknown;
  artifactStore: { commit?: (input: JsonRecord) => JsonRecord } | null;
  modelGateway: { complete?: (...args: unknown[]) => Promise<JsonRecord> } | null;
  providerRegistryStore: GeoProviderRegistryStoreLike | null;
  integrationConfigStore: IntegrationConfigStoreLike | null;
  runStore: AuditStoreLike | null;
  aiWorkerClient: AIWorkerClient;

  constructor({
    db,
    artifactStore = null,
    modelGateway = null,
    providerRegistryStore = null,
    integrationConfigStore = null,
    runStore = null,
    aiWorkerClient = null
  }) {
    this.db = db;
    this.artifactStore = artifactStore;
    this.modelGateway = modelGateway;
    this.providerRegistryStore = providerRegistryStore;
    this.integrationConfigStore = integrationConfigStore;
    this.runStore = runStore;
    this.aiWorkerClient = aiWorkerClient || new AIWorkerClient();
  }

  listSessions(input) {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [input.tenant_id, workspaceId];
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_sessions
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      [...params, Number(input.limit || 50)],
    ).map(decodeSession);
  }

  getSession(tenantId, workspaceId, sessionId) {
    return decodeSession(
      one(
        this.db,
        `SELECT * FROM tenant_geo_sessions
         WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
        [tenantId, workspaceId || 'default', sessionId],
      ),
    );
  }

  upsertSession(input) {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const sessionId = input.session_id || id('geo_session');
    const actor = input.updated_by || input.created_by || 'system';
    run(
      this.db,
      `INSERT INTO tenant_geo_sessions (
        id, tenant_id, workspace_id, session_id, name, business_type, city, region, country_code,
        area_hint, search_query, provider_integration_id, filters, status, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, session_id) DO UPDATE SET
        name = excluded.name,
        business_type = excluded.business_type,
        city = excluded.city,
        region = excluded.region,
        country_code = excluded.country_code,
        area_hint = excluded.area_hint,
        search_query = excluded.search_query,
        provider_integration_id = excluded.provider_integration_id,
        filters = excluded.filters,
        status = excluded.status,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        input.id || id('geo_sess'),
        input.tenant_id,
        workspaceId,
        sessionId,
        input.name || `${input.business_type || 'local-business'} discovery`,
        input.business_type || '',
        input.city || '',
        input.region || '',
        input.country_code || '',
        input.area_hint || '',
        input.search_query || '',
        input.provider_integration_id || '',
        json(input.filters || {}),
        input.status || 'active',
        input.created_by || actor,
        actor,
      ],
    );
    const session = this.getSession(input.tenant_id, workspaceId, sessionId);
    this.runStore?.audit(
      input.tenant_id,
      'geo.session.upserted',
      'tenant_geo_session',
      session.id,
      { workspace_id: workspaceId, session_id: session.session_id },
      actor,
    );
    return session;
  }

  async discoverPlaces(input: JsonRecord, context: JsonRecord = {}) {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const existingSession = input.session_id ? this.getSession(input.tenant_id, workspaceId, input.session_id) : null;
    if (input.session_id && !existingSession) {
      throw new Error(`Geo session not found: ${input.session_id}`);
    }
    const actor = input.created_by || 'system';
    const providerSelection = this.selectProvider({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      category: 'geo_business_data',
      capability: 'place_search',
      use_case: 'lead_discovery',
      preferred_ids: compactUnique([input.provider_integration_id, existingSession?.provider_integration_id]),
      allow_fallback: true,
    });
    const session = this.upsertSession({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      session_id: existingSession?.session_id || input.session_id || id('geo_session'),
      name: input.name || existingSession?.name || `${input.business_type || existingSession?.business_type || 'local-business'} discovery`,
      business_type: input.business_type || existingSession?.business_type || '',
      city: input.city || existingSession?.city || '',
      region: input.region || existingSession?.region || '',
      country_code: input.country_code || existingSession?.country_code || '',
      area_hint: input.area_hint || existingSession?.area_hint || '',
      search_query: input.query || input.search_query || existingSession?.search_query || buildGeoSearchQuery(input, existingSession),
      provider_integration_id: providerSelection.selected?.integration_id || input.provider_integration_id || existingSession?.provider_integration_id || '',
      filters: input.filters || existingSession?.filters || {},
      created_by: actor,
      updated_by: actor,
    });
    const liveProvider = await this.maybeExecuteLiveProviderOperation({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      provider_selection: providerSelection,
      operation: 'place.search',
      payload: {
        query: session.search_query,
        business_type: session.business_type,
        city: session.city,
        region: session.region,
        country_code: session.country_code,
        area_hint: session.area_hint,
        filters: session.filters || {},
        limit: Number(input.limit || 10),
      },
      actor_id: actor,
    });
    const persistedPlaces = (liveProvider?.places || []).map((place) => this.upsertPlace({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      session_id: session.session_id,
      provider_integration_id: providerSelection.selected?.integration_id || session.provider_integration_id || '',
      name: place.name,
      business_type: place.business_type || session.business_type,
      address: place.address,
      city: place.city || session.city,
      region: place.region || session.region,
      country_code: place.country_code || session.country_code,
      phone: place.phone,
      whatsapp: place.whatsapp,
      website: place.website,
      emails: place.emails || [],
      social_profiles: place.social_profiles || [],
      opening_hours: place.opening_hours || [],
      rating: place.rating,
      review_count: place.review_count,
      lat: place.lat,
      lng: place.lng,
      external_place_id: place.external_place_id || '',
      metadata: place.metadata || {},
      created_by: actor,
    }));
    const providerExecutionMode = liveProvider ? 'live_provider' : 'planned_adapter_fallback';
    const note = liveProvider
      ? 'Live geo provider execution completed through the tenant-configured geo adapter and persisted tenant-scoped place candidates.'
      : 'Geo provider selection is foundation-ready; place discovery will execute live once a tenant geo adapter is configured.';
    const artifact = this.artifactStore?.commit({
      tenant_id: input.tenant_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'geo_place_discovery_result',
      status: 'draft',
      payload: {
        session,
        provider_selection: providerSelection,
        provider_execution_mode: providerExecutionMode,
        places: persistedPlaces,
        live_provider_result: liveProvider ? omitRawProviderPayload(liveProvider) : null,
        note,
      },
    }) || null;
    this.runStore?.audit(
      input.tenant_id,
      'geo.place_discovery.completed',
      'tenant_geo_session',
      session.id,
      {
        session_id: session.session_id,
        provider_integration_id: providerSelection.selected?.integration_id || null,
        provider_execution_mode: providerExecutionMode,
        discovered_places: persistedPlaces.length,
        artifact_id: artifact?.id || null,
      },
      actor,
    );
    return {
      session: this.getSession(input.tenant_id, workspaceId, session.session_id),
      provider_selection: providerSelection,
      provider_execution_mode: providerExecutionMode,
      places: persistedPlaces,
      artifact,
      live_provider_result: liveProvider ? omitRawProviderPayload(liveProvider) : null,
      note,
    };
  }

  listPlaces(input) {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [input.tenant_id, workspaceId];
    if (input.session_id) {
      clauses.push('session_id = ?');
      params.push(input.session_id);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.city) {
      clauses.push('city = ?');
      params.push(input.city);
    }
    if (input.business_type) {
      clauses.push('business_type = ?');
      params.push(input.business_type);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_places
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      [...params, Number(input.limit || 50)],
    ).map(decodePlace);
  }

  getPlace(tenantId, placeId) {
    return decodePlace(
      one(
        this.db,
        'SELECT * FROM tenant_geo_places WHERE tenant_id = ? AND id = ?',
        [tenantId, placeId],
      ),
    );
  }

  getPlaceByKey(tenantId, workspaceId, placeKey) {
    return decodePlace(
      one(
        this.db,
        `SELECT * FROM tenant_geo_places
         WHERE tenant_id = ? AND workspace_id = ? AND place_key = ?`,
        [tenantId, workspaceId || 'default', placeKey],
      ),
    );
  }

  upsertPlace(input) {
    ensureTenant(input);
    if (!input.name) {
      throw new Error('name is required');
    }
    const workspaceId = normalizeWorkspaceId(input);
    if (input.session_id && !this.getSession(input.tenant_id, workspaceId, input.session_id)) {
      throw new Error(`Geo session not found: ${input.session_id}`);
    }
    const placeKey = input.place_key || input.external_place_id || hashKey([
      input.name,
      input.address || '',
      input.city || '',
      input.region || '',
      input.country_code || '',
    ]);
    const actor = input.updated_by || input.created_by || 'system';
    run(
      this.db,
      `INSERT INTO tenant_geo_places (
        id, tenant_id, workspace_id, session_id, place_key, external_place_id, provider_integration_id, name,
        business_type, address, city, region, country_code, phone, whatsapp, website, emails, social_profiles,
        opening_hours, rating, review_count, lat, lng, status, metadata, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, place_key) DO UPDATE SET
        session_id = excluded.session_id,
        external_place_id = excluded.external_place_id,
        provider_integration_id = excluded.provider_integration_id,
        name = excluded.name,
        business_type = excluded.business_type,
        address = excluded.address,
        city = excluded.city,
        region = excluded.region,
        country_code = excluded.country_code,
        phone = excluded.phone,
        whatsapp = excluded.whatsapp,
        website = excluded.website,
        emails = excluded.emails,
        social_profiles = excluded.social_profiles,
        opening_hours = excluded.opening_hours,
        rating = excluded.rating,
        review_count = excluded.review_count,
        lat = excluded.lat,
        lng = excluded.lng,
        status = excluded.status,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP`,
      [
        input.id || id('geo_place'),
        input.tenant_id,
        workspaceId,
        input.session_id || '',
        placeKey,
        input.external_place_id || '',
        input.provider_integration_id || '',
        input.name,
        input.business_type || '',
        input.address || '',
        input.city || '',
        input.region || '',
        input.country_code || '',
        input.phone || '',
        input.whatsapp || '',
        input.website || '',
        json(input.emails || []),
        json(input.social_profiles || []),
        json(input.opening_hours || []),
        input.rating ?? null,
        Number.isFinite(Number(input.review_count)) ? Number(input.review_count) : 0,
        input.lat ?? null,
        input.lng ?? null,
        input.status || 'active',
        json(input.metadata || {}),
        input.created_by || actor,
        actor,
      ],
    );
    const place = this.getPlaceByKey(input.tenant_id, workspaceId, placeKey);
    this.runStore?.audit(
      input.tenant_id,
      'geo.place.upserted',
      'tenant_geo_place',
      place.id,
      { workspace_id: workspaceId, place_key: place.place_key },
      actor,
    );
    return place;
  }

  listReviews(input) {
    ensureTenant(input);
    if (!input.place_id) {
      throw new Error('place_id is required');
    }
    const place = this.getPlace(input.tenant_id, input.place_id);
    if (!place) {
      throw new Error(`Geo place not found: ${input.place_id}`);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_place_reviews
       WHERE tenant_id = ? AND place_id = ?
       ORDER BY COALESCE(published_at, created_at) DESC
       LIMIT ?`,
      [input.tenant_id, input.place_id, Number(input.limit || 50)],
    ).map(decodeReview);
  }

  ingestReview(input) {
    ensureTenant(input);
    if (!input.place_id) {
      throw new Error('place_id is required');
    }
    const place = this.getPlace(input.tenant_id, input.place_id);
    if (!place) {
      throw new Error(`Geo place not found: ${input.place_id}`);
    }
    const reviewKey = input.review_key || input.external_review_id || hashKey([
      input.author_name || '',
      input.rating ?? '',
      input.content || '',
      input.published_at || '',
    ]);
    const actor = input.created_by || 'system';
    run(
      this.db,
      `INSERT INTO tenant_geo_place_reviews (
        id, tenant_id, workspace_id, place_id, review_key, external_review_id, rating, author_name,
        language_code, published_at, content, metadata, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, place_id, review_key) DO UPDATE SET
        external_review_id = excluded.external_review_id,
        rating = excluded.rating,
        author_name = excluded.author_name,
        language_code = excluded.language_code,
        published_at = excluded.published_at,
        content = excluded.content,
        metadata = excluded.metadata,
        updated_at = CURRENT_TIMESTAMP`,
      [
        input.id || id('geo_review'),
        input.tenant_id,
        place.workspace_id,
        place.id,
        reviewKey,
        input.external_review_id || '',
        input.rating ?? null,
        input.author_name || '',
        input.language_code || '',
        input.published_at || null,
        input.content || '',
        json(input.metadata || {}),
        actor,
      ],
    );
    const review = decodeReview(
      one(
        this.db,
        `SELECT * FROM tenant_geo_place_reviews
         WHERE tenant_id = ? AND place_id = ? AND review_key = ?`,
        [input.tenant_id, place.id, reviewKey],
      ),
    );
    this.runStore?.audit(
      input.tenant_id,
      'geo.review.ingested',
      'tenant_geo_place_review',
      review.id,
      { place_id: place.id, workspace_id: place.workspace_id },
      actor,
    );
    return review;
  }

  async importPlaceReviews(input: JsonRecord, context: JsonRecord = {}) {
    ensureTenant(input);
    if (!input.place_id) {
      throw new Error('place_id is required');
    }
    const place = this.getPlace(input.tenant_id, input.place_id);
    if (!place) {
      throw new Error(`Geo place not found: ${input.place_id}`);
    }
    const session = place.session_id ? this.getSession(input.tenant_id, place.workspace_id, place.session_id) : null;
    const actor = input.created_by || 'system';
    const providerSelection = this.selectProvider({
      tenant_id: input.tenant_id,
      workspace_id: place.workspace_id,
      category: 'geo_business_data',
      capability: 'business_reviews',
      use_case: 'lead_discovery',
      preferred_ids: compactUnique([input.provider_integration_id, place.provider_integration_id, session?.provider_integration_id]),
      allow_fallback: true,
    });
    const liveProvider = await this.maybeExecuteLiveProviderOperation({
      tenant_id: input.tenant_id,
      workspace_id: place.workspace_id,
      provider_selection: providerSelection,
      operation: 'review.list',
      payload: {
        external_place_id: place.external_place_id || '',
        place_key: place.place_key,
        place_name: place.name,
        city: place.city,
        region: place.region,
        country_code: place.country_code,
        limit: Number(input.limit || 20),
      },
      actor_id: actor,
    });
    const importedReviews = (liveProvider?.reviews || []).map((review) => this.ingestReview({
      tenant_id: input.tenant_id,
      place_id: place.id,
      review_key: review.review_key,
      external_review_id: review.external_review_id || '',
      rating: review.rating,
      author_name: review.author_name,
      language_code: review.language_code,
      published_at: review.published_at,
      content: review.content,
      metadata: review.metadata || {},
      created_by: actor,
    }));
    if (providerSelection.selected?.integration_id && providerSelection.selected.integration_id !== place.provider_integration_id) {
      run(
        this.db,
        `UPDATE tenant_geo_places
         SET provider_integration_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND id = ?`,
        [providerSelection.selected.integration_id, actor, input.tenant_id, place.id],
      );
    }
    if (importedReviews.length > 0) {
      run(
        this.db,
        `UPDATE tenant_geo_places
         SET review_count = CASE WHEN review_count > ? THEN review_count ELSE ? END,
             updated_by = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND id = ?`,
        [importedReviews.length, importedReviews.length, actor, input.tenant_id, place.id],
      );
    }
    const providerExecutionMode = liveProvider ? 'live_provider' : 'planned_adapter_fallback';
    const note = liveProvider
      ? 'Live geo review import completed through the tenant-configured geo adapter and stored tenant-scoped review evidence.'
      : 'Geo review import is foundation-ready; live review ingestion will execute once a tenant geo adapter is configured.';
    const artifact = this.artifactStore?.commit({
      tenant_id: input.tenant_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'geo_review_import_result',
      status: 'draft',
      payload: {
        place: this.getPlace(input.tenant_id, place.id),
        provider_selection: providerSelection,
        provider_execution_mode: providerExecutionMode,
        reviews: importedReviews,
        live_provider_result: liveProvider ? omitRawProviderPayload(liveProvider) : null,
        note,
      },
    }) || null;
    this.runStore?.audit(
      input.tenant_id,
      'geo.review_import.completed',
      'tenant_geo_place',
      place.id,
      {
        provider_integration_id: providerSelection.selected?.integration_id || null,
        provider_execution_mode: providerExecutionMode,
        imported_reviews: importedReviews.length,
        artifact_id: artifact?.id || null,
      },
      actor,
    );
    return {
      place: this.getPlace(input.tenant_id, place.id),
      provider_selection: providerSelection,
      provider_execution_mode: providerExecutionMode,
      reviews: importedReviews,
      artifact,
      live_provider_result: liveProvider ? omitRawProviderPayload(liveProvider) : null,
      note,
    };
  }

  listInsights(input) {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [input.tenant_id, workspaceId];
    if (input.place_id) {
      clauses.push('place_id = ?');
      params.push(input.place_id);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_place_insights
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, Number(input.limit || 50)],
    ).map(decodeInsight);
  }

  getInsight(tenantId, insightId) {
    return decodeInsight(
      one(
        this.db,
        'SELECT * FROM tenant_geo_place_insights WHERE tenant_id = ? AND id = ?',
        [tenantId, insightId],
      ),
    );
  }

  getLatestInsight(tenantId, placeId) {
    return decodeInsight(
      one(
        this.db,
        `SELECT * FROM tenant_geo_place_insights
         WHERE tenant_id = ? AND place_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, placeId],
      ),
    );
  }

  listOutreachDrafts(input) {
    ensureTenant(input);
    const workspaceId = normalizeWorkspaceId(input);
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [input.tenant_id, workspaceId];
    if (input.place_id) {
      clauses.push('place_id = ?');
      params.push(input.place_id);
    }
    if (input.channel) {
      clauses.push('channel = ?');
      params.push(input.channel);
    }
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_geo_outreach_drafts
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      [...params, Number(input.limit || 50)],
    ).map(decodeDraft);
  }

  async extractPlacePainSignals(input: JsonRecord, context: JsonRecord = {}) {
    ensureTenant(input);
    if (!input.place_id) {
      throw new Error('place_id is required');
    }
    if (!this.modelGateway) {
      throw new Error('Model gateway is not configured');
    }
    const place = this.getPlace(input.tenant_id, input.place_id);
    if (!place) {
      throw new Error(`Geo place not found: ${input.place_id}`);
    }
    const reviews = this.listReviews({
      tenant_id: input.tenant_id,
      place_id: place.id,
      limit: Number(input.review_limit || 20),
    });
    if (reviews.length === 0) {
      throw new Error('At least one review is required to generate a place insight');
    }
    const modelResult = await this.modelGateway.complete(
      {
        tenantId: input.tenant_id,
        workspaceId: place.workspace_id,
        userId: input.created_by || 'system',
        sessionId: context.sessionId || null,
        workflowRunId: context.workflowRunId || null,
        agentRunId: context.agentRunId || null,
      },
      {
        provider: 'tenant_default',
        fallback_provider: 'dry_run',
        purpose: 'geo.extract_pain_signals',
        prompt: renderInsightPrompt(place, reviews, input),
        response_schema: {
          type: 'object',
          required: ['summary', 'pain_signals'],
          properties: {
            summary: { type: 'string' },
            pain_signals: {
              type: 'array',
              items: {
                type: 'object',
                required: ['signal'],
                properties: {
                  signal: { type: 'string' },
                  evidence_review_id: { type: 'string' },
                  evidence: { type: 'string' },
                  urgency: { type: 'string' },
                },
              },
            },
          },
        },
      },
    );
    const aiWorkerRuntime = this.resolveAIWorkerRuntimeConfig(input.tenant_id, place.workspace_id);
    const payload = aiWorkerRuntime
      ? await this.aiWorkerClient.extractPainSignals({
          place,
          reviews,
          input,
          model_output: modelResult.output
        }, {
          runtimeConfig: aiWorkerRuntime
        })
      : normalizeInsightPayload(modelResult.output, reviews);
    const insightId = input.id || id('geo_insight');
    run(
      this.db,
      `INSERT INTO tenant_geo_place_insights (
        id, tenant_id, workspace_id, place_id, summary, pain_signals, source_review_ids,
        model_call_id, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        insightId,
        input.tenant_id,
        place.workspace_id,
        place.id,
        payload.summary,
        json(payload.pain_signals),
        json(reviews.map((review) => review.id)),
        modelResult.model_call?.id || null,
        input.status || 'draft',
        input.created_by || 'system',
      ],
    );
    const insight = this.getInsight(input.tenant_id, insightId);
    const artifact = this.artifactStore?.commit({
      tenant_id: input.tenant_id,
      workspace_id: place.workspace_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'geo_place_insight',
      status: 'draft',
      payload: {
        place,
        insight,
        model_call_id: modelResult.model_call?.id || null,
      },
    }) || null;
    if (artifact) {
      run(
        this.db,
        'UPDATE tenant_geo_place_insights SET artifact_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [artifact.id, insight.id],
      );
    }
    this.runStore?.audit(
      input.tenant_id,
      'geo.place_insight.generated',
      'tenant_geo_place_insight',
      insight.id,
      { place_id: place.id, artifact_id: artifact?.id || null },
      input.created_by || 'system',
    );
    return {
      insight: this.getInsight(input.tenant_id, insight.id),
      artifact,
      model_call: modelResult.model_call || null,
    };
  }

  async generateOutreachDraft(input: JsonRecord, context: JsonRecord = {}) {
    ensureTenant(input);
    if (!input.place_id) {
      throw new Error('place_id is required');
    }
    if (!input.product_offer) {
      throw new Error('product_offer is required');
    }
    if (!this.modelGateway) {
      throw new Error('Model gateway is not configured');
    }
    const place = this.getPlace(input.tenant_id, input.place_id);
    if (!place) {
      throw new Error(`Geo place not found: ${input.place_id}`);
    }
    const insight = input.insight_id
      ? this.getInsight(input.tenant_id, input.insight_id)
      : this.getLatestInsight(input.tenant_id, place.id);
    const modelResult = await this.modelGateway.complete(
      {
        tenantId: input.tenant_id,
        workspaceId: place.workspace_id,
        userId: input.created_by || 'system',
        sessionId: context.sessionId || null,
        workflowRunId: context.workflowRunId || null,
        agentRunId: context.agentRunId || null,
      },
      {
        provider: 'tenant_default',
        fallback_provider: 'dry_run',
        purpose: 'geo.generate_outreach_draft',
        prompt: renderOutreachPrompt(place, insight, input),
        response_schema: {
          type: 'object',
          required: ['subject', 'message', 'personalization_points'],
          properties: {
            subject: { type: 'string' },
            message: { type: 'string' },
            personalization_points: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    );
    const aiWorkerRuntime = this.resolveAIWorkerRuntimeConfig(input.tenant_id, place.workspace_id);
    const payload = aiWorkerRuntime
      ? await this.aiWorkerClient.personalizeOutreach({
          place,
          insight,
          input,
          model_output: modelResult.output
        }, {
          runtimeConfig: aiWorkerRuntime
        })
      : normalizeOutreachPayload(modelResult.output, place, input);
    const draftId = input.id || id('geo_draft');
    run(
      this.db,
      `INSERT INTO tenant_geo_outreach_drafts (
        id, tenant_id, workspace_id, place_id, insight_id, channel, product_offer, subject,
        message, personalization_points, model_call_id, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        draftId,
        input.tenant_id,
        place.workspace_id,
        place.id,
        insight?.id || null,
        input.channel || 'email',
        input.product_offer,
        payload.subject,
        payload.message,
        json(payload.personalization_points),
        modelResult.model_call?.id || null,
        input.status || 'draft',
        input.created_by || 'system',
      ],
    );
    const draft = decodeDraft(
      one(this.db, 'SELECT * FROM tenant_geo_outreach_drafts WHERE tenant_id = ? AND id = ?', [input.tenant_id, draftId]),
    );
    const artifact = this.artifactStore?.commit({
      tenant_id: input.tenant_id,
      workspace_id: place.workspace_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'geo_outreach_draft',
      status: 'draft',
      payload: {
        place,
        insight,
        draft,
        model_call_id: modelResult.model_call?.id || null,
      },
    }) || null;
    if (artifact) {
      run(
        this.db,
        'UPDATE tenant_geo_outreach_drafts SET artifact_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [artifact.id, draft.id],
      );
    }
    this.runStore?.audit(
      input.tenant_id,
      'geo.outreach_draft.generated',
      'tenant_geo_outreach_draft',
      draft.id,
      { place_id: place.id, artifact_id: artifact?.id || null, channel: draft.channel },
      input.created_by || 'system',
    );
    return {
      draft: decodeDraft(
        one(this.db, 'SELECT * FROM tenant_geo_outreach_drafts WHERE tenant_id = ? AND id = ?', [input.tenant_id, draft.id]),
      ),
      artifact,
      model_call: modelResult.model_call || null,
    };
  }

  selectProvider(input) {
    return this.providerRegistryStore?.previewSelection(input) || {
      selected: null,
      selection_basis: 'provider_registry_unavailable',
      policy_overlay: null,
      candidates: [],
    };
  }

  async maybeExecuteLiveProviderOperation({ tenant_id, workspace_id = 'default', provider_selection, operation, payload, actor_id = 'system' }) {
    const integrationId = provider_selection?.selected?.integration_id;
    if (!integrationId || !this.providerRegistryStore) return null;
    if (!this.providerRegistryStore.adapterRegistry.has(integrationId)) return null;
    const config = this.providerRegistryStore.integrationConfigStore.getConfig(tenant_id, workspace_id, integrationId);
    if (!config || config.status === 'disabled') return null;
    return this.providerRegistryStore.executeProviderOperation({
      tenant_id,
      workspace_id,
      integration_id: integrationId,
      operation,
      payload,
      actor_id,
    });
  }

  resolveAIWorkerRuntimeConfig(tenantId, workspaceId = 'default') {
    if (this.integrationConfigStore) {
      const config = this.integrationConfigStore.getConfig(tenantId, workspaceId, 'opc-ai-worker');
      if (config && config.status !== 'disabled') {
        const runtime = this.integrationConfigStore.resolveRuntimeConfig({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          integration_id: 'opc-ai-worker'
        });
        if (runtime.runtime_status === 'ready' && runtime.runtime_config?.base_url) {
          return runtime.runtime_config;
        }
      }
    }
    if (this.aiWorkerClient?.isConfigured?.()) {
      return { base_url: this.aiWorkerClient.baseUrl };
    }
    return null;
  }
}

function compactUnique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function buildGeoSearchQuery(input, session) {
  const query = [
    input.search_query,
    input.query,
    input.business_type || session?.business_type,
    input.city || session?.city,
    input.region || session?.region,
  ].filter(Boolean).join(' ').trim();
  return query || 'local business discovery';
}

function omitRawProviderPayload(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  const { raw, ...rest } = result;
  return rest;
}
