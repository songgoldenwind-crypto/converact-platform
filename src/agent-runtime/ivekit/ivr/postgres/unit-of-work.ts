import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type {
  IvrFlowUnitOfWork,
  IvrFlowUnitOfWorkContext,
  IvrSessionUnitOfWork,
  IvrSessionUnitOfWorkContext
} from '../ports.js';
import { PostgresIvrFlowStore } from './flow-store.js';
import {
  PostgresIvrPendingActionStore,
  PostgresIvrSessionStepStore,
  PostgresIvrSessionStore
} from './session-store.js';

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

export class PostgresIvrSessionUnitOfWork implements IvrSessionUnitOfWork {
  constructor(private readonly pg: PgQueryable) {}

  run<T>(
    tenantId: string,
    operation: (context: IvrSessionUnitOfWorkContext) => Promise<T>
  ): Promise<T> {
    return withPgTenant(this.pg, tenantId, (client) => operation({
      flows: new PostgresIvrFlowStore(client),
      sessions: new PostgresIvrSessionStore(client),
      steps: new PostgresIvrSessionStepStore(client),
      actions: new PostgresIvrPendingActionStore(client)
    }));
  }
}
