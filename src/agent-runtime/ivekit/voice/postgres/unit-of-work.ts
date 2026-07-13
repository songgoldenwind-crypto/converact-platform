import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type {
  VoiceConfigurationUnitOfWork,
  VoiceConfigurationUnitOfWorkContext,
  VoiceCallUnitOfWork,
  VoiceCallUnitOfWorkContext,
  VoiceProviderEventUnitOfWork,
  VoiceProviderEventUnitOfWorkContext
} from '../ports.js';
import { PostgresVoiceCallStore } from './call-store.js';
import { PostgresVoiceCommandStore } from './command-store.js';
import { PostgresVoiceConfigurationStore } from './configuration-store.js';
import { PostgresVoiceProviderEventStore } from './provider-event-store.js';
import { PostgresVoiceRecordingStore } from './recording-store.js';

export class PostgresVoiceConfigurationUnitOfWork implements VoiceConfigurationUnitOfWork {
  constructor(private readonly pg: PgQueryable) {}

  run<T>(
    tenantId: string,
    operation: (context: VoiceConfigurationUnitOfWorkContext) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (client) => operation({
      configuration: new PostgresVoiceConfigurationStore(client),
      commands: new PostgresVoiceCommandStore(client)
    }));
  }
}

export class PostgresVoiceCallUnitOfWork implements VoiceCallUnitOfWork {
  constructor(private readonly pg: PgQueryable) {}

  run<T>(
    tenantId: string,
    operation: (context: VoiceCallUnitOfWorkContext) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (client) => operation({
      calls: new PostgresVoiceCallStore(client),
      configuration: new PostgresVoiceConfigurationStore(client),
      commands: new PostgresVoiceCommandStore(client)
    }));
  }
}

export class PostgresVoiceProviderEventUnitOfWork implements VoiceProviderEventUnitOfWork {
  constructor(private readonly pg: PgQueryable) {}

  run<T>(
    tenantId: string,
    operation: (context: VoiceProviderEventUnitOfWorkContext) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (client) => operation({
      calls: new PostgresVoiceCallStore(client),
      configuration: new PostgresVoiceConfigurationStore(client),
      events: new PostgresVoiceProviderEventStore(client),
      recordings: new PostgresVoiceRecordingStore(client)
    }));
  }
}
