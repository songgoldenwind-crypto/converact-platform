import { id, json, run } from '../../db.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

export interface RuntimeEvent {
  id: string;
  tenant_id: string;
  event_name: string;
  object_type: string;
  object_id: string;
  source_tag_id: string | null;
  properties: JsonRecord;
}

export type EventHandler = (event: RuntimeEvent) => void | Promise<void>;

export class EventBus {
  db: unknown;
  runStore: AuditStoreLike | null;
  handlers: Map<string, EventHandler[]>;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
    this.handlers = new Map();
  }

  on(eventName: string, handler: EventHandler): void {
    const handlers = this.handlers.get(eventName) || [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  async emit(input: JsonRecord): Promise<RuntimeEvent> {
    const event = {
      id: id('evt'),
      tenant_id: input.tenant_id,
      event_name: input.event_name,
      object_type: input.object_type || '',
      object_id: input.object_id || '',
      source_tag_id: input.source_tag_id || null,
      properties: input.properties || {}
    };
    run(
      this.db,
      `INSERT INTO events (id, tenant_id, event_name, object_type, object_id, source_tag_id, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.tenant_id,
        event.event_name,
        event.object_type,
        event.object_id,
        event.source_tag_id,
        json(event.properties)
      ]
    );
    this.runStore?.audit(event.tenant_id, 'event.emit', 'event', event.id, {
      event_name: event.event_name,
      object_type: event.object_type,
      object_id: event.object_id
    });
    for (const handler of this.handlers.get(event.event_name) || []) {
      await handler(event);
    }
    return event;
  }
}
