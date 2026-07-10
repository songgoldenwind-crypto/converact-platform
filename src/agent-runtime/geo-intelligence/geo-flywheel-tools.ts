import type { GeoFlywheelStore, FlywheelReviewResult } from './geo-flywheel-store.js';

export function createGeoFlywheelTools(flywheelStore: GeoFlywheelStore) {
  return {
    'geo_flywheel.review': {
      description: '运行飞轮审查，生成双向信号',
      execute(input: Record<string, unknown>): FlywheelReviewResult {
        return flywheelStore.runFlywheelReview({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          triggered_at: input.triggered_at ? String(input.triggered_at) : 'manual',
          source_ref: input.source_ref ? String(input.source_ref) : undefined,
        });
      },
    },

    'geo_flywheel.list_reviews': {
      description: '列出飞轮审查历史',
      execute(input: Record<string, unknown>): Record<string, unknown> {
        const reviews = flywheelStore.listFlywheelReviews({
          tenant_id: String(input.tenant_id),
          workspace_id: input.workspace_id ? String(input.workspace_id) : undefined,
          limit: typeof input.limit === 'number' ? input.limit : 50,
        });
        return { reviews, count: reviews.length };
      },
    },
  };
}

export type GeoFlywheelTools = ReturnType<typeof createGeoFlywheelTools>;
