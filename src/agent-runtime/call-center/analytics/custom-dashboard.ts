import { all, id, json, parseJson, run } from '../../../db.js';

export interface DashboardWidget {
  id: string;
  tenant_id: string;
  widget_type: string;
  title: string;
  config: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
}

export class DashboardWidgetStore {
  constructor(private readonly db: unknown) {}

  list(tenantId: string): DashboardWidget[] {
    return all(
      this.db,
      'SELECT * FROM dashboard_widgets WHERE tenant_id = ? ORDER BY position ASC, created_at ASC',
      [tenantId]
    ).map(decode);
  }

  upsert(
    tenantId: string,
    widgets: Array<Pick<DashboardWidget, 'widget_type' | 'title' | 'position'> & { config?: Record<string, unknown>; id?: string }>
  ): DashboardWidget[] {
    // Wrap delete+insert in a transaction so a mid-loop failure doesn't
    // leave the tenant with zero widgets (all deleted, none re-inserted).
    run(this.db, 'BEGIN', []);
    try {
      run(this.db, 'DELETE FROM dashboard_widgets WHERE tenant_id = ?', [tenantId]);
      for (const widget of widgets) {
        run(
          this.db,
          `INSERT INTO dashboard_widgets (id, tenant_id, widget_type, title, config, position)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            widget.id || id('wgt'),
            tenantId,
            widget.widget_type,
            widget.title,
            json(widget.config || {}),
            widget.position
          ]
        );
      }
      run(this.db, 'COMMIT', []);
    } catch (error) {
      run(this.db, 'ROLLBACK', []);
      throw error;
    }
    return this.list(tenantId);
  }
}

function decode(row: Record<string, unknown>): DashboardWidget {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    widget_type: String(row.widget_type),
    title: String(row.title),
    config: parseJson(String(row.config || '{}'), {}),
    position: Number(row.position),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
