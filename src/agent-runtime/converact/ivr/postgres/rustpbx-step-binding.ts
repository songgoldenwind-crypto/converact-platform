import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { IvrError } from '../errors.js';
import type {
  RustPbxStepIvrBinding,
  RustPbxStepIvrBindingResolver
} from '../rustpbx-step-service.js';

export class PostgresRustPbxStepIvrBindingResolver implements RustPbxStepIvrBindingResolver {
  constructor(private readonly pg: PgQueryable) {}

  resolve(input: {
    tenant_id: string;
    profile_id: string;
    provider_session_id: string;
    safe_metadata: Record<string, unknown>;
  }): Promise<RustPbxStepIvrBinding | null> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT call.id, call.metadata
         FROM ivekit_voice_calls call
         WHERE call.tenant_id = $1 AND call.provider_profile_id = $2
           AND call.provider_call_id = $3
           AND call.state NOT IN ('completed', 'cancelled', 'missed', 'rejected', 'failed', 'timed_out')
         LIMIT 1`,
        [input.tenant_id, input.profile_id, input.provider_session_id]
      );
      const row = result.rows[0];
      if (!row) return null;
      const metadata = record(row.metadata);
      if (metadata._ivekit_ivr === undefined) return null;
      const binding = record(metadata._ivekit_ivr);
      const variables = binding.variables === undefined ? {} : record(binding.variables);
      if (jsonBytes(variables) > 65_536) throw validationError();
      return {
        call_id: identifier(row.id),
        flow_id: identifier(binding.flow_id),
        flow_version: optionalVersion(binding.flow_version),
        variables: structuredClone(variables),
        trace_id: optionalIdentifier(binding.trace_id)
      };
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) {
    throw validationError();
  }
  return value;
}

function optionalIdentifier(value: unknown): string | undefined {
  return value === undefined || value === '' ? undefined : identifier(value);
}

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw validationError();
  }
  return Number(value);
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { throw validationError(); }
}

function validationError(): IvrError {
  return new IvrError({ code: 'validation_failed', status: 422 });
}
