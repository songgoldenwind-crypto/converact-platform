import type { GeoMonitorStore, GeoVisibilityReport } from './geo-monitor-store.js';

export function createGeoMonitorTools(store: GeoMonitorStore) {
  return {
    'geo_monitor.create_task': {
      description: '创建 GEO 监控任务',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const taskId = store.createMonitoringTask({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          task_type: input.task_type as 'brand',
          query_text: String(input.query_text),
          target_platforms: Array.isArray(input.target_platforms) ? input.target_platforms.map(String) : undefined,
          sampling_count: typeof input.sampling_count === 'number' ? input.sampling_count : undefined,
          schedule_cron: input.schedule_cron ? String(input.schedule_cron) : undefined,
        });
        return { task_id: taskId };
      },
    },

    'geo_monitor.record_snapshot': {
      description: '记录可见性快照',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const snapId = store.recordSnapshot({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          monitoring_task_id: input.monitoring_task_id ? String(input.monitoring_task_id) : undefined,
          platform: String(input.platform),
          query_text: String(input.query_text),
          cited: Boolean(input.cited),
          citation_position: typeof input.citation_position === 'number' ? input.citation_position : undefined,
          citation_excerpt: input.citation_excerpt ? String(input.citation_excerpt) : undefined,
          cited_url: input.cited_url ? String(input.cited_url) : undefined,
          competitor_citations: (input.competitor_citations as Record<string, unknown>) ?? {},
        });
        return { snapshot_id: snapId };
      },
    },

    'geo_monitor.add_fact_correction': {
      description: '添加事实纠偏条目',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const corrId = store.createFactCorrectionEntry({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          snapshot_id: input.snapshot_id ? String(input.snapshot_id) : undefined,
          platform: input.platform ? String(input.platform) : undefined,
          ai_stated_fact: String(input.ai_stated_fact),
          correct_fact_ref: input.correct_fact_ref ? String(input.correct_fact_ref) : undefined,
          discrepancy_type: input.discrepancy_type as 'wrong_number',
        });
        return { correction_id: corrId };
      },
    },

    'geo_monitor.list_corrections': {
      description: '列出事实纠偏条目',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const corrections = store.listFactCorrections({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          correction_status: input.correction_status ? String(input.correction_status) : undefined,
        });
        return { corrections, count: corrections.length };
      },
    },

    'geo_monitor.generate_report': {
      description: '生成 GEO 可见性报告',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const report: GeoVisibilityReport = store.generateVisibilityReport({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          period: (input.period as 'weekly') ?? 'weekly',
        });
        return { report };
      },
    },
  };
}

export type GeoMonitorTools = ReturnType<typeof createGeoMonitorTools>;
