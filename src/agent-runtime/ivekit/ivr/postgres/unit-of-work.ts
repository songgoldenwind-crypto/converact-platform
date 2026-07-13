import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type { IvrFlowUnitOfWork, IvrFlowUnitOfWorkContext } from '../ports.js';
import { PostgresIvrFlowStore } from './flow-store.js';

export class PostgresIvrFlowUnitOfWork implements IvrFlowUnitOfWork {
  constructor(private readonly pg: PgQueryable) {}

  run<T>(
    tenantId: string,
    operation: (context: IvrFlowUnitOfWorkContext) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (client) => operation({
      flows: new PostgresIvrFlowStore(client)
    }));
  }
}
