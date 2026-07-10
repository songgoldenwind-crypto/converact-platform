import { resolveAuthContext } from '../../../middleware/auth.js';
import { WhiteLabelStore } from './white-label-store.js';
import {
  EmailTemplateStore,
  renderEmailTemplate,
  type EmailTemplateKey
} from './email-template-store.js';

const TEMPLATE_KEYS = new Set<EmailTemplateKey>(['welcome', 'password_reset', 'call_summary', 'omni_reply']);

export function routeWhiteLabelApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {}
): unknown | undefined {
  const store = new WhiteLabelStore(db);
  const templateStore = new EmailTemplateStore(db);

  if (path === '/api/white-label/resolve' && method === 'GET') {
    const domain = url.searchParams.get('domain');
    if (!domain) return { status: 400, data: { error: 'domain is required' } };
    const row = store.resolveByDomain(domain);
    if (!row) return { status: 404, data: { error: 'domain not mapped' } };
    // Return only brand-facing fields — do NOT expose tenant_id (internal identifier).
    return {
      data: {
        brand_name: row.brand_name,
        logo_url: row.logo_url,
        primary_color: row.primary_color,
        email_from_name: row.email_from_name
      }
    };
  }

  if (path === '/api/white-label/email-templates' && method === 'GET') {
    const tenantId = resolveTenantId(url, headers);
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    return { data: templateStore.list(tenantId) };
  }

  const templateMatch = path.match(/^\/api\/white-label\/email-templates\/([^/]+)$/);
  if (templateMatch && method === 'PUT') {
    const tenantId = resolveTenantId(url, headers, body);
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    const templateKey = templateMatch[1] as EmailTemplateKey;
    if (!TEMPLATE_KEYS.has(templateKey)) {
      return { status: 400, data: { error: 'invalid template_key' } };
    }
    const input = body as { subject?: string; body_html?: string; body_text?: string };
    const updated = templateStore.upsert(tenantId, templateKey, input);
    return { data: updated };
  }

  const previewMatch = path.match(/^\/api\/white-label\/email-templates\/([^/]+)\/preview$/);
  if (previewMatch && method === 'POST') {
    const tenantId = resolveTenantId(url, headers, body);
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    const templateKey = previewMatch[1] as EmailTemplateKey;
    if (!TEMPLATE_KEYS.has(templateKey)) {
      return { status: 400, data: { error: 'invalid template_key' } };
    }
    const template = templateStore.get(tenantId, templateKey);
    const wl = store.getConfig(tenantId);
    const variables = {
      brand_name: wl?.brand_name || 'OPC',
      ...(body as Record<string, string>)
    };
    return { data: renderEmailTemplate(template, variables) };
  }

  if (path !== '/api/white-label') return undefined;

  if (method === 'GET') {
    const tenantId = url.searchParams.get('tenant_id');
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    const config = store.getConfig(tenantId);
    if (!config) return { status: 404, data: { error: 'no white-label config found' } };
    return { data: config };
  }

  if (method === 'PUT') {
    const input = body as {
      tenant_id?: string;
      brand_name?: string;
      logo_url?: string;
      primary_color?: string;
      custom_domain?: string;
      email_from_name?: string;
      email_from_address?: string;
    };
    if (!input?.tenant_id) return { status: 400, data: { error: 'tenant_id is required' } };
    const { tenant_id, ...config } = input;
    const result = store.upsertConfig(tenant_id, config);
    return { data: result };
  }

  return undefined;
}

function resolveTenantId(
  url: URL,
  headers: Record<string, string | string[] | undefined>,
  body?: unknown
): string | null {
  const fromQuery = url.searchParams.get('tenant_id');
  if (fromQuery) return fromQuery;
  const fromBody = (body as { tenant_id?: string } | undefined)?.tenant_id;
  if (fromBody) return fromBody;
  try {
    const ctx = resolveAuthContext(headers);
    return ctx.tenantId || null;
  } catch {
    return null;
  }
}
