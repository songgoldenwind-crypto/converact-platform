import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { ArtifactStore } from '../src/agent-runtime/stores/artifact-store.js';

let db: ReturnType<typeof createDatabase>;
let store: ArtifactStore;
let tenantId: string;

function setup() {
  db = createDatabase(':memory:');
  store = new ArtifactStore(db, null);
  tenantId = createTenant(db, { name: 'Artifact Test' }).id;
}

test('commit creates artifact with default status draft and version 1', () => {
  setup();
  const art = store.commit({
    tenant_id: tenantId,
    type: 'content_draft',
    payload: { title: 'Hello', body: 'World' }
  });
  assert.ok(art);
  assert.equal(art!.status, 'draft');
  assert.equal(art!.version, 1);
  assert.equal(art!.type, 'content_draft');
  assert.deepEqual(art!.payload, { title: 'Hello', body: 'World' });
});

test('commit respects explicit status and version', () => {
  setup();
  const art = store.commit({
    tenant_id: tenantId,
    type: 'report',
    status: 'published',
    version: 3,
    payload: { data: 42 }
  });
  assert.equal(art!.status, 'published');
  assert.equal(art!.version, 3);
});

test('get returns null for non-existent artifact', () => {
  setup();
  assert.equal(store.get(tenantId, 'nonexistent'), null);
});

test('get enforces tenant isolation', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  // Different tenant can't see it
  const otherTenant = createTenant(db, { name: 'Other' }).id;
  assert.equal(store.get(otherTenant, art!.id), null);
});

test('list filters by status, type, workflow_run_id', () => {
  setup();
  store.commit({ tenant_id: tenantId, type: 'draft', status: 'draft', payload: {} });
  store.commit({ tenant_id: tenantId, type: 'draft', status: 'published', payload: {} });
  store.commit({ tenant_id: tenantId, type: 'report', status: 'draft', payload: {} });

  const drafts = store.list({ tenant_id: tenantId, status: 'draft' });
  assert.equal(drafts.length, 2);
  const reports = store.list({ tenant_id: tenantId, type: 'report' });
  assert.equal(reports.length, 1);
  const published = store.list({ tenant_id: tenantId, status: 'published' });
  assert.equal(published.length, 1);
});

test('listForAgentRun returns artifacts for a specific agent run', () => {
  setup();
  // agent_run_id has a FK to agent_runs — must insert rows with required NOT NULL columns
  const runId = 'agent_run_test_1';
  db.prepare('INSERT INTO agent_runs (id, tenant_id, agent_id, agent_version, playbook_id, status) VALUES (?, ?, ?, ?, ?, ?)').run(runId, tenantId, 'agent-1', 'v1', 'pb-1', 'running');
  store.commit({ tenant_id: tenantId, type: 'a', payload: {}, agent_run_id: runId });
  store.commit({ tenant_id: tenantId, type: 'b', payload: {}, agent_run_id: runId });
  const run1 = store.listForAgentRun(tenantId, runId);
  assert.equal(run1.length, 2);
});

test('review approve transitions status to approved', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  const result = store.review({
    tenant_id: tenantId,
    artifact_id: art!.id,
    decision: 'approve',
    actor_id: 'reviewer-1'
  });
  assert.equal(result.artifact!.status, 'approved');
  assert.equal(result.review.decision, 'approve');
  assert.equal(result.review.from_status, 'draft');
  assert.equal(result.review.to_status, 'approved');
});

test('review reject transitions status to rejected', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  const result = store.review({
    tenant_id: tenantId,
    artifact_id: art!.id,
    decision: 'reject',
    actor_id: 'reviewer-1'
  });
  assert.equal(result.artifact!.status, 'rejected');
});

test('review publish transitions status to published', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  const result = store.review({
    tenant_id: tenantId,
    artifact_id: art!.id,
    decision: 'publish'
  });
  assert.equal(result.artifact!.status, 'published');
});

test('review request_changes transitions status back to draft', () => {
  setup();
  // Start from 'pending_approval' (an allowed status), request_changes → 'draft'
  const art = store.commit({ tenant_id: tenantId, type: 'test', status: 'pending_approval', payload: {} });
  const result = store.review({
    tenant_id: tenantId,
    artifact_id: art!.id,
    decision: 'request_changes'
  });
  assert.equal(result.artifact!.status, 'draft');
});

test('review respects explicit to_status override', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  // to_status overrides the decision-derived status — must be a valid
  // status per the CHECK constraint (draft/pending_approval/approved/
  // published/archived/rejected).
  const result = store.review({
    tenant_id: tenantId,
    artifact_id: art!.id,
    decision: 'approve',
    to_status: 'archived'
  });
  assert.equal(result.artifact!.status, 'archived');
});

test('review archive transitions status to archived', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  const result = store.review({
    tenant_id: tenantId,
    artifact_id: art!.id,
    decision: 'archive'
  });
  assert.equal(result.artifact!.status, 'archived');
});

test('review throws on non-existent artifact', () => {
  setup();
  assert.throws(
    () => store.review({ tenant_id: tenantId, artifact_id: 'fake', decision: 'approve' }),
    /artifact not found/
  );
});

test('review throws on missing required fields', () => {
  setup();
  assert.throws(() => store.review({ tenant_id: '', artifact_id: 'x', decision: 'approve' }), /tenant_id/);
  assert.throws(() => store.review({ tenant_id: 't', artifact_id: '', decision: 'approve' }), /artifact_id/);
  assert.throws(() => store.review({ tenant_id: 't', artifact_id: 'x', decision: '' as never }), /decision/);
});

test('review records review_notes and metadata', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  const result = store.review({
    tenant_id: tenantId,
    artifact_id: art!.id,
    decision: 'approve',
    review_notes: 'Looks good',
    metadata: { score: 0.9 },
    actor_id: 'reviewer-2'
  });
  assert.equal(result.review.review_notes, 'Looks good');
  assert.deepEqual(result.review.metadata, { score: 0.9 });
  assert.equal(result.review.created_by, 'reviewer-2');
});

test('listReviews returns review history for an artifact', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  store.review({ tenant_id: tenantId, artifact_id: art!.id, decision: 'request_changes', actor_id: 'r1' });
  store.review({ tenant_id: tenantId, artifact_id: art!.id, decision: 'approve', actor_id: 'r2' });
  const reviews = store.listReviews(tenantId, art!.id);
  assert.equal(reviews.length, 2);
  // Both reviews should be present (order may be ambiguous due to
  // CURRENT_TIMESTAMP second-level precision in SQLite)
  const decisions = reviews.map((r) => r.decision).sort();
  assert.deepEqual(decisions, ['approve', 'request_changes']);
});

test('commit + review as new version (parent_artifact_id chain)', () => {
  setup();
  const v1 = store.commit({ tenant_id: tenantId, type: 'content_draft', payload: { v: 1 } });
  const v2 = store.commit({
    tenant_id: tenantId,
    type: 'content_draft',
    version: 2,
    parent_artifact_id: v1!.id,
    payload: { v: 2 }
  });
  assert.equal(v2!.parent_artifact_id, v1!.id);
  assert.equal(v2!.version, 2);
  // List by parent to find versions
  const versions = store.list({ tenant_id: tenantId, parent_artifact_id: v1!.id });
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, v2!.id);
});

test('review unsupported decision throws', () => {
  setup();
  const art = store.commit({ tenant_id: tenantId, type: 'test', payload: {} });
  assert.throws(
    () => store.review({ tenant_id: tenantId, artifact_id: art!.id, decision: 'unknown' as never }),
    /unsupported artifact review decision/
  );
});
