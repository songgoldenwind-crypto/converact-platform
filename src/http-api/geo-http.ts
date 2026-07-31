import { run as dbRun } from '../db.js';
import {
  BrandKbStore, createBrandKbTools,
  GeoContentStore, createGeoContentTools, scoreGeoContent,
  GeoMonitorStore, createGeoMonitorTools,
  GeoFlywheelStore, createGeoFlywheelTools,
} from '../agent-runtime/geo-intelligence/index.js';
import { executeTool, toolContext, requiredQuery } from './_helpers.js';

export async function routeGeoApi(
  db: unknown,
  harness: any,
  method: string,
  path: string,
  url: URL,
  body: any,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/geo/')) {
    return undefined;
  }

  // ── GEO core (sessions/places/reviews/insights/outreach/territories) ────────
  if (path === '/api/geo/sessions' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.session_list');
  }
  if (path === '/api/geo/sessions' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.session_upsert') };
  }
  if (path === '/api/geo/discover' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.discover_places') };
  }
  if (path === '/api/geo/places' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', session_id: url.searchParams.get('session_id'), business_type: url.searchParams.get('business_type'), city: url.searchParams.get('city'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.place_list');
  }
  if (path === '/api/geo/places' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.place_upsert') };
  }
  if (path === '/api/geo/reviews' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', place_id: requiredQuery(url, 'place_id'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.review_list');
  }
  if (path === '/api/geo/reviews' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.review_ingest') };
  }
  if (path === '/api/geo/reviews/import' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.import_place_reviews') };
  }
  if (path === '/api/geo/insights' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', place_id: url.searchParams.get('place_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.insight_list');
  }
  if (path === '/api/geo/insights/generate' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.extract_place_pain_signals') };
  }
  if (path === '/api/geo/outreach-drafts' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', place_id: url.searchParams.get('place_id'), channel: url.searchParams.get('channel'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.outreach_draft_list');
  }
  if (path === '/api/geo/outreach-drafts/generate' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.generate_outreach_draft') };
  }
  if (path === '/api/geo/territories' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', city: url.searchParams.get('city'), business_type: url.searchParams.get('business_type'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.territory_list');
  }
  if (path === '/api/geo/territories' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.territory_upsert') };
  }

  // ── GEO routing policies ────────────────────────────────────────────────────
  if (path === '/api/geo/routing/policies' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_list');
  }
  if (path === '/api/geo/routing/policies/preview' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', territory_id: url.searchParams.get('territory_id'), scope: url.searchParams.get('scope'), limit: Number(url.searchParams.get('limit') || 500) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_preview');
  }
  if (path === '/api/geo/routing/policies/timeline' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', approval_status: url.searchParams.get('approval_status'), override_status: url.searchParams.get('override_status'), limit: Number(url.searchParams.get('limit') || 50), approval_limit: Number(url.searchParams.get('approval_limit') || 50), override_limit: Number(url.searchParams.get('override_limit') || 50), trigger_limit: Number(url.searchParams.get('trigger_limit') || 500) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_timeline');
  }
  if (path === '/api/geo/routing/policies/ops/overview' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', approval_limit: Number(url.searchParams.get('approval_limit') || 20), override_limit: Number(url.searchParams.get('override_limit') || 20), timeline_limit: Number(url.searchParams.get('timeline_limit') || 20), rollout_limit: Number(url.searchParams.get('rollout_limit') || 20), trigger_limit: Number(url.searchParams.get('trigger_limit') || 500) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_ops_overview');
  }
  if (path === '/api/geo/routing/policies/review' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', review_status: url.searchParams.get('review_status'), item_type: url.searchParams.get('item_type'), limit: Number(url.searchParams.get('limit') || 50), attention_limit: Number(url.searchParams.get('attention_limit') || 10), approval_limit: Number(url.searchParams.get('approval_limit') || 50), override_limit: Number(url.searchParams.get('override_limit') || 50), trigger_limit: Number(url.searchParams.get('trigger_limit') || 500), target_event_limit: Number(url.searchParams.get('target_event_limit') || 50), target_audit_event_limit: Number(url.searchParams.get('target_audit_event_limit') || 5) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_review_queue');
  }
  if (path === '/api/geo/routing/policies/review/actions' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', review_status: url.searchParams.get('review_status'), item_type: url.searchParams.get('item_type'), limit: Number(url.searchParams.get('limit') || 50), attention_limit: Number(url.searchParams.get('attention_limit') || 10), approval_limit: Number(url.searchParams.get('approval_limit') || 50), override_limit: Number(url.searchParams.get('override_limit') || 50), trigger_limit: Number(url.searchParams.get('trigger_limit') || 500) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_action_workbench');
  }
  if (path === '/api/geo/routing/policies/review/actions/history' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', review_key: url.searchParams.get('review_key'), action_id: url.searchParams.get('action_id'), status: url.searchParams.get('status'), target_changed_since_execution: url.searchParams.get('target_changed_since_execution'), target_drift_only: url.searchParams.get('target_drift_only'), target_event_limit: Number(url.searchParams.get('target_event_limit') || 50), target_audit_event_limit: Number(url.searchParams.get('target_audit_event_limit') || 5), limit: Number(url.searchParams.get('limit') || 100) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_action_history');
  }
  if (path === '/api/geo/routing/policies/review/actions/target-audit-packet' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', history_limit: Number(url.searchParams.get('history_limit') || 200), review_limit: Number(url.searchParams.get('review_limit') || 100), target_event_limit: Number(url.searchParams.get('target_event_limit') || 100) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_target_audit_packet');
  }
  if (path === '/api/geo/routing/policies/review/actions/plans' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', plan_id: url.searchParams.get('plan_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_batch_plan_list');
  }
  if (path === '/api/geo/routing/policies/review/actions/plans/detail' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', plan_id: requiredQuery(url, 'plan_id') }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_batch_plan_detail');
  }
  if (path === '/api/geo/routing/policies/review/actions/plans/lineage' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', plan_id: requiredQuery(url, 'plan_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 200) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_batch_plan_lineage');
  }
  if (path === '/api/geo/routing/policies/review/actions/plans/target' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id') || 'default', plan_target: url.searchParams.get('plan_target') || 'recommended', limit: Number(url.searchParams.get('limit') || 200) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_batch_plan_target');
  }
  if (path === '/api/geo/routing/policies/overrides' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', policy_id: url.searchParams.get('policy_id'), status: url.searchParams.get('status'), override_kind: url.searchParams.get('override_kind'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_policy_override_list');
  }
  if (path === '/api/geo/routing/policies/overrides/diff' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_override_diff') };
  }
  if (path === '/api/geo/routing/policies' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_upsert') };
  }
  if (path === '/api/geo/routing/policies/rollout' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.rollout_routing_policy') };
  }
  if (path === '/api/geo/routing/policies/review/acknowledge' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_review_acknowledge') };
  }
  if (path === '/api/geo/routing/policies/review/actions/execute' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_review_action_execute') };
  }
  if (path === '/api/geo/routing/policies/review/actions/batch/execute' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_review_batch_execute') };
  }
  if (path === '/api/geo/routing/policies/review/actions/plans/preview' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_batch_plan_preview') };
  }
  if (path === '/api/geo/routing/policies/review/actions/plans' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_batch_plan_upsert') };
  }
  if (path === '/api/geo/routing/policies/review/actions/plans/refresh' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_batch_plan_refresh') };
  }
  if (path === '/api/geo/routing/policies/review/actions/plans/govern' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.routing_policy_batch_plan_govern') };
  }
  if (path === '/api/geo/routing/policies/overrides' && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext(body, body.agent_id || 'ops_agent', 'geo.override_routing_policy'), 'geo.override_routing_policy', body);
    return { status: result.status === 'blocked_pending_approval' ? 202 : 201, data: result };
  }
  const routingPolicyRollbackMatch = path.match(/^\/api\/geo\/routing\/policies\/overrides\/([^/]+)\/rollback$/);
  if (routingPolicyRollbackMatch && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext({ ...body, override_id: routingPolicyRollbackMatch[1] }, body.agent_id || 'ops_agent', 'geo.rollback_routing_policy_override'), 'geo.rollback_routing_policy_override', { ...body, override_id: routingPolicyRollbackMatch[1] });
    return { status: result.status === 'blocked_pending_approval' ? 202 : 200, data: result };
  }

  // ── GEO rep-coverages / territories / handoffs ─────────────────────────────
  if (path === '/api/geo/rep-coverages' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', territory_id: url.searchParams.get('territory_id'), owner_user_id: url.searchParams.get('owner_user_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.rep_coverage_list');
  }
  if (path === '/api/geo/rep-coverages' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.rep_coverage_upsert') };
  }
  if (path === '/api/geo/territories/capacity' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', territory_id: requiredQuery(url, 'territory_id') }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.territory_capacity_report');
  }
  if (path === '/api/geo/territories/rebalance' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.rebalance_territory_handoffs') };
  }
  if (path === '/api/geo/territories/feedback/sync' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.sync_territory_feedback') };
  }
  if (path === '/api/geo/routing/maintenance' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.run_routing_maintenance') };
  }
  if (path === '/api/geo/routing/triggers' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', territory_id: url.searchParams.get('territory_id'), policy_id: url.searchParams.get('policy_id'), scope: url.searchParams.get('scope'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 200) }, url.searchParams.get('agent_id') || 'ops_agent', 'geo.routing_trigger_list');
  }
  if (path === '/api/geo/routing/triggers/bootstrap' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'geo.bootstrap_routing_triggers') };
  }
  if (path === '/api/geo/handoffs' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', place_id: url.searchParams.get('place_id'), owner_user_id: url.searchParams.get('owner_user_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'geo_agent', 'geo.handoff_list');
  }
  if (path === '/api/geo/handoffs/generate' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.generate_handoff_packet') };
  }
  if (path === '/api/geo/handoffs/execute' && method === 'POST') {
    const data = await executeTool(harness, body, body.agent_id || 'geo_agent', 'geo.execute_handoff_packet');
    return { status: data?.execution?.voice_followup?.status === 'blocked_pending_approval' ? 202 : 200, data };
  }

  // ── Brand Knowledge Base (GEO Intelligence Layer) ────────────────────────────
  const brandKbStore = new BrandKbStore(db);
  const brandKbTools = createBrandKbTools(brandKbStore);

  if (path === '/api/geo/brand-kb/entities' && method === 'POST') {
    const { tenant_id, entity_type, entity_name } = body;
    if (!tenant_id || !entity_type || !entity_name) { const err = new Error('tenant_id, entity_type, entity_name required'); (err as any).status = 400; throw err; }
    return { status: 201, data: brandKbTools['brand_kb.upsert_entity'].execute(body) };
  }
  if (path === '/api/geo/brand-kb/entities' && method === 'GET') {
    const tenant_id = requiredQuery(url, 'tenant_id');
    return brandKbTools['brand_kb.list_entities'].execute({ tenant_id, workspace_id: url.searchParams.get('workspace_id') || 'default' });
  }
  if (path === '/api/geo/brand-kb/fact-cards' && method === 'POST') {
    const { tenant_id, fact_type, fact_content } = body;
    if (!tenant_id || !fact_type || !fact_content) { const err = new Error('tenant_id, fact_type, fact_content required'); (err as any).status = 400; throw err; }
    return { status: 201, data: brandKbTools['brand_kb.upsert_fact_card'].execute(body) };
  }
  if (path === '/api/geo/brand-kb/fact-cards' && method === 'GET') {
    const tenant_id = requiredQuery(url, 'tenant_id');
    const min_citability = url.searchParams.get('min_citability');
    return brandKbTools['brand_kb.list_fact_cards'].execute({ tenant_id, workspace_id: url.searchParams.get('workspace_id') || 'default', min_citability: min_citability ? parseFloat(min_citability) : 0 });
  }
  if (path === '/api/geo/brand-kb/cases' && method === 'POST') {
    const { tenant_id, case_title } = body;
    if (!tenant_id || !case_title) { const err = new Error('tenant_id, case_title required'); (err as any).status = 400; throw err; }
    return { status: 201, data: brandKbTools['brand_kb.upsert_case'].execute(body) };
  }
  if (path === '/api/geo/brand-kb/faq' && method === 'POST') {
    const { tenant_id, question, answer } = body;
    if (!tenant_id || !question || !answer) { const err = new Error('tenant_id, question, answer required'); (err as any).status = 400; throw err; }
    return { status: 201, data: brandKbTools['brand_kb.upsert_faq'].execute(body) };
  }
  if (path === '/api/geo/brand-kb/completeness' && method === 'GET') {
    const tenant_id = requiredQuery(url, 'tenant_id');
    return brandKbTools['brand_kb.get_completeness'].execute({ tenant_id, workspace_id: url.searchParams.get('workspace_id') || 'default' });
  }
  if (path === '/api/geo/brand-kb/script-context' && method === 'GET') {
    const tenant_id = requiredQuery(url, 'tenant_id');
    return brandKbTools['brand_kb.get_script_context'].execute({ tenant_id, workspace_id: url.searchParams.get('workspace_id') || 'default' });
  }

  // ── GEO Content Intelligence (Phase 2) ─────────────────────────────────────
  const geoContentStore = new GeoContentStore(db);
  const geoContentTools = createGeoContentTools(geoContentStore, scoreGeoContent);

  if (path === '/api/geo/content/intent-mine' && method === 'POST') {
    const { tenant_id } = body;
    if (!tenant_id) { const err = new Error('tenant_id required'); (err as any).status = 400; throw err; }
    return { status: 201, data: geoContentTools['geo_content.mine_intent'].execute(body) };
  }
  if (path === '/api/geo/content/plans' && method === 'POST') {
    const { tenant_id, content_type } = body;
    if (!tenant_id || !content_type) { const err = new Error('tenant_id, content_type required'); (err as any).status = 400; throw err; }
    return { status: 201, data: geoContentTools['geo_content.create_plan'].execute(body) };
  }
  if (path === '/api/geo/content/plans' && method === 'GET') {
    const tenant_id = requiredQuery(url, 'tenant_id');
    const plans = geoContentStore.listContentPlans({ tenant_id, workspace_id: url.searchParams.get('workspace_id') || 'default', priority: url.searchParams.get('priority') || undefined, status: url.searchParams.get('status') || undefined });
    return { plans, count: plans.length };
  }
  if (path === '/api/geo/content/articles' && method === 'POST') {
    const { tenant_id, title, markdown_content } = body;
    if (!tenant_id || !title || !markdown_content) { const err = new Error('tenant_id, title, markdown_content required'); (err as any).status = 400; throw err; }
    return { status: 201, data: await geoContentTools['geo_content.create_article'].execute(body) };
  }
  if (path === '/api/geo/content/articles' && method === 'GET') {
    return geoContentTools['geo_content.list_articles'].execute({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', publish_status: url.searchParams.get('publish_status') || undefined });
  }
  const articleStatusMatch = path.match(/^\/api\/geo\/content\/articles\/([^/]+)\/status$/);
  if (articleStatusMatch && method === 'PATCH') {
    const { publish_status } = body;
    if (!publish_status) { const err = new Error('publish_status required'); (err as any).status = 400; throw err; }
    return geoContentTools['geo_content.update_article_status'].execute({ article_id: articleStatusMatch[1], publish_status });
  }
  const articlePushMatch = path.match(/^\/api\/geo\/content\/articles\/([^/]+)\/push-to-geoflow$/);
  if (articlePushMatch && method === 'POST') {
    const { tenant_id, geoflow_api_url, geoflow_api_key } = body;
    if (!tenant_id || !geoflow_api_url || !geoflow_api_key) { const err = new Error('tenant_id, geoflow_api_url, geoflow_api_key required'); (err as any).status = 400; throw err; }
    return await geoContentTools['geo_content.push_to_geoflow'].execute({ ...body, article_id: articlePushMatch[1] });
  }

  // ── GEO Visibility Monitor (Phase 3) ──────────────────────────────────────
  const geoMonitorStore = new GeoMonitorStore(db);
  const geoMonitorTools = createGeoMonitorTools(geoMonitorStore);

  if (path === '/api/geo/monitoring/tasks' && method === 'POST') {
    const { tenant_id, task_type, query_text } = body;
    if (!tenant_id || !task_type || !query_text) { const err = new Error('tenant_id, task_type, query_text required'); (err as any).status = 400; throw err; }
    return { status: 201, data: geoMonitorTools['geo_monitor.create_task'].execute(body) };
  }
  if (path === '/api/geo/monitoring/tasks' && method === 'GET') {
    const tenant_id = requiredQuery(url, 'tenant_id');
    const tasks = geoMonitorStore.listMonitoringTasks({ tenant_id, workspace_id: url.searchParams.get('workspace_id') || 'default' });
    return { tasks, count: tasks.length };
  }
  if (path === '/api/geo/monitoring/snapshots' && method === 'POST') {
    const { tenant_id, platform, query_text } = body;
    if (!tenant_id || !platform || !query_text) { const err = new Error('tenant_id, platform, query_text required'); (err as any).status = 400; throw err; }
    const snapshotResult = geoMonitorTools['geo_monitor.record_snapshot'].execute(body);
    if (body.cited === true || body.cited === 1) {
      try {
        dbRun(db, `UPDATE leads SET score_total = MIN(score_total + 10, 100), score_breakdown = json_set(COALESCE(score_breakdown, '{}'), '$.geo_warmth_bonus', 10) WHERE id IN (SELECT id FROM leads WHERE tenant_id = ? AND score_total < 100 ORDER BY score_total DESC LIMIT 5)`, [tenant_id]);
      } catch { /* non-critical */ }
    }
    return { status: 201, data: snapshotResult };
  }
  if (path === '/api/geo/monitoring/snapshots' && method === 'GET') {
    const tenant_id = requiredQuery(url, 'tenant_id');
    const snaps = geoMonitorStore.listSnapshots({ tenant_id, workspace_id: url.searchParams.get('workspace_id') || 'default', platform: url.searchParams.get('platform') || undefined, cited_only: url.searchParams.get('cited_only') === 'true' });
    return { snapshots: snaps, count: snaps.length };
  }
  if (path === '/api/geo/monitoring/fact-corrections' && method === 'POST') {
    const { tenant_id, ai_stated_fact, discrepancy_type } = body;
    if (!tenant_id || !ai_stated_fact || !discrepancy_type) { const err = new Error('tenant_id, ai_stated_fact, discrepancy_type required'); (err as any).status = 400; throw err; }
    return { status: 201, data: geoMonitorTools['geo_monitor.add_fact_correction'].execute(body) };
  }
  if (path === '/api/geo/monitoring/fact-corrections' && method === 'GET') {
    return geoMonitorTools['geo_monitor.list_corrections'].execute({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', correction_status: url.searchParams.get('correction_status') || undefined });
  }
  if (path === '/api/geo/monitoring/reports/latest' && method === 'GET') {
    return geoMonitorTools['geo_monitor.generate_report'].execute({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', period: url.searchParams.get('period') || 'weekly' });
  }

  // ── GEO Flywheel Connector (Phase 4) ───────────────────────────────────────
  const geoFlywheelStore = new GeoFlywheelStore(db, brandKbStore, geoMonitorStore, geoContentStore);
  const geoFlywheelTools = createGeoFlywheelTools(geoFlywheelStore);

  if (path === '/api/geo/flywheel/review' && method === 'POST') {
    const { tenant_id } = body;
    if (!tenant_id) { const err = new Error('tenant_id required'); (err as any).status = 400; throw err; }
    return { status: 201, data: geoFlywheelTools['geo_flywheel.review'].execute(body) };
  }
  if (path === '/api/geo/flywheel/history' && method === 'GET') {
    return geoFlywheelTools['geo_flywheel.list_reviews'].execute({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default' });
  }

  return undefined;
}
