import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { GeoMonitorStore } from '../src/agent-runtime/geo-intelligence/geo-monitor-store.js';

const TENANT = 'test-tenant-geo-monitor';

function makeDb() {
  const db = createDatabase(':memory:');
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, plan_code) VALUES (?, ?, ?)`).run(TENANT, 'Test Tenant', 'free');
  return db;
}

describe('GeoMonitorStore', () => {
  it('create monitoring task and list', () => {
    const db = makeDb();
    const store = new GeoMonitorStore(db);
    const taskId = store.createMonitoringTask({
      tenant_id: TENANT,
      task_type: 'brand',
      query_text: '推荐一款 CRM 工具',
      target_platforms: ['deepseek', 'kimi'],
    });
    assert.ok(taskId.startsWith('gmt_'));

    const tasks = store.listMonitoringTasks({ tenant_id: TENANT });
    assert.equal(tasks.length, 1);
    const task = tasks[0] as Record<string, unknown>;
    assert.equal(task.query_text, '推荐一款 CRM 工具');
    assert.deepEqual(task.target_platforms, ['deepseek', 'kimi']);
    assert.equal(task.active, true);
  });

  it('record snapshots and list with cited_only filter', () => {
    const db = makeDb();
    const store = new GeoMonitorStore(db);

    const snap1 = store.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'what is X?', cited: true, citation_position: 1 });
    const snap2 = store.recordSnapshot({ tenant_id: TENANT, platform: 'kimi', query_text: 'what is X?', cited: false });
    const snap3 = store.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'what is Y?', cited: true });

    assert.ok(snap1.startsWith('gvs_'));
    assert.ok(snap2.startsWith('gvs_'));

    const all = store.listSnapshots({ tenant_id: TENANT });
    assert.equal(all.length, 3);

    const cited = store.listSnapshots({ tenant_id: TENANT, cited_only: true });
    assert.equal(cited.length, 2);
    assert.ok((cited as Record<string, unknown>[]).every(s => s.cited === true));

    const byPlatform = store.listSnapshots({ tenant_id: TENANT, platform: 'deepseek' });
    assert.equal(byPlatform.length, 2);
  });

  it('add fact correction and update status', () => {
    const db = makeDb();
    const store = new GeoMonitorStore(db);

    const corrId = store.createFactCorrectionEntry({
      tenant_id: TENANT,
      ai_stated_fact: 'Product costs $500/month',
      correct_fact_ref: 'Actual price is $300/month',
      discrepancy_type: 'wrong_number',
      platform: 'deepseek',
    });
    assert.ok(corrId.startsWith('gfc_'));

    const corrections = store.listFactCorrections({ tenant_id: TENANT });
    assert.equal(corrections.length, 1);
    assert.equal((corrections[0] as Record<string, unknown>).correction_status, 'pending');

    store.updateCorrectionStatus(corrId, 'resolved');
    const pending = store.listFactCorrections({ tenant_id: TENANT, correction_status: 'pending' });
    assert.equal(pending.length, 0);
    const resolved = store.listFactCorrections({ tenant_id: TENANT, correction_status: 'resolved' });
    assert.equal(resolved.length, 1);
  });

  it('generateVisibilityReport with no snapshots returns empty report', () => {
    const db = makeDb();
    const store = new GeoMonitorStore(db);
    const report = store.generateVisibilityReport({ tenant_id: TENANT, period: 'weekly' });

    assert.equal(report.period, 'weekly');
    assert.equal(report.total_snapshots, 0);
    assert.equal(report.cited_count, 0);
    assert.equal(report.overall_visibility_score, 0);
    assert.deepEqual(report.platform_breakdown, []);
    assert.ok(report.recommended_actions.includes('开始监控品牌曝光度'));
    assert.ok(report.report_id.startsWith('gvr_'));
  });

  it('generateVisibilityReport with mixed cited/not-cited computes correct citation_rate', () => {
    const db = makeDb();
    const store = new GeoMonitorStore(db);

    // 3 cited, 2 not cited on deepseek; 1 cited, 1 not on kimi
    store.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'q1', cited: true });
    store.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'q2', cited: true });
    store.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'q3', cited: true });
    store.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'q4', cited: false });
    store.recordSnapshot({ tenant_id: TENANT, platform: 'deepseek', query_text: 'q5', cited: false });
    store.recordSnapshot({ tenant_id: TENANT, platform: 'kimi', query_text: 'q6', cited: true });
    store.recordSnapshot({ tenant_id: TENANT, platform: 'kimi', query_text: 'q7', cited: false });

    const report = store.generateVisibilityReport({ tenant_id: TENANT, period: 'weekly' });

    assert.equal(report.total_snapshots, 7);
    assert.equal(report.cited_count, 4);
    assert.ok(Math.abs(report.overall_visibility_score - 4/7) < 0.001);

    const deepseekBreakdown = report.platform_breakdown.find(p => p.platform === 'deepseek');
    assert.ok(deepseekBreakdown);
    assert.equal(deepseekBreakdown!.snapshot_count, 5);
    assert.ok(Math.abs(deepseekBreakdown!.citation_rate - 3/5) < 0.001);

    const kimiBreakdown = report.platform_breakdown.find(p => p.platform === 'kimi');
    assert.ok(kimiBreakdown);
    assert.equal(kimiBreakdown!.citation_rate, 0.5);
  });
});
