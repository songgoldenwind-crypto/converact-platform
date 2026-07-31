import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createDatabase, run } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { ComplianceAuditStore } from '../src/agent-runtime/call-center/compliance/audit-store.js';
import {
  enforceRetentionPolicy,
  getComplianceSettings,
  purgeCustomerPii,
  upsertComplianceSettings
} from '../src/agent-runtime/call-center/compliance/retention-policy.js';
import { routeComplianceApi } from '../src/agent-runtime/call-center/compliance/compliance-http.js';
import { recordJourneyEvent } from '../src/agent-runtime/call-center/omnichannel/omni-service.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';

const API_KEY = 'test-sprint11-key';

function authHeaders(tenantId: string) {
  return { 'X-API-Key': API_KEY, 'X-Tenant-Id': tenantId };
}

before(() => {
  useMemoryRedisForTests();
  process.env.OPC_API_KEY = API_KEY;
});

describe('Sprint 11 audit store', () => {
  it('records and lists audit logs', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Audit' });
    const store = new ComplianceAuditStore(db);
    const entry = store.record({
      tenant_id: tenant.id,
      actor_id: 'user_1',
      action: 'campaign.created',
      object_type: 'campaign',
      object_id: 'camp_1',
      metadata: { name: 'Test' }
    });
    assert.equal(entry.action, 'campaign.created');
    const rows = store.list(tenant.id, { action_prefix: 'campaign' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].object_id, 'camp_1');
  });
});

describe('Sprint 11 retention policy', () => {
  it('returns defaults and upserts settings', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Retain' });
    const defaults = getComplianceSettings(db, tenant.id);
    assert.equal(defaults.recording_retention_days, 90);
    assert.equal(defaults.auto_purge_enabled, true);

    const updated = upsertComplianceSettings(db, tenant.id, {
      recording_retention_days: 30,
      auto_purge_enabled: false
    });
    assert.equal(updated.recording_retention_days, 30);
    assert.equal(updated.auto_purge_enabled, false);
  });

  it('enforces retention and purges old audit logs', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Purge' });
    upsertComplianceSettings(db, tenant.id, {
      audit_log_retention_days: 7,
      auto_purge_enabled: true
    });
    run(
      db,
      `INSERT INTO audit_logs (id, tenant_id, actor_id, action, object_type, object_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['audit_old', tenant.id, 'sys', 'test.old', 'x', '1', '{}', '2020-01-01T00:00:00Z']
    );
    const store = new ComplianceAuditStore(db);
    store.record({
      tenant_id: tenant.id,
      actor_id: 'sys',
      action: 'test.recent',
      object_type: 'x',
      object_id: '2'
    });

    const result = enforceRetentionPolicy(db, tenant.id, 'admin');
    assert.ok(result.audit_logs_deleted >= 1);
    const remaining = store.list(tenant.id);
    assert.ok(remaining.every((r) => r.action !== 'test.old'));
  });
});

describe('Sprint 11 GDPR purge', () => {
  it('removes customer PII across journey and sessions', () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'GDPR' });
    const phone = '+8613800111222';
    recordJourneyEvent(db, {
      tenant_id: tenant.id,
      customer_key: `phone:${phone}`,
      event_type: 'message_inbound',
      channel: 'sms',
      summary: 'hi',
      ref_id: 'omni_1'
    });
    const voiceStore = new VoiceStore(db);
    voiceStore.createCallSession({
      tenant_id: tenant.id,
      direction: 'inbound',
      rustpbx_call_id: 'c-gdpr',
      phone,
      status: 'completed'
    });

    const result = purgeCustomerPii(db, tenant.id, { phone }, 'admin');
    assert.equal(result.customer_key, `phone:${phone}`);
    assert.ok(result.deleted.journey_events >= 1);
    assert.ok(result.deleted.sessions_redacted >= 1);
  });
});

describe('Sprint 11 compliance HTTP', () => {
  it('settings, activity, and gdpr endpoints', async () => {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'HTTP S11' });
    const headers = authHeaders(tenant.id);

    const settings = (await routeComplianceApi(
      db,
      null,
      'GET',
      '/api/compliance/settings',
      new URL('http://localhost/api/compliance/settings'),
      null,
      headers
    )) as { data: { recording_retention_days: number } };
    assert.equal(settings.data.recording_retention_days, 90);

    const updated = (await routeComplianceApi(
      db,
      null,
      'PUT',
      '/api/compliance/settings',
      new URL('http://localhost/api/compliance/settings'),
      { recording_retention_days: 60 },
      headers
    )) as { data: { recording_retention_days: number } };
    assert.equal(updated.data.recording_retention_days, 60);

    const activity = (await routeComplianceApi(
      db,
      null,
      'GET',
      '/api/compliance/activity',
      new URL('http://localhost/api/compliance/activity'),
      null,
      headers
    )) as { data: Array<{ type: string }> };
    assert.ok(activity.data.some((a) => a.type === 'compliance.settings_updated'));

    const purge = (await routeComplianceApi(
      db,
      null,
      'POST',
      '/api/compliance/gdpr/purge',
      new URL('http://localhost/api/compliance/gdpr/purge'),
      { phone: '+8613999888777', confirm: true },
      headers
    )) as { data: { request_id: string } };
    assert.ok(purge.data.request_id.startsWith('gdpr_'));
  });
});
