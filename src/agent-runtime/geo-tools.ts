import type { JsonRecord } from './integrations/provider-runtime-types.js';

interface RegisterableToolRegistry {
  register: (definition: JsonRecord, handler: (input: JsonRecord, context: JsonRecord) => unknown) => void;
}

interface GeoStoreLike {
  listSessions: (input: JsonRecord) => unknown;
  upsertSession: (input: JsonRecord) => unknown;
  discoverPlaces: (input: JsonRecord, context: JsonRecord) => unknown;
  listPlaces: (input: JsonRecord) => unknown;
  upsertPlace: (input: JsonRecord) => unknown;
  listReviews: (input: JsonRecord) => unknown;
  ingestReview: (input: JsonRecord) => unknown;
  importPlaceReviews: (input: JsonRecord, context: JsonRecord) => unknown;
  listInsights: (input: JsonRecord) => unknown;
  extractPlacePainSignals: (input: JsonRecord, context: JsonRecord) => unknown;
  listOutreachDrafts: (input: JsonRecord) => unknown;
  generateOutreachDraft: (input: JsonRecord, context: JsonRecord) => unknown;
}

export function registerGeoTools(toolRegistry: RegisterableToolRegistry, geoStore: GeoStoreLike): void {
  toolRegistry.register(
    readGeoTool({
      tool_id: 'geo.session_list',
      display_name: 'List tenant geo sessions',
      audit_event_name: 'tool.geo_session_list',
    }),
    (input) => geoStore.listSessions(input),
  );

  toolRegistry.register(
    internalGeoTool({
      tool_id: 'geo.session_upsert',
      display_name: 'Upsert tenant geo session',
      audit_event_name: 'tool.geo_session_upsert',
    }),
    (input, context) => geoStore.upsertSession({ ...input, created_by: input.created_by || context.userId || 'system' }),
  );

  toolRegistry.register(
    internalGeoTool({
      tool_id: 'geo.discover_places',
      display_name: 'Discover tenant geo places through provider',
      audit_event_name: 'tool.geo_discover_places',
    }),
    (input, context) => geoStore.discoverPlaces({ ...input, created_by: input.created_by || context.userId || 'system' }, context),
  );

  toolRegistry.register(
    readGeoTool({
      tool_id: 'geo.place_list',
      display_name: 'List tenant geo places',
      audit_event_name: 'tool.geo_place_list',
    }),
    (input) => geoStore.listPlaces(input),
  );

  toolRegistry.register(
    internalGeoTool({
      tool_id: 'geo.place_upsert',
      display_name: 'Upsert tenant geo place',
      audit_event_name: 'tool.geo_place_upsert',
    }),
    (input, context) => geoStore.upsertPlace({ ...input, created_by: input.created_by || context.userId || 'system' }),
  );

  toolRegistry.register(
    readGeoTool({
      tool_id: 'geo.review_list',
      display_name: 'List tenant geo place reviews',
      audit_event_name: 'tool.geo_review_list',
    }),
    (input) => geoStore.listReviews(input),
  );

  toolRegistry.register(
    internalGeoTool({
      tool_id: 'geo.review_ingest',
      display_name: 'Ingest tenant geo place review',
      audit_event_name: 'tool.geo_review_ingest',
    }),
    (input, context) => geoStore.ingestReview({ ...input, created_by: input.created_by || context.userId || 'system' }),
  );

  toolRegistry.register(
    internalGeoTool({
      tool_id: 'geo.import_place_reviews',
      display_name: 'Import tenant geo place reviews through provider',
      audit_event_name: 'tool.geo_import_place_reviews',
    }),
    (input, context) => geoStore.importPlaceReviews({ ...input, created_by: input.created_by || context.userId || 'system' }, context),
  );

  toolRegistry.register(
    readGeoTool({
      tool_id: 'geo.insight_list',
      display_name: 'List tenant geo place insights',
      audit_event_name: 'tool.geo_insight_list',
    }),
    (input) => geoStore.listInsights(input),
  );

  toolRegistry.register(
    internalGeoTool({
      tool_id: 'geo.extract_place_pain_signals',
      display_name: 'Generate geo place pain insight',
      audit_event_name: 'tool.geo_extract_place_pain_signals',
    }),
    (input, context) => geoStore.extractPlacePainSignals({ ...input, created_by: input.created_by || context.userId || 'system' }, context),
  );

  toolRegistry.register(
    readGeoTool({
      tool_id: 'geo.outreach_draft_list',
      display_name: 'List tenant geo outreach drafts',
      audit_event_name: 'tool.geo_outreach_draft_list',
    }),
    (input) => geoStore.listOutreachDrafts(input),
  );

  toolRegistry.register(
    internalGeoTool({
      tool_id: 'geo.generate_outreach_draft',
      display_name: 'Generate geo outreach draft',
      audit_event_name: 'tool.geo_generate_outreach_draft',
    }),
    (input, context) => geoStore.generateOutreachDraft({ ...input, created_by: input.created_by || context.userId || 'system' }, context),
  );
}

function readGeoTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'geo',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'crm_agent', 'geo_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides,
  };
}

function internalGeoTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'geo',
    category: 'internal_write',
    risk_level: 'R1',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['orchestration_agent', 'crm_agent', 'geo_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides,
  };
}
