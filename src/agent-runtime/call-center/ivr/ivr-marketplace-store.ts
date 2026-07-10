import { all, id, json, one, parseJson, run } from '../../../db.js';
import type { IvrMenuDefinition } from '../agent-tools/ivr-menu.js';
import { getIvrMenu } from '../agent-tools/ivr-menu.js';

export interface IvrMarketplaceComponent {
  id: string;
  tenant_id: string | null;
  name: string;
  version: string;
  author: string;
  description: string;
  manifest: IvrMenuDefinition;
  status: 'draft' | 'published';
  created_at: string;
}

export interface IvrComponentInstall {
  id: string;
  tenant_id: string;
  component_id: string;
  menu_key: string;
  enabled: boolean;
  installed_at: string;
}

const BUILTIN_COMPONENTS: Array<Omit<IvrMarketplaceComponent, 'id' | 'created_at' | 'tenant_id'>> = [
  {
    name: '标准欢迎菜单',
    version: '1.0.0',
    author: 'OPC',
    description: '销售/客服/语音信箱三分支',
    status: 'published',
    manifest: getIvrMenu('default')
  },
  {
    name: '售后优先菜单',
    version: '1.0.0',
    author: 'OPC',
    description: '按 1 直达客服队列',
    status: 'published',
    manifest: {
      id: 'support_first',
      greeting: '欢迎致电售后热线。按 1 转客服，按 2 转销售，按 0 留言。',
      options: [
        { digit: '1', label: '客服', route_type: 'queue', route_target: 'default' },
        { digit: '2', label: '销售', route_type: 'queue', route_target: 'sales' },
        { digit: '0', label: '语音信箱', route_type: 'voicemail', route_target: 'default' }
      ],
      timeout_route_type: 'queue',
      timeout_route_target: 'default'
    }
  }
];

export class IvrMarketplaceStore {
  constructor(private readonly db: unknown) {}

  ensureBuiltins(): void {
    for (const builtin of BUILTIN_COMPONENTS) {
      const existing = one(
        this.db,
        'SELECT id FROM ivr_marketplace_components WHERE name = ? AND tenant_id IS NULL',
        [builtin.name]
      );
      if (existing) continue;
      // Wrap INSERT in try/catch — concurrent listCatalog calls may both
      // reach here. The second INSERT will fail on UNIQUE constraint, but
      // we don't want to crash the read path.
      try {
        run(
          this.db,
          `INSERT INTO ivr_marketplace_components
            (id, tenant_id, name, version, author, description, manifest, status)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
          [
            id('ivrc'),
            builtin.name,
            builtin.version,
            builtin.author,
            builtin.description,
            json(builtin.manifest),
            builtin.status
          ]
        );
      } catch {
        // Concurrent insert — builtin already exists, safe to ignore.
      }
    }
  }

  listCatalog(tenantId: string | null = null): IvrMarketplaceComponent[] {
    this.ensureBuiltins();
    const rows = tenantId
      ? all(
          this.db,
          `SELECT * FROM ivr_marketplace_components
           WHERE status = 'published' AND (tenant_id IS NULL OR tenant_id = ?)
           ORDER BY created_at DESC`,
          [tenantId]
        )
      : all(
          this.db,
          `SELECT * FROM ivr_marketplace_components WHERE status = 'published' ORDER BY created_at DESC`,
          []
        );
    return rows.map(decodeComponent);
  }

  publish(
    tenantId: string,
    input: {
      name: string;
      version?: string;
      author?: string;
      description?: string;
      manifest: IvrMenuDefinition;
    }
  ): IvrMarketplaceComponent {
    const componentId = id('ivrc');
    run(
      this.db,
      `INSERT INTO ivr_marketplace_components
        (id, tenant_id, name, version, author, description, manifest, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'published')`,
      [
        componentId,
        tenantId,
        input.name,
        input.version || '1.0.0',
        input.author || 'tenant',
        input.description || '',
        json(input.manifest)
      ]
    );
    return this.getComponent(componentId)!;
  }

  getComponent(componentId: string): IvrMarketplaceComponent | null {
    const row = one(this.db, 'SELECT * FROM ivr_marketplace_components WHERE id = ?', [componentId]);
    return row ? decodeComponent(row as Record<string, unknown>) : null;
  }

  listInstalls(tenantId: string): Array<IvrComponentInstall & { component: IvrMarketplaceComponent | null }> {
    const rows = all(
      this.db,
      `SELECT i.*, c.name AS component_name
       FROM ivr_component_installs i
       LEFT JOIN ivr_marketplace_components c ON c.id = i.component_id
       WHERE i.tenant_id = ?
       ORDER BY i.installed_at DESC`,
      [tenantId]
    );
    return rows.map((row) => {
      const install = decodeInstall(row as Record<string, unknown>);
      const component = this.getComponent(install.component_id);
      return { ...install, component };
    });
  }

  install(tenantId: string, componentId: string, menuKey: string): IvrComponentInstall {
    const component = this.getComponent(componentId);
    if (!component) {
      throw Object.assign(new Error('component not found'), { status: 404 });
    }
    const installId = id('ivri');
    run(
      this.db,
      `INSERT INTO ivr_component_installs (id, tenant_id, component_id, menu_key, enabled)
       VALUES (?, ?, ?, ?, 1)`,
      [installId, tenantId, componentId, menuKey]
    );
    return this.getInstall(installId)!;
  }

  uninstall(tenantId: string, installId: string): boolean {
    const result = run(
      this.db,
      'DELETE FROM ivr_component_installs WHERE id = ? AND tenant_id = ?',
      [installId, tenantId]
    );
    return Number(result?.changes || 0) > 0;
  }

  getMenu(tenantId: string, menuKey: string): IvrMenuDefinition {
    const row = one(
      this.db,
      `SELECT c.manifest FROM ivr_component_installs i
       JOIN ivr_marketplace_components c ON c.id = i.component_id
       WHERE i.tenant_id = ? AND i.menu_key = ? AND i.enabled = 1`,
      [tenantId, menuKey]
    );
    if (row) {
      return parseJson(String((row as { manifest: string }).manifest), getIvrMenu(menuKey)) as IvrMenuDefinition;
    }
    return getIvrMenu(menuKey);
  }

  private getInstall(installId: string): IvrComponentInstall | null {
    const row = one(this.db, 'SELECT * FROM ivr_component_installs WHERE id = ?', [installId]);
    return row ? decodeInstall(row as Record<string, unknown>) : null;
  }
}

export function resolveTenantIvrSelection(
  db: unknown,
  tenantId: string,
  menuKey: string,
  digit: string | null
): { route_type: string; route_target: string; label: string; menu: IvrMenuDefinition } {
  const store = new IvrMarketplaceStore(db);
  const menu = store.getMenu(tenantId, menuKey);
  if (!digit) {
    return {
      menu,
      route_type: menu.timeout_route_type,
      route_target: menu.timeout_route_target,
      label: 'timeout'
    };
  }
  const option = menu.options.find((item) => item.digit === digit);
  if (!option) {
    return {
      menu,
      route_type: menu.timeout_route_type,
      route_target: menu.timeout_route_target,
      label: 'invalid'
    };
  }
  return {
    menu,
    route_type: option.route_type,
    route_target: option.route_target,
    label: option.label
  };
}

function decodeComponent(row: Record<string, unknown>): IvrMarketplaceComponent {
  return {
    id: String(row.id),
    tenant_id: row.tenant_id ? String(row.tenant_id) : null,
    name: String(row.name),
    version: String(row.version),
    author: String(row.author),
    description: String(row.description),
    manifest: parseJson(String(row.manifest || '{}'), getIvrMenu('default')) as IvrMenuDefinition,
    status: String(row.status) as IvrMarketplaceComponent['status'],
    created_at: String(row.created_at)
  };
}

function decodeInstall(row: Record<string, unknown>): IvrComponentInstall {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    component_id: String(row.component_id),
    menu_key: String(row.menu_key),
    enabled: Boolean(row.enabled),
    installed_at: String(row.installed_at)
  };
}
