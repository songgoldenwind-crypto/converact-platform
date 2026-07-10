import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, run } from '../src/db.js';
import { GeoContentStore } from '../src/agent-runtime/geo-intelligence/geo-content-store.js';
import { scoreGeoContent } from '../src/agent-runtime/geo-intelligence/geo-quality-scorer.js';
import { createGeoContentTools } from '../src/agent-runtime/geo-intelligence/geo-content-tools.js';

const TENANT = 'test-tenant-geo-content';

function makeDb() {
  const db = createDatabase(':memory:');
  // Create tenant to satisfy foreign key constraint
  run(db, `INSERT INTO tenants (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`, [TENANT, 'Test Tenant']);
  return db;
}

describe('GeoContentStore', () => {
  it('create and list intent packs', () => {
    const db = makeDb();
    const store = new GeoContentStore(db);
    const packId = store.createIntentPack({
      tenant_id: TENANT,
      platform_targets: ['deepseek', 'kimi'],
      question_clusters: [{ q: 'what is X?' }],
      content_opportunity_score: 0.8,
    });
    assert.ok(packId.startsWith('gci_'));
    const packs = store.listIntentPacks({ tenant_id: TENANT });
    assert.equal(packs.length, 1);
    const pack = packs[0] as Record<string, unknown>;
    assert.deepEqual(pack.platform_targets, ['deepseek', 'kimi']);
    assert.equal(pack.content_opportunity_score, 0.8);
  });

  it('create and list content plans with status filter', () => {
    const db = makeDb();
    const store = new GeoContentStore(db);
    const planId1 = store.createContentPlan({ tenant_id: TENANT, content_type: 'explainer', priority: 'p0' });
    const planId2 = store.createContentPlan({ tenant_id: TENANT, content_type: 'comparison', priority: 'p1' });
    assert.ok(planId1.startsWith('gcp_'));
    assert.ok(planId2.startsWith('gcp_'));

    const all = store.listContentPlans({ tenant_id: TENANT });
    assert.equal(all.length, 2);

    store.updateContentPlanStatus(planId1, 'done');
    const done = store.listContentPlans({ tenant_id: TENANT, status: 'done' });
    assert.equal(done.length, 1);
    const donePlan = done[0] as Record<string, unknown>;
    assert.equal(donePlan.id, planId1);

    const pending = store.listContentPlans({ tenant_id: TENANT, status: 'pending' });
    assert.equal(pending.length, 1);
  });

  it('create article draft, update status, and retrieve', () => {
    const db = makeDb();
    const store = new GeoContentStore(db);
    const articleId = store.createArticleDraft({
      tenant_id: TENANT,
      title: 'Test Article',
      markdown_content: '# Hello\nThis is test content.',
    });
    assert.ok(articleId.startsWith('gca_'));

    const article = store.getArticleDraft(articleId) as Record<string, unknown>;
    assert.equal(article.title, 'Test Article');
    assert.equal(article.publish_status, 'draft');

    store.updateArticleDraft(articleId, { publish_status: 'review' });
    const updated = store.getArticleDraft(articleId) as Record<string, unknown>;
    assert.equal(updated.publish_status, 'review');

    const list = store.listArticleDrafts({ tenant_id: TENANT, publish_status: 'review' });
    assert.equal(list.length, 1);
  });
});

describe('scoreGeoContent', () => {
  it('short content scores low and fails publish gate', () => {
    const score = scoreGeoContent({ markdown_content: 'Hello world. This is short.', title: 'Short' });
    assert.ok(score.word_count < 100);
    assert.ok(score.overall < 0.7);
    assert.equal(score.publish_gate_passed, false);
    assert.equal(score.has_definition_block, false);
    assert.equal(score.has_comparison_block, false);
  });

  it('long structured content with definitions/data/comparisons scores high and passes gate', () => {
    // Build content that should pass: 1000+ words, 6+ headings, definition, 2+ data points, comparison
    const heading = (n: number) => `\n# Heading ${n}\n`;
    const words = (n: number) => ('word '.repeat(n));
    const content = [
      heading(1), 'This product **is defined as** a solution for X.', words(150),
      heading(2), 'Key data: 85% success rate, 3x faster, 200倍 efficiency.', words(150),
      heading(3), 'Comparison: | Feature | A | B |\n|---|---|---|\n| Speed | Fast | Slow |', words(150),
      heading(4), words(150),
      heading(5), words(150),
      heading(6), words(200),
    ].join('\n');

    const score = scoreGeoContent({ markdown_content: content, title: 'Structured Article' });
    assert.ok(score.word_count >= 1000, `word_count=${score.word_count} should be >= 1000`);
    assert.ok(score.heading_count >= 6, `heading_count=${score.heading_count} should be >= 6`);
    assert.equal(score.has_definition_block, true);
    assert.ok(score.data_point_count >= 2, `data_point_count=${score.data_point_count} should be >= 2`);
    assert.equal(score.has_comparison_block, true);
    assert.ok(score.overall >= 0.7, `overall=${score.overall} should be >= 0.7`);
    assert.equal(score.publish_gate_passed, true);
  });
});

describe('createGeoContentTools', () => {
  it('create_article auto-scores and saves quality score', () => {
    const db = makeDb();
    const store = new GeoContentStore(db);
    const tools = createGeoContentTools(store, scoreGeoContent);

    const result = tools['geo_content.create_article'].execute({
      tenant_id: TENANT,
      title: 'Auto-scored Article',
      markdown_content: '# Hello\nThis is content. is defined as something.',
    }) as Record<string, unknown>;

    assert.ok(typeof (result.article_id as string) === 'string');
    assert.ok((result.article_id as string).startsWith('gca_'));
    const score = result.geo_quality_score as Record<string, unknown>;
    assert.ok(typeof score.overall === 'number');
    assert.ok(typeof score.publish_gate_passed === 'boolean');

    // Verify saved to DB
    const article = store.getArticleDraft(result.article_id as string) as Record<string, unknown>;
    const savedScore = article.geo_quality_score as Record<string, unknown>;
    assert.ok(typeof savedScore.overall === 'number');
  });
});
