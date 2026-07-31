import { resolveAuthContext } from '../../../middleware/auth.js';
import { DashboardWidgetStore } from '../analytics/custom-dashboard.js';
import { ScreenRecordingStore } from '../analytics/screen-recording.js';
import { predictCustomerIntent } from '../analytics/intent-predictor.js';
import { normalizeFacebookMessengerInbound } from '../omnichannel/facebook-adapter.js';
import { evaluateProactivePush, ProactivePushStore } from '../omnichannel/proactive-push.js';
import { predictBestSeat } from '../routing/heuristic-router.js';
import { OmniStore } from '../omnichannel/omni-store.js';
import { receiveOmniInbound } from '../omnichannel/omni-adapters.js';
import { IvrMarketplaceStore } from '../ivr/ivr-marketplace-store.js';
import type { IvrMenuDefinition } from '../agent-tools/ivr-menu.js';
import { FacebookChannelConfigStore } from '../omnichannel/facebook-channel-store.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeSprint12Api(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  _rawBody: Buffer | string = ''
): Promise<unknown | undefined> {
  if (path === '/api/call-center/omni/webhooks/facebook' && method === 'POST') {
    const normalized = normalizeFacebookMessengerInbound(body as Record<string, unknown>);
    if (!normalized) return { data: { ok: true, ignored: true } };
    const store = new OmniStore(db);
    const result = await receiveOmniInbound(
      { db, store },
      {
        tenant_id: normalized.tenant_id,
        channel: 'facebook_messenger',
        content: normalized.text,
        customer_id: normalized.sender_id,
        external_id: normalized.message_id
      }
    );
    return { data: result };
  }

  if (path === '/api/call-center/proactive-push/rules' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: new ProactivePushStore(db).list(ctx.tenantId!) };
  }

  if (path === '/api/call-center/proactive-push/rules' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      name?: string;
      trigger_event?: string;
      channel?: string;
      message_template?: string;
      min_intent_score?: number;
      enabled?: boolean;
    };
    const rule = new ProactivePushStore(db).create({
      tenant_id: ctx.tenantId!,
      name: String(input.name || 'Rule'),
      trigger_event: String(input.trigger_event || 'page_view'),
      channel: String(input.channel || 'web_chat'),
      message_template: String(input.message_template || '您好，需要帮助吗？'),
      min_intent_score: Number(input.min_intent_score ?? 0.5),
      enabled: input.enabled !== false
    });
    return { status: 201, data: rule };
  }

  if (path === '/api/call-center/proactive-push/evaluate' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      trigger_event?: string;
      customer_key?: string;
      intent_score?: number;
      variables?: Record<string, string>;
    };
    const result = evaluateProactivePush(db, {
      tenant_id: ctx.tenantId!,
      trigger_event: String(input.trigger_event || 'page_view'),
      customer_key: String(input.customer_key || 'anonymous'),
      intent_score: input.intent_score,
      variables: input.variables
    });
    return { data: result };
  }

  if (path === '/api/call-center/dashboard/custom' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: new DashboardWidgetStore(db).list(ctx.tenantId!) };
  }

  if (path === '/api/call-center/dashboard/custom' && method === 'PUT') {
    const ctx = requireAuth(headers);
    const input = body as { widgets?: Array<{ widget_type: string; title: string; config?: Record<string, unknown>; position: number }> };
    const widgets = new DashboardWidgetStore(db).upsert(ctx.tenantId!, input.widgets || []);
    return { data: widgets };
  }

  if (path === '/api/call-center/screen-recordings' && method === 'GET') {
    const ctx = requireAuth(headers);
    const limit = Number(url.searchParams.get('limit') || 50);
    return { data: new ScreenRecordingStore(db).list(ctx.tenantId!, limit) };
  }

  if (path === '/api/call-center/screen-recordings' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { call_session_id?: string; seat_id?: string; storage_url?: string; duration_sec?: number };
    if (!input.storage_url) return { status: 400, data: { error: 'storage_url required' } };
    const rec = new ScreenRecordingStore(db).create({
      tenant_id: ctx.tenantId!,
      call_session_id: input.call_session_id,
      seat_id: input.seat_id,
      storage_url: input.storage_url,
      duration_sec: input.duration_sec
    });
    return { status: 201, data: rec };
  }

  if (path === '/api/call-center/routing/predict' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      queue_id?: string;
      required_skills?: string[];
      customer_phone?: string;
      vip_priority?: number;
    };
    const prediction = predictBestSeat(db, {
      tenant_id: ctx.tenantId!,
      queue_id: input.queue_id,
      required_skills: input.required_skills,
      customer_phone: input.customer_phone,
      vip_priority: input.vip_priority
    });
    return { data: prediction };
  }

  if (path === '/api/call-center/intent/predict' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      customer_key?: string;
      signals?: Array<{ event: string; weight?: number; url?: string }>;
      auto_push?: boolean;
      variables?: Record<string, string>;
    };
    const customerKey = String(input.customer_key || 'anonymous');
    const prediction = predictCustomerIntent(
      db,
      ctx.tenantId!,
      customerKey,
      input.signals || [],
      { auto_push: input.auto_push, variables: input.variables }
    );
    return { data: prediction };
  }

  if (path === '/api/call-center/ivr/marketplace' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: new IvrMarketplaceStore(db).listCatalog(ctx.tenantId!) };
  }

  if (path === '/api/call-center/ivr/marketplace' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      name?: string;
      version?: string;
      author?: string;
      description?: string;
      manifest?: IvrMenuDefinition;
    };
    if (!input.manifest) return { status: 400, data: { error: 'manifest required' } };
    const component = new IvrMarketplaceStore(db).publish(ctx.tenantId!, {
      name: String(input.name || '自定义 IVR'),
      version: input.version,
      author: input.author,
      description: input.description,
      manifest: input.manifest
    });
    return { status: 201, data: component };
  }

  if (path === '/api/call-center/ivr/installs' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: new IvrMarketplaceStore(db).listInstalls(ctx.tenantId!) };
  }

  if (path === '/api/call-center/ivr/installs' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { component_id?: string; menu_key?: string };
    if (!input.component_id || !input.menu_key) {
      return { status: 400, data: { error: 'component_id and menu_key required' } };
    }
    const install = new IvrMarketplaceStore(db).install(
      ctx.tenantId!,
      input.component_id,
      input.menu_key
    );
    return { status: 201, data: install };
  }

  const ivrUninstallMatch = path.match(/^\/api\/call-center\/ivr\/installs\/([^/]+)$/);
  if (ivrUninstallMatch && method === 'DELETE') {
    const ctx = requireAuth(headers);
    const ok = new IvrMarketplaceStore(db).uninstall(ctx.tenantId!, ivrUninstallMatch[1]);
    if (!ok) return { status: 404, data: { error: 'install not found' } };
    return { data: { ok: true } };
  }

  if (path === '/api/call-center/omni/facebook-config' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: new FacebookChannelConfigStore(db).get(ctx.tenantId!) };
  }

  if (path === '/api/call-center/omni/facebook-config' && method === 'PUT') {
    const ctx = requireAuth(headers);
    const input = body as { page_id?: string; page_access_token?: string };
    if (!input.page_access_token) return { status: 400, data: { error: 'page_access_token required' } };
    const config = new FacebookChannelConfigStore(db).upsert(ctx.tenantId!, {
      page_id: input.page_id,
      page_access_token: input.page_access_token
    });
    return { data: { tenant_id: config.tenant_id, page_id: config.page_id, updated_at: config.updated_at } };
  }

  return undefined;
}
