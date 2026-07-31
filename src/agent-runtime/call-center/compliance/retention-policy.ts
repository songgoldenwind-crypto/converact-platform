import { all, id, one, run } from '../../../db.js';
import { ComplianceAuditStore } from './audit-store.js';
import { redactPhone } from '../../voice/voice-store.js';

export interface TenantComplianceSettings {
  tenant_id: string;
  recording_retention_days: number;
  audit_log_retention_days: number;
  omni_retention_days: number;
  auto_purge_enabled: boolean;
  updated_at: string;
}

export function getComplianceSettings(db: unknown, tenantId: string): TenantComplianceSettings {
  const row = one(db, 'SELECT * FROM tenant_compliance_settings WHERE tenant_id = ?', [tenantId]);
  if (!row) {
    return {
      tenant_id: tenantId,
      recording_retention_days: 90,
      audit_log_retention_days: 365,
      omni_retention_days: 180,
      auto_purge_enabled: true,
      updated_at: new Date().toISOString()
    };
  }
  return {
    tenant_id: String((row as { tenant_id: string }).tenant_id),
    recording_retention_days: Number((row as { recording_retention_days: number }).recording_retention_days),
    audit_log_retention_days: Number((row as { audit_log_retention_days: number }).audit_log_retention_days),
    omni_retention_days: Number((row as { omni_retention_days: number }).omni_retention_days),
    auto_purge_enabled: Boolean((row as { auto_purge_enabled: number }).auto_purge_enabled),
    updated_at: String((row as { updated_at: string }).updated_at)
  };
}

export function upsertComplianceSettings(
  db: unknown,
  tenantId: string,
  patch: Partial<Omit<TenantComplianceSettings, 'tenant_id' | 'updated_at'>>
): TenantComplianceSettings {
  const existing = one(db, 'SELECT tenant_id FROM tenant_compliance_settings WHERE tenant_id = ?', [tenantId]);
  if (!existing) {
    run(
      db,
      `INSERT INTO tenant_compliance_settings
        (tenant_id, recording_retention_days, audit_log_retention_days, omni_retention_days, auto_purge_enabled)
       VALUES (?, ?, ?, ?, ?)`,
      [
        tenantId,
        patch.recording_retention_days ?? 90,
        patch.audit_log_retention_days ?? 365,
        patch.omni_retention_days ?? 180,
        patch.auto_purge_enabled === false ? 0 : 1
      ]
    );
  } else {
    const fields: string[] = [];
    const params: (string | number)[] = [];
    if (patch.recording_retention_days !== undefined) {
      fields.push('recording_retention_days = ?');
      params.push(patch.recording_retention_days);
    }
    if (patch.audit_log_retention_days !== undefined) {
      fields.push('audit_log_retention_days = ?');
      params.push(patch.audit_log_retention_days);
    }
    if (patch.omni_retention_days !== undefined) {
      fields.push('omni_retention_days = ?');
      params.push(patch.omni_retention_days);
    }
    if (patch.auto_purge_enabled !== undefined) {
      fields.push('auto_purge_enabled = ?');
      params.push(patch.auto_purge_enabled ? 1 : 0);
    }
    if (fields.length) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      params.push(tenantId);
      run(db, `UPDATE tenant_compliance_settings SET ${fields.join(', ')} WHERE tenant_id = ?`, params);
    }
  }
  return getComplianceSettings(db, tenantId);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function enforceRetentionPolicy(
  db: unknown,
  tenantId: string,
  actorId = 'system'
): {
  recordings_deleted: number;
  recording_cleanup_candidates: number;
  audit_logs_deleted: number;
  omni_messages_deleted: number;
  omni_conversations_deleted: number;
} {
  const settings = getComplianceSettings(db, tenantId);
  if (!settings.auto_purge_enabled) {
    return {
      recordings_deleted: 0,
      recording_cleanup_candidates: 0,
      audit_logs_deleted: 0,
      omni_messages_deleted: 0,
      omni_conversations_deleted: 0
    };
  }

  const auditCutoff = daysAgoIso(settings.audit_log_retention_days);
  const omniCutoff = daysAgoIso(settings.omni_retention_days);

  const recordingCandidates = one(
    db,
    `SELECT COUNT(*) AS count FROM call_recordings
     WHERE tenant_id = ?
       AND retention_until IS NOT NULL
       AND retention_until <= ?
       AND status IN ('completed', 'failed', 'stopped')`,
    [tenantId, new Date().toISOString()]
  );
  const auditStore = new ComplianceAuditStore(db);
  const auditDeleted = auditStore.purgeOlderThan(tenantId, auditCutoff);

  const msgResult = run(
    db,
    `DELETE FROM omni_messages WHERE tenant_id = ? AND datetime(created_at) < datetime(?)`,
    [tenantId, omniCutoff]
  );
  const convResult = run(
    db,
    `DELETE FROM omni_conversations WHERE tenant_id = ? AND status IN ('closed', 'resolved') AND datetime(updated_at) < datetime(?)`,
    [tenantId, omniCutoff]
  );

  const summary = {
    recordings_deleted: 0,
    recording_cleanup_candidates: Number(recordingCandidates?.count || 0),
    audit_logs_deleted: auditDeleted,
    omni_messages_deleted: Number(msgResult?.changes || 0),
    omni_conversations_deleted: Number(convResult?.changes || 0)
  };

  auditStore.record({
    tenant_id: tenantId,
    actor_id: actorId,
    action: 'compliance.retention_enforced',
    object_type: 'tenant',
    object_id: tenantId,
    metadata: summary
  });

  return summary;
}

export function purgeCustomerPii(
  db: unknown,
  tenantId: string,
  input: { phone?: string; email?: string; customer_id?: string },
  requestedBy: string,
  pg?: { query: <T = unknown>(text: string, values: unknown[]) => Promise<{ rows: T[] }> } | null
): {
  request_id: string;
  customer_key: string;
  deleted: Record<string, number>;
} {
  const customerKey = input.phone
    ? `phone:${input.phone}`
    : input.email
      ? `email:${input.email}`
      : input.customer_id
        ? `id:${input.customer_id}`
        : 'anonymous';

  const deleted: Record<string, number> = {};

  const journeyResult = run(
    db,
    `DELETE FROM customer_journey_events WHERE tenant_id = ? AND customer_key = ?`,
    [tenantId, customerKey]
  );
  deleted.journey_events = Number(journeyResult?.changes || 0);

  if (input.phone) {
    const redacted = redactPhone(input.phone);
    const sessions = run(
      db,
      `UPDATE voice_call_sessions SET phone_redacted = 'REDACTED', metadata = '{}' WHERE tenant_id = ? AND phone_redacted = ?`,
      [tenantId, redacted]
    );
    deleted.sessions_redacted = Number(sessions?.changes || 0);
  }

  let convIds: string[] = [];
  if (input.phone) {
    convIds = all(
      db,
      'SELECT id FROM omni_conversations WHERE tenant_id = ? AND customer_phone = ?',
      [tenantId, input.phone]
    ).map((r) => String((r as { id: string }).id));
  } else if (input.email) {
    convIds = all(
      db,
      'SELECT id FROM omni_conversations WHERE tenant_id = ? AND customer_email = ?',
      [tenantId, input.email]
    ).map((r) => String((r as { id: string }).id));
  }

  if (convIds.length) {
    for (const convId of convIds) {
      const msgDel = run(db, 'DELETE FROM omni_messages WHERE conversation_id = ?', [convId]);
      deleted.omni_messages = (deleted.omni_messages || 0) + Number(msgDel?.changes || 0);
      run(db, 'DELETE FROM omni_conversations WHERE id = ?', [convId]);
      deleted.omni_conversations = (deleted.omni_conversations || 0) + 1;
    }
  }

  // Clean compliance tables in Postgres (P1-10 fix).
  // These tables contain phone_number PII and were previously missed by GDPR purge.
  if (pg && input.phone) {
    purgeCompliancePiiAsync(pg, tenantId, input.phone).then((counts) => {
      Object.assign(deleted, counts);
    }).catch((error) => {
      console.warn('[gdpr] compliance table purge failed:', error);
    });
  }

  const requestId = id('gdpr');
  run(
    db,
    `INSERT INTO gdpr_deletion_requests (id, tenant_id, customer_key, requested_by, status, summary, completed_at)
     VALUES (?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP)`,
    [requestId, tenantId, customerKey, requestedBy, JSON.stringify(deleted)]
  );

  new ComplianceAuditStore(db).record({
    tenant_id: tenantId,
    actor_id: requestedBy,
    action: 'compliance.gdpr_purge',
    object_type: 'customer',
    object_id: customerKey,
    metadata: deleted
  });

  return { request_id: requestId, customer_key: customerKey, deleted };
}

/** Purge PII from Postgres-backed compliance tables (call_log, consent, dnc_list). */
async function purgeCompliancePiiAsync(
  pg: { query: <T = unknown>(text: string, values: unknown[]) => Promise<{ rows: T[] }> },
  tenantId: string,
  phoneNumber: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const callLogResult = await pg.query<{ count: number }>(
    `DELETE FROM compliance_call_log WHERE tenant_id = $1 AND phone_number = $2 RETURNING id`,
    [tenantId, phoneNumber]
  );
  counts.compliance_call_log = callLogResult.rows.length;

  const consentResult = await pg.query<{ count: number }>(
    `DELETE FROM compliance_consent WHERE tenant_id = $1 AND subject_id = $2 RETURNING id`,
    [tenantId, phoneNumber]
  );
  counts.compliance_consent = consentResult.rows.length;

  const dncResult = await pg.query<{ count: number }>(
    `DELETE FROM compliance_dnc_list WHERE tenant_id = $1 AND phone_number = $2 RETURNING id`,
    [tenantId, phoneNumber]
  );
  counts.compliance_dnc_list = dncResult.rows.length;

  return counts;
}
