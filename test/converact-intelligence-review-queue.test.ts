import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { CollaborationMessageStateStore } from '../src/agent-runtime/collaboration/message-state-store.js';
import { PolicyFindingStore } from '../src/agent-runtime/collaboration/policy-finding-store.js';
import { routeConveractFabricIntelligenceApi } from '../src/agent-runtime/converact/intelligence-http.js';

test('tenant finding queue is authorized, filtered, cursor-paged, and deletion aware', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'review-queue-jwt-secret-with-sufficient-length';
  const pg = new MemoryPg();
  const tenantId = 'tenant-review-queue';
  const otherTenantId = 'tenant-review-queue-other';
  try {
    const first = await createFinding(pg, tenantId, 'session-one', 'text', 'high', 'pending');
    const second = await createFinding(pg, tenantId, 'session-two', 'ocr', 'medium', 'confirmed');
    const deleted = await createFinding(pg, tenantId, 'session-deleted', 'ai', 'low', 'pending');
    await new CollaborationMessageStateStore(pg).deleteMessage({
      tenant_id: tenantId,
      session_id: deleted.sessionId,
      message_id: deleted.messageId,
      actor_identity: 'customer',
      reason: 'withdrawn'
    });
    await createFinding(pg, otherTenantId, 'other-session', 'asr', 'high', 'pending');

    const operator = token('reviewer', tenantId, 'operator');
    const deletedDetailPath = `/api/ivekit/intelligence/findings/${encodeURIComponent(deleted.findingId)}`;
    const deletedDetail = await routeConveractFabricIntelligenceApi(
      pg, 'GET', deletedDetailPath, new URL(`http://localhost${deletedDetailPath}`), {},
      { authorization: operator }
    ) as { status: number };
    assert.equal(deletedDetail.status, 404);
    const pageOne = await queue(pg, operator, '?limit=1');
    assert.equal(pageOne.items.length, 1);
    assert.ok(pageOne.next_cursor);
    assert.equal(pageOne.items[0]?.message_id === deleted.messageId, false);
    assert.equal(pageOne.items[0]?.evidence_refs.length, 20);
    assert.equal('matched_text' in pageOne.items[0], false);

    const pageTwo = await queue(pg, operator, `?limit=1&cursor=${encodeURIComponent(pageOne.next_cursor)}`);
    assert.equal(pageTwo.items.length, 1);
    assert.notEqual(pageTwo.items[0]?.id, pageOne.items[0]?.id);
    assert.equal(pageTwo.next_cursor, '');
    assert.deepEqual(
      new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id)),
      new Set([first.findingId, second.findingId])
    );

    assert.deepEqual(
      (await queue(pg, operator, '?source=ocr&severity=medium&review_status=confirmed')).items
        .map((item) => item.id),
      [second.findingId]
    );
    assert.deepEqual(
      (await queue(pg, operator, `?session_id=${encodeURIComponent(first.sessionId)}`)).items
        .map((item) => item.id),
      [first.findingId]
    );
    assert.equal(
      (await queue(pg, operator, `?created_from=${encodeURIComponent(first.createdAt)}`)).items.length >= 1,
      true
    );
    assert.equal(
      (await queue(pg, operator, `?created_to=${encodeURIComponent(second.createdAt)}`)).items.length >= 1,
      true
    );

    await assert.rejects(
      () => queue(pg, token('participant', tenantId, 'viewer'), ''),
      (error: unknown) => errorStatus(error) === 403
    );
    assert.equal((await queue(pg, token('admin', otherTenantId, 'admin'), '')).items.length, 1);
    assert.equal(
      (await queue(pg, token('admin', otherTenantId, 'admin'), '')).items[0]?.tenant_id,
      otherTenantId
    );
  } finally {
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
  }
});

test('tenant finding queue rejects invalid filters and cursors', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'review-queue-jwt-secret-with-sufficient-length';
  try {
    const pg = new MemoryPg();
    const authorization = token('admin', 'tenant-review-validation', 'admin');
    for (const query of [
      '?source=video',
      '?severity=critical',
      '?review_status=unknown',
      '?created_from=not-a-date',
      '?cursor=not-a-cursor',
      '?limit=501'
    ]) {
      await assert.rejects(
        () => queue(pg, authorization, query),
        (error: unknown) => errorStatus(error) === 400,
        query
      );
    }
  } finally {
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
  }
});

test('tenant reviewers can inspect and review queue findings without session membership', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  process.env.CONVERACT_JWT_SECRET = 'review-queue-jwt-secret-with-sufficient-length';
  try {
    const pg = new MemoryPg();
    const tenantId = 'tenant-review-workflow';
    const created = await createFinding(pg, tenantId, 'workflow', 'ai', 'high', 'pending');
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];
    const authorization = token('operator-1', tenantId, 'operator');
    const detailPath = `/api/ivekit/intelligence/findings/${encodeURIComponent(created.findingId)}`;
    const detail = await routeConveractFabricIntelligenceApi(
      pg, 'GET', detailPath, new URL(`http://localhost${detailPath}`), {}, { authorization }
    ) as { data: { finding: { id: string; review_status: string }; reviews: unknown[] } };
    assert.equal(detail.data.finding.id, created.findingId);
    assert.equal(detail.data.reviews.length, 0);

    const reviewPath = `${detailPath}/review`;
    const reviewed = await routeConveractFabricIntelligenceApi(
      pg,
      'POST',
      reviewPath,
      new URL(`http://localhost${reviewPath}`),
      { review_status: 'confirmed', note: 'Validated by operations' },
      { authorization },
      { publish: async (_publishedTenant, type, data) => { published.push({ type, data: data as Record<string, unknown> }); } }
    ) as {
      status: number;
      data: { finding: { review_status: string }; reviews: unknown[] };
      afterCommit(): Promise<void>;
    };
    await reviewed.afterCommit();
    assert.equal(reviewed.status, 201);
    assert.equal(reviewed.data.finding.review_status, 'confirmed');
    assert.equal(reviewed.data.reviews.length, 1);
    assert.equal(published[0]?.type, 'collaboration.policy.finding_reviewed');
    assert.equal(JSON.stringify(published[0]?.data).includes('Validated by operations'), false);

    await assert.rejects(
      () => routeConveractFabricIntelligenceApi(
        pg, 'GET', detailPath, new URL(`http://localhost${detailPath}`), {},
        { authorization: token('viewer-1', tenantId, 'viewer') }
      ),
      (error: unknown) => errorStatus(error) === 403
    );
    const crossTenant = await routeConveractFabricIntelligenceApi(
      pg, 'GET', detailPath, new URL(`http://localhost${detailPath}`), {},
      { authorization: token('admin-other', 'tenant-other', 'admin') }
    ) as { status: number };
    assert.equal(crossTenant.status, 404);
  } finally {
    if (previousSecret === undefined) delete process.env.CONVERACT_JWT_SECRET;
    else process.env.CONVERACT_JWT_SECRET = previousSecret;
  }
});

async function createFinding(
  pg: MemoryPg,
  tenantId: string,
  label: string,
  source: 'text' | 'ocr' | 'asr' | 'ai',
  severity: 'low' | 'medium' | 'high',
  reviewStatus: 'pending' | 'confirmed'
) {
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: `${label}-order` }
  });
  await store.addParticipant({
    tenant_id: tenantId,
    session_id: session.id,
    identity: 'customer',
    role: 'customer'
  });
  const message = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer',
    message_type: 'text',
    body: `${label} message`
  });
  const findings = new PolicyFindingStore(pg);
  let finding = await findings.recordFinding({
    tenant_id: tenantId,
    session_id: session.id,
    message_id: message.id,
    source,
    policy_type: `${label}-policy`,
    severity,
    matched_text_hash: label.padEnd(64, '0').slice(0, 64),
    evidence_refs: Array.from({ length: 30 }, (_, index) => ({
      type: 'message',
      id: `${message.id}-${index}`,
      raw: 'must-not-be-projected'
    }))
  });
  if (reviewStatus === 'confirmed') {
    finding = await findings.reviewFinding({
      tenant_id: tenantId,
      finding_id: finding.id,
      review_status: 'confirmed',
      reviewed_by: 'reviewer'
    });
  }
  return {
    sessionId: session.id,
    messageId: message.id,
    findingId: finding.id,
    createdAt: finding.created_at
  };
}

async function queue(pg: MemoryPg, authorization: string, query: string): Promise<{
  items: Array<{
    id: string;
    tenant_id: string;
    message_id: string;
    evidence_refs: Array<Record<string, unknown>>;
  }>;
  next_cursor: string;
}> {
  const path = `/api/ivekit/intelligence/findings${query}`;
  const response = await routeConveractFabricIntelligenceApi(
    pg,
    'GET',
    path,
    new URL(`http://localhost${path}`),
    {},
    { authorization }
  ) as { data: { items: Array<{
    id: string;
    tenant_id: string;
    message_id: string;
    evidence_refs: Array<Record<string, unknown>>;
  }>; next_cursor: string } };
  return response.data;
}

function token(userId: string, tenantId: string, role: 'operator' | 'viewer' | 'admin'): string {
  return `Bearer ${signAccessToken({ sub: userId, tid: tenantId, role })}`;
}

function errorStatus(error: unknown): number {
  return Number((error as { status?: unknown })?.status || 0);
}
