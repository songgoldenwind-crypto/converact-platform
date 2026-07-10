import { all } from '../../../db.js';
import { decodeEgressRecord } from '../../livekit/recording-service.js';
import type { EgressRecord } from '../egress-manager.js';

export interface RecordingSearchFilters {
  tenant_id: string;
  q?: string;
  call_session_id?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export function searchRecordings(db: unknown, filters: RecordingSearchFilters): EgressRecord[] {
  const conditions = ['tenant_id = ?'];
  const params: (string | number)[] = [filters.tenant_id];

  if (filters.call_session_id) {
    conditions.push('call_session_id = ?');
    params.push(filters.call_session_id);
  }
  if (filters.date_from) {
    conditions.push('created_at >= ?');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push('created_at <= ?');
    params.push(filters.date_to);
  }
  if (filters.q) {
    conditions.push('(storage_url LIKE ? ESCAPE ? OR call_session_id LIKE ? ESCAPE ? OR egress_id LIKE ? ESCAPE ?)');
    // Escape LIKE special characters (% and _) to prevent pattern injection.
    const escaped = String(filters.q).replace(/[%_\\]/g, '\\$&');
    const like = `%${escaped}%`;
    const escape = '\\';
    params.push(like, escape, like, escape, like, escape);
  }

  const limit = filters.limit || 50;
  const offset = filters.offset || 0;
  const sql = `SELECT * FROM call_recordings WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return all(db, sql, params).map((row) => decodeRecordingRow(row as Record<string, unknown>));
}

function decodeRecordingRow(row: Record<string, unknown>): EgressRecord {
  return decodeEgressRecord(row);
}
