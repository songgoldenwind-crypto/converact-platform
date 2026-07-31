import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface WhiteLabelConfig {
  brand_name: string;
  logo_url: string;
  primary_color: string;
  custom_domain: string | null;
  email_from_name: string;
  email_from_address: string;
}

interface EmailTemplate {
  template_key: string;
  subject: string;
  body_html: string;
  body_text: string;
}

interface SsoConfig {
  enabled: boolean;
  issuer_url: string;
  client_id: string;
  redirect_uri: string;
  scopes: string;
  default_role: string;
}

export default function WhiteLabelPage() {
  const { tenantId } = useAuth();
  const [config, setConfig] = useState<WhiteLabelConfig | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [sso, setSso] = useState<SsoConfig | null>(null);
  const [selectedKey, setSelectedKey] = useState('welcome');
  const [preview, setPreview] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const wl = await apiGet<WhiteLabelConfig>(`/api/white-label?tenant_id=${tenantId}`);
      setConfig(wl);
    } catch {
      setConfig({
        brand_name: '',
        logo_url: '',
        primary_color: '#3b82f6',
        custom_domain: '',
        email_from_name: '',
        email_from_address: ''
      });
    }
    const tpls = await apiGet<EmailTemplate[]>(`/api/white-label/email-templates?tenant_id=${tenantId}`);
    setTemplates(tpls);
    try {
      const ssoConfig = await apiGet<SsoConfig>(`/api/auth/sso/config?tenant_id=${tenantId}`);
      setSso(ssoConfig);
    } catch {
      setSso({
        enabled: false,
        issuer_url: '',
        client_id: '',
        redirect_uri: `${window.location.origin}/login`,
        scopes: 'openid profile email',
        default_role: 'operator'
      });
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBrand() {
    if (!config) return;
    await apiPut('/api/white-label', { tenant_id: tenantId, ...config });
    setMessage('品牌配置已保存');
  }

  async function saveTemplate() {
    const tpl = templates.find((t) => t.template_key === selectedKey);
    if (!tpl) return;
    await apiPut(`/api/white-label/email-templates/${selectedKey}`, {
      tenant_id: tenantId,
      subject: tpl.subject,
      body_html: tpl.body_html,
      body_text: tpl.body_text
    });
    setMessage(`模板 ${selectedKey} 已保存`);
  }

  async function previewTemplate() {
    const result = await apiPost<{ subject: string; body_html: string }>(
      `/api/white-label/email-templates/${selectedKey}/preview`,
      { tenant_id: tenantId, brand_name: config?.brand_name || 'OPC', customer_name: '张三' }
    );
    setPreview(`${result.subject}\n\n${result.body_html}`);
  }

  async function saveSso() {
    if (!sso) return;
    const updated = await apiPut<SsoConfig>('/api/auth/sso/config', sso);
    setSso(updated);
    setMessage('SSO 配置已保存');
  }

  const activeTemplate = templates.find((t) => t.template_key === selectedKey);

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-semibold">白标与品牌</h1>
      {message && <p className="text-sm text-green-600">{message}</p>}

      {config && (
        <section className="bg-white border rounded-lg p-4 space-y-3">
          <h2 className="font-medium">品牌外观</h2>
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="品牌名称" value={config.brand_name} onChange={(e) => setConfig({ ...config, brand_name: e.target.value })} />
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="Logo URL" value={config.logo_url} onChange={(e) => setConfig({ ...config, logo_url: e.target.value })} />
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="主色 #3b82f6" value={config.primary_color} onChange={(e) => setConfig({ ...config, primary_color: e.target.value })} />
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="自定义域名 call.example.com" value={config.custom_domain || ''} onChange={(e) => setConfig({ ...config, custom_domain: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <input className="border rounded px-3 py-2 text-sm" placeholder="发件人名称" value={config.email_from_name} onChange={(e) => setConfig({ ...config, email_from_name: e.target.value })} />
            <input className="border rounded px-3 py-2 text-sm" placeholder="发件人邮箱" value={config.email_from_address} onChange={(e) => setConfig({ ...config, email_from_address: e.target.value })} />
          </div>
          <button type="button" onClick={() => void saveBrand()} className="px-4 py-2 bg-blue-600 text-white rounded text-sm">保存品牌</button>
        </section>
      )}

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">邮件模板</h2>
        <select className="border rounded px-3 py-2 text-sm" value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)}>
          {templates.map((t) => (
            <option key={t.template_key} value={t.template_key}>{t.template_key}</option>
          ))}
        </select>
        {activeTemplate && (
          <>
            <input className="w-full border rounded px-3 py-2 text-sm" value={activeTemplate.subject} onChange={(e) => setTemplates(templates.map((t) => t.template_key === selectedKey ? { ...t, subject: e.target.value } : t))} />
            <textarea className="w-full border rounded px-3 py-2 text-sm h-24" value={activeTemplate.body_html} onChange={(e) => setTemplates(templates.map((t) => t.template_key === selectedKey ? { ...t, body_html: e.target.value } : t))} />
            <div className="flex gap-2">
              <button type="button" onClick={() => void saveTemplate()} className="px-4 py-2 bg-blue-600 text-white rounded text-sm">保存模板</button>
              <button type="button" onClick={() => void previewTemplate()} className="px-4 py-2 border rounded text-sm">预览</button>
            </div>
          </>
        )}
        {preview && <pre className="text-xs bg-slate-50 p-3 rounded overflow-auto">{preview}</pre>}
      </section>

      {sso && (
        <section className="bg-white border rounded-lg p-4 space-y-3">
          <h2 className="font-medium">企业 SSO (OIDC)</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sso.enabled} onChange={(e) => setSso({ ...sso, enabled: e.target.checked })} />
            启用 SSO
          </label>
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="Issuer URL" value={sso.issuer_url} onChange={(e) => setSso({ ...sso, issuer_url: e.target.value })} />
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="Client ID" value={sso.client_id} onChange={(e) => setSso({ ...sso, client_id: e.target.value })} />
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="Redirect URI" value={sso.redirect_uri} onChange={(e) => setSso({ ...sso, redirect_uri: e.target.value })} />
          <button type="button" onClick={() => void saveSso()} className="px-4 py-2 bg-blue-600 text-white rounded text-sm">保存 SSO</button>
        </section>
      )}
    </div>
  );
}
