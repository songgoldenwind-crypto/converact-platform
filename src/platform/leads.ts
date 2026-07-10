/**
 * Phase K Batch 102: platform lead + task list reads.
 */
import { all, type SqliteParams } from '../db.js';
import { ensureTenant, enrichLead } from './scoring.js';

export function listLeads(db: unknown, tenantId: string) {
  ensureTenant(db, tenantId);
  return all(
    db,
    `SELECT leads.*, contacts.name AS contact_name, contacts.email AS contact_email, contacts.phone AS contact_phone, contacts.platform_account AS platform_account
     FROM leads
     LEFT JOIN contacts ON contacts.id = leads.contact_id
     WHERE leads.tenant_id = ?
     ORDER BY leads.created_at DESC`,
    [tenantId]
  ).map(enrichLead);
}

export function listTasks(db: unknown, tenantId: string, status: string | null = null) {
  ensureTenant(db, tenantId);
  const params: SqliteParams = [tenantId];
  let sql = `SELECT * FROM tasks WHERE tenant_id = ?`;
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, due_at ASC, created_at DESC`;
  return all(db, sql, params);
}
