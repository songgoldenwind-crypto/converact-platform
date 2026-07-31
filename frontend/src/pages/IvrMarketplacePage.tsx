import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface IvrManifest {
  id: string;
  greeting: string;
  options: Array<{ digit: string; label: string; route_type: string; route_target: string }>;
}

interface MarketplaceComponent {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  manifest: IvrManifest;
  status: string;
}

interface ComponentInstall {
  id: string;
  component_id: string;
  menu_key: string;
  enabled: boolean;
  component: MarketplaceComponent | null;
}

export default function IvrMarketplacePage() {
  const { tenantId } = useAuth();
  const [catalog, setCatalog] = useState<MarketplaceComponent[]>([]);
  const [installs, setInstalls] = useState<ComponentInstall[]>([]);
  const [menuKey, setMenuKey] = useState('default');
  const [message, setMessage] = useState('');
  const [routeDigit, setRouteDigit] = useState('1');
  const [routeResult, setRouteResult] = useState('');

  const load = useCallback(async () => {
    const [components, installed] = await Promise.all([
      apiGet<MarketplaceComponent[]>('/api/call-center/ivr/marketplace'),
      apiGet<ComponentInstall[]>('/api/call-center/ivr/installs')
    ]);
    setCatalog(components);
    setInstalls(installed);
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function installComponent(componentId: string) {
    await apiPost('/api/call-center/ivr/installs', {
      component_id: componentId,
      menu_key: menuKey
    });
    setMessage(`已安装到菜单键 ${menuKey}`);
    await load();
  }

  async function uninstall(installId: string) {
    await apiDelete(`/api/call-center/ivr/installs/${installId}`);
    setMessage('已卸载');
    await load();
  }

  async function testRoute() {
    const result = await apiPost<{
      menu: IvrManifest;
      route: { route_type: string; route_target: string; label: string };
    }>('/api/call-center/ivr/route', {
      menu_id: menuKey,
      digit: routeDigit,
      tenant_id: tenantId
    });
    setRouteResult(
      `按键 ${routeDigit} → ${result.route.label} (${result.route.route_type}:${result.route.route_target})`
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">IVR 组件市场</h1>
        <p className="text-sm text-slate-500 mt-1">I10 · 安装组件并绑定菜单键（如 default、support_first）</p>
      </div>
      {message && <p className="text-sm text-green-600">{message}</p>}

      <section className="bg-white border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">安装设置</h2>
        <label className="text-sm text-slate-600 block">
          菜单键 menu_key
          <input
            value={menuKey}
            onChange={(e) => setMenuKey(e.target.value)}
            className="mt-1 block border rounded px-3 py-2 text-sm w-full max-w-xs"
            placeholder="default"
          />
        </label>
      </section>

      <section className="bg-white border rounded-lg p-4">
        <h2 className="font-medium mb-3">组件目录</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {catalog.map((item) => (
            <div key={item.id} className="border rounded-lg p-4">
              <div className="font-medium">{item.name}</div>
              <div className="text-xs text-slate-500 mt-1">
                v{item.version} · {item.author}
              </div>
              <p className="text-sm text-slate-600 mt-2">{item.description}</p>
              <p className="text-xs text-slate-400 mt-2 line-clamp-2">{item.manifest.greeting}</p>
              <button
                type="button"
                onClick={() => void installComponent(item.id)}
                className="mt-3 text-sm text-blue-600 hover:underline"
              >
                安装到 {menuKey}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white border rounded-lg p-4">
        <h2 className="font-medium mb-3">已安装</h2>
        {installs.length === 0 && <p className="text-sm text-slate-400">尚未安装组件</p>}
        <ul className="space-y-2">
          {installs.map((row) => (
            <li key={row.id} className="flex items-center gap-3 border rounded px-3 py-2 text-sm">
              <span className="font-mono text-slate-500">{row.menu_key}</span>
              <span className="flex-1">{row.component?.name || row.component_id}</span>
              <button type="button" className="text-red-600" onClick={() => void uninstall(row.id)}>
                卸载
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-slate-50 border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">路由测试</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            value={routeDigit}
            onChange={(e) => setRouteDigit(e.target.value)}
            className="border rounded px-2 py-1 w-16 text-sm"
            maxLength={1}
          />
          <button
            type="button"
            onClick={() => void testRoute()}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm"
          >
            测试 IVR 路由
          </button>
        </div>
        {routeResult && <p className="text-sm text-slate-700">{routeResult}</p>}
      </section>
    </div>
  );
}
