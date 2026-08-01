import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase, id, json, run } from '../src/db.js';
import { analyzeCostReduction, generatePhase5DReport } from '../src/agent-runtime/phase5d-analytics.js';
import { runPhase5DCacheLoadTest } from '../src/agent-runtime/phase5d-load-test.js';

test('Phase 5D cost analysis projects annual savings from live tables', () => {
  const db = createDatabase(':memory:');
  const tenantId = 'phase5d-cost-tenant';

  run(db, `INSERT INTO tenants (id, name) VALUES (?, ?)`, [tenantId, 'Phase 5D Cost Tenant']);

  for (let index = 0; index < 12; index += 1) {
    run(
      db,
      `INSERT INTO lead_acquisition_runs (
        id, tenant_id, goal, source_strategy, created_at, updated_at
      ) VALUES (?, ?, ?, ?, datetime('now', '-1 day'), datetime('now', '-1 day'))`,
      [
        `run-${index}`,
        tenantId,
        'Validate cache savings',
        json({
          generation_state: { status: index < 2 ? 'fallback' : 'ready' },
          ai_script_variant: { status: index < 2 ? 'fallback' : 'ready' },
          script_cache: { fallback: index < 2 }
        })
      ]
    );
  }

  run(
    db,
    `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value, recorded_at)
     VALUES
     (?, ?, 'cache', 'script_cache_hit', 70, datetime('now', '-1 day')),
     (?, ?, 'cache', 'script_cache_miss', 30, datetime('now', '-1 day'))`,
    [id('stat'), tenantId, id('stat'), tenantId]
  );
  run(
    db,
    `INSERT INTO script_cache (
      id, tenant_id, cache_key, industry, target_profile_hash,
      script_content, variant_source, model, expires_at, hit_count, avg_efficacy
    ) VALUES
    (?, ?, 'finance-a', 'finance', 'profile-a', 'Hello finance prospect', 'ai_generated', 'deepseek-v4', datetime('now', '+1 day'), 12, 0.72),
    (?, ?, 'finance-b', 'finance', 'profile-b', 'Hi there, quick question', 'ai_generated', 'deepseek-v4', datetime('now', '+1 day'), 8, 0.69)`,
    [id('cache'), tenantId, id('cache'), tenantId]
  );

  const analysis = analyzeCostReduction(db, tenantId, 7);
  assert.equal(analysis.totalChecks, 100);
  assert.equal(analysis.cacheHitCount, 70);
  assert.equal(analysis.cacheMissCount, 30);
  assert.equal(analysis.templateFallbackCount, 2);
  assert.ok(analysis.costReductionPercent > 60);
  assert.ok(analysis.estimatedCostSavedUsd > 0);
  assert.ok(analysis.projectedAnnualSavingsUsd > analysis.estimatedCostSavedUsd);
  assert.match(analysis.businessSummary, /Annualized|annually/i);

  const report = generatePhase5DReport(db, tenantId);
  assert.ok(report.recommendations.some((item) => item.includes('Annualized savings')));
});

test('Phase 5D cache load test returns throughput and cleanup metrics', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'converact-phase5d-test-'));
  try {
    const result = runPhase5DCacheLoadTest({
      dbPath: join(dbDir, 'phase5d.sqlite'),
      tenantId: 'phase5d-load-tenant',
      entryCount: 2_000,
      batchSize: 250,
      readCount: 500,
      expiryRatio: 0.15,
      keepDatabase: false
    });

    assert.equal(result.insertedEntries, 2_000);
    assert.equal(result.evictedExpiredEntries, result.expiredSeedCount);
    assert.equal(result.activeEntriesAfterCleanup, 2_000 - result.expiredSeedCount);
    assert.ok(result.insertThroughputPerSecond > 0);
    assert.ok(result.readThroughputPerSecond > 0);
    assert.ok(result.observedReadHitRate >= 75);
    assert.ok(result.databaseSizeBytes > 0);
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});
