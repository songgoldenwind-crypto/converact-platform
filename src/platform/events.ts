/**
 * Phase K Batch 102: platform event tracking.
 */
import { id, json, run } from '../db.js';

export function trackEvent(
  db: unknown,
  tenantId: string,
  eventName: string,
  objectType = '',
  objectId = '',
  sourceTagId: string | null = null,
  properties: Record<string, unknown> = {}
) {
  run(
    db,
    `INSERT INTO events (id, tenant_id, event_name, object_type, object_id, source_tag_id, properties)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id('evt'), tenantId, eventName, objectType, objectId, sourceTagId, json(properties)]
  );
}
