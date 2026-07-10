import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { RbacStore, deriveToolPermissions } from '../src/agent-runtime/security/rbac-store.js';
import type { ToolDefinition, ToolExecutionContext } from '../src/agent-runtime/runtime-domain-types.js';

/** Build a minimal ToolDefinition for permission derivation tests. */
function tool(overrides: Partial<ToolDefinition> & { category?: string } = {}): ToolDefinition {
  const { category = 'read', ...rest } = overrides;
  return {
    tool_id: 'test.tool',
    display_name: 'Test Tool',
    toolset: 'test',
    category: category as ToolDefinition['category'],
    risk_level: 'R1',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: [],
    tenant_scope_required: true,
    audit_event_name: 'test.tool.called',
    ...rest
  };
}

/** Build a ToolExecutionContext. */
function ctx(tenantId: string, userId: string, role = 'operator'): ToolExecutionContext {
  return { tenantId, userId, role, agentId: userId, workspaceId: 'default' };
}

test('deriveToolPermissions maps category/risk to permission strings', () => {
  assert.deepEqual(deriveToolPermissions(tool({ category: 'read' })), ['test:read']);
  assert.deepEqual(deriveToolPermissions(tool({ category: 'internal_write' })), ['test:write']);
  assert.deepEqual(deriveToolPermissions(tool({ category: 'external_action' })), ['test:external']);
  assert.deepEqual(deriveToolPermissions(tool({ category: 'admin_action' })), ['admin:manage']);
  assert.deepEqual(deriveToolPermissions(tool({ category: 'financial_action' })), ['billing:manage']);
  // required_scopes overrides everything
  assert.deepEqual(deriveToolPermissions(tool({ required_scopes: ['custom:perm'] })), ['custom:perm']);
});

test('RbacStore system actor is always allowed', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'T' });
  const decision = store.evaluateToolAccess(
    ctx(tenant.id, 'system', 'system'),
    tool({ category: 'internal_write' })
  );
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.metadata.role_code, 'system');
});

test('RbacStore bootstrap tenant (no members) allows all', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Bootstrap' });
  // No member seeded — bootstrap mode
  const decision = store.evaluateToolAccess(
    ctx(tenant.id, 'user-1', 'operator'),
    tool({ category: 'internal_write' })
  );
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.metadata.role_code, 'bootstrap');
});

test('RbacStore owner wildcard (*) matches any permission', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Owner' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'owner-1', role_code: 'owner' });
  // owner has '*' — should allow write, external, admin, anything
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'owner-1'), tool({ category: 'internal_write' })).decision,
    'allow'
  );
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'owner-1'), tool({ category: 'external_action' })).decision,
    'allow'
  );
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'owner-1'), tool({ category: 'admin_action' })).decision,
    'allow'
  );
});

test('RbacStore admin *:read matches any :read permission', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Admin' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'admin-1', role_code: 'admin' });
  // admin has *:read — should allow any toolset:read
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'admin-1'), tool({ toolset: 'voice', category: 'read' })).decision,
    'allow'
  );
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'admin-1'), tool({ toolset: 'geo', category: 'read' })).decision,
    'allow'
  );
  // admin does NOT have arbitrary :write (only *:read, *:write, *:external, admin:manage, billing:manage)
  // Actually admin DOES have *:write — let's verify it allows write too
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'admin-1'), tool({ toolset: 'voice', category: 'internal_write' })).decision,
    'allow'
  );
});

test('RbacStore operator denied on missing permission', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Op' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'op-1', role_code: 'operator' });
  // operator has analytics:write but NOT admin:manage
  const decision = store.evaluateToolAccess(
    ctx(tenant.id, 'op-1'),
    tool({ toolset: 'admin', category: 'admin_action' })
  );
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.reason.includes('missing permission'));
});

test('RbacStore operator allowed on explicitly granted permission', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Op2' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'op-2', role_code: 'operator' });
  // operator has analytics:write
  const decision = store.evaluateToolAccess(
    ctx(tenant.id, 'op-2'),
    tool({ toolset: 'analytics', category: 'internal_write' })
  );
  assert.equal(decision.decision, 'allow');
});

test('RbacStore inactive member is denied', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Inactive' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'suspended-1', role_code: 'owner', status: 'suspended' });
  const decision = store.evaluateToolAccess(
    ctx(tenant.id, 'suspended-1'),
    tool({ category: 'read' })
  );
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.reason.includes('not an active tenant member'));
});

test('RbacStore missing tenantId is denied', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const decision = store.evaluateToolAccess(
    ctx('', 'user-1'),
    tool({ category: 'read' })
  );
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reason, 'tenant context is required');
});

test('RbacStore assertToolAccess throws on deny', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Throw' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'op-1', role_code: 'operator' });
  assert.throws(
    () => store.assertToolAccess(
      ctx(tenant.id, 'op-1'),
      tool({ toolset: 'admin', category: 'admin_action' })
    ),
    /missing permission/
  );
});

test('RbacStore viewer *:read matches read but not write', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Viewer' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'viewer-1', role_code: 'viewer' });
  // viewer has *:read — allows any read
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'viewer-1'), tool({ toolset: 'voice', category: 'read' })).decision,
    'allow'
  );
  // viewer does NOT have :write — denied
  assert.equal(
    store.evaluateToolAccess(ctx(tenant.id, 'viewer-1'), tool({ toolset: 'voice', category: 'internal_write' })).decision,
    'deny'
  );
});

test('RbacStore records policy decisions for audit', () => {
  const db = createDatabase(':memory:');
  const store = new RbacStore(db);
  const tenant = createTenant(db, { name: 'Audit' });
  store.upsertMember({ tenant_id: tenant.id, user_id: 'op-1', role_code: 'operator' });
  // Trigger an allow decision (recorded)
  store.assertToolAccess(
    ctx(tenant.id, 'op-1'),
    tool({ toolset: 'analytics', category: 'internal_write' })
  );
  // Trigger a deny decision (recorded)
  assert.throws(() =>
    store.assertToolAccess(
      ctx(tenant.id, 'op-1'),
      tool({ toolset: 'admin', category: 'admin_action' })
    )
  );
  const decisions = store.listPolicyDecisions({ tenant_id: tenant.id });
  assert.equal(decisions.length, 2);
  assert.ok(decisions.some((d) => d.decision === 'allow'));
  assert.ok(decisions.some((d) => d.decision === 'deny'));
});
