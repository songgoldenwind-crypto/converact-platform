import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type { ContactCenterUnitOfWork, ContactCenterUnitOfWorkContext } from '../ports.js';
import { PostgresContactCenterRepository } from './store.js';

export class PostgresContactCenterUnitOfWork implements ContactCenterUnitOfWork {
  constructor(private readonly pg: PgQueryable) {}

  run<T>(
    tenantId: string,
    operation: (context: ContactCenterUnitOfWorkContext) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (client) => operation({
      repository: new PostgresContactCenterRepository(client)
    }));
  }
}
