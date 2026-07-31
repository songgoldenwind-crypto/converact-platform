import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { BrandKbStore } from '../src/agent-runtime/geo-intelligence/brand-kb-store.js';
import { GeoMonitorStore } from '../src/agent-runtime/geo-intelligence/geo-monitor-store.js';
import { GeoContentStore } from '../src/agent-runtime/geo-intelligence/geo-content-store.js';
import { GeoFlywheelStore } from '../src/agent-runtime/geo-intelligence/geo-flywheel-store.js';

const TENANT = 'test-tenant-geo-flywheel';

function makeStores() {
  const db = createDatabase(':memory:');
  (db as any).exec(`INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES ('${TENANT}', 'Test Tenant', CURRENT_TIMESTAMP)`);
  const brandKbStore = new BrandKbStore(db);
  const geoMonitorStore = new GeoMonitorStore(db);
  const geoContentStore = new GeoContentStore(db);
  const flywheelStore = new GeoFlywheelStore(db, brandKbStore, geoMonitorStore, geoContentStore);
  return { db, brandKbStore, geoMonitorStore, geoContentStore, flywheelStore };
}

describe('GeoFlywheelStore', () => {
  it('runFlywheelReview with empty KB returns all kb_gap_tasks', () => {
    const { flywheelStore } = makeStores();
    const result = flywheelStore.runFlywheelReview({ tenant_id: TENANT });

    // With empty KB: missing entities, facts, cases, FAQs → kb_gap_tasks populated
    assert.ok(result.kb_gap_tasks.length > 0, 'Should have kb_gap_tasks with empty KB');
    assert.ok(result.review_id.startsWith('gfw_'));
    assert.equal(result.triggered_at, 'manual');
    // All objection types missing → 5 outbound signals
    assert.equal(result.outbound_to_geo_signals.length, 5);
    assert.ok(result.outbound_to_geo_signals.every(s => s.signal_type === 'faq_gap'));
  });

  it('runFlywheelReview with cited snapshots generates geo_to_outbound_signals', () => {
    const { db, geoMonitorStore, flywheelStore } = makeStores();
    // Insert cited snapshots
    geoMonitorStore.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'test query', cited: true });
    geoMonitorStore.recordSnapshot({ tenant_id: TENANT, platform: 'kimi', query_text: 'test query 2', cited: true });

    const result = flywheelStore.runFlywheelReview({ tenant_id: TENANT });
    assert.equal(result.geo_to_outbound_signals.length, 2);
    assert.ok(result.geo_to_outbound_signals.every(s => s.signal_type === 'citation_signal'));
    assert.ok(result.geo_to_outbound_signals.every(s => s.score_delta === 10));
  });

  it('runFlywheelReview saves review to DB and can be listed', () => {
    const { flywheelStore } = makeStores();
    flywheelStore.runFlywheelReview({ tenant_id: TENANT, triggered_at: 'weekly_heartbeat' });
    flywheelStore.runFlywheelReview({ tenant_id: TENANT });

    const reviews = flywheelStore.listFlywheelReviews({ tenant_id: TENANT });
    assert.equal(reviews.length, 2);
    const firstReview = reviews[0] as Record<string, unknown>;
    assert.ok(Array.isArray(firstReview.kb_gap_tasks));
    assert.ok(Array.isArray(firstReview.outbound_to_geo_signals));
    assert.ok(Array.isArray(firstReview.geo_to_outbound_signals));
  });

  it('flywheel_health_score increases as KB improves', () => {
    const { flywheelStore, brandKbStore } = makeStores();

    const resultEmpty = flywheelStore.runFlywheelReview({ tenant_id: TENANT });
    const scoreEmpty = resultEmpty.flywheel_health_score;

    // Add KB data to improve completeness
    brandKbStore.upsertEntity({ tenant_id: TENANT, entity_type: 'brand', entity_name: 'MyBrand', verified: true });
    brandKbStore.upsertEntity({ tenant_id: TENANT, entity_type: 'product', entity_name: 'Product A', verified: true });
    brandKbStore.upsertEntity({ tenant_id: TENANT, entity_type: 'service', entity_name: 'Service B', verified: true });
    brandKbStore.upsertFactCard({ tenant_id: TENANT, fact_type: 'definition', fact_content: 'We are X', citability_score: 0.9, verified: true });
    brandKbStore.upsertFactCard({ tenant_id: TENANT, fact_type: 'data_point', fact_content: 'We grew 3x', citability_score: 0.8, verified: true });

    const resultImproved = flywheelStore.runFlywheelReview({ tenant_id: TENANT });
    assert.ok(
      resultImproved.flywheel_health_score > scoreEmpty,
      `Health score should improve: ${scoreEmpty} → ${resultImproved.flywheel_health_score}`
    );
  });
});
