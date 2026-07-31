import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type {
  ContactCenterConfigurationRepository,
  ContactCenterConfigurationUnitOfWork
} from '../configuration-ports.js';
import { PostgresContactCenterConfigurationStore } from './configuration-store.js';

export class PostgresContactCenterConfigurationUnitOfWork implements ContactCenterConfigurationUnitOfWork {
  constructor(private readonly pg: PgQueryable) {}

  run<T>(
    tenantId: string,
    operation: (repository: ContactCenterConfigurationRepository) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (client) => operation(
      new PostgresContactCenterConfigurationStore(client)
    ));
  }
}
