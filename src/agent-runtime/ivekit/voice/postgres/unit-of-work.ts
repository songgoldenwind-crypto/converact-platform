import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type {
  VoiceConfigurationUnitOfWork,
  VoiceConfigurationUnitOfWorkContext
} from '../ports.js';
import { PostgresVoiceCommandStore } from './command-store.js';
import { PostgresVoiceConfigurationStore } from './configuration-store.js';

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
