import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { VoiceError } from '../errors.js';
import type {
  VoiceCommandCompletionInput,
  VoiceCommandReleaseInput,
  VoiceCommandRepository,
  VoiceQueueClaimInput
} from '../ports.js';
import type { VoiceCallCommand, VoiceConfigurationCommand } from '../types.js';
import {
  boundedLimit,
  jsonRecord,
  nullableTimestamp,
  numberValue,
  requiredRow,
  timestamp,
  type VoicePgRow
} from './row-utils.js';

type Command = VoiceCallCommand | VoiceConfigurationCommand;
type CommandTable = 'ivekit_voice_call_commands' | 'ivekit_voice_configuration_commands';

export class PostgresVoiceCommandStore implements VoiceCommandRepository {
  constructor(private readonly pg: PgQueryable) {}

  findCallByIdempotencyKey(tenantId: string, key: string): Promise<VoiceCallCommand | null> {
    return this.findByIdempotencyKey('ivekit_voice_call_commands', tenantId, key, decodeCallCommand);
  }

  insertCall(command: VoiceCallCommand): Promise<VoiceCallCommand> {
    return withPgTenant(this.pg, command.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_call_commands
          (id, tenant_id, call_id, kind, state, idempotency_key, payload_hash, payload,
           attempt_count, max_attempts, next_attempt_at, lease_until, worker_id,
           provider_command_id, result, error_code, error_message, created_at,
           updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
                 $13, $14, $15::jsonb, $16, $17, $18, $19, $20)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        callCommandParams(command)
      );
      if (result.rows[0]) return decodeCallCommand(result.rows[0]);
      const replay = await pg.query<VoicePgRow>(
        `SELECT command.* FROM ivekit_voice_call_commands command
         WHERE command.tenant_id = $1 AND command.idempotency_key = $2`,
        [command.tenant_id, command.idempotency_key]
      );
      return requiredCommandReplay(
        replay.rows[0] ? decodeCallCommand(replay.rows[0]) : null,
        command.payload_hash
      );
    });
  }

  claimCallDue(input: VoiceQueueClaimInput): Promise<VoiceCallCommand[]> {
    return this.claimDue('ivekit_voice_call_commands', input, decodeCallCommand, false);
  }

  claimCallUncertain(input: VoiceQueueClaimInput): Promise<VoiceCallCommand[]> {
    return this.claimDue('ivekit_voice_call_commands', input, decodeCallCommand, true);
  }

  completeCall(input: VoiceCommandCompletionInput): Promise<VoiceCallCommand> {
    return this.complete('ivekit_voice_call_commands', input, decodeCallCommand);
  }

  releaseCall(input: VoiceCommandReleaseInput): Promise<VoiceCallCommand> {
    return this.release('ivekit_voice_call_commands', input, decodeCallCommand);
  }

  findConfigurationByIdempotencyKey(tenantId: string, key: string): Promise<VoiceConfigurationCommand | null> {
    return this.findByIdempotencyKey('ivekit_voice_configuration_commands', tenantId, key, decodeConfigurationCommand);
  }

  insertConfiguration(command: VoiceConfigurationCommand): Promise<VoiceConfigurationCommand> {
    return withPgTenant(this.pg, command.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_configuration_commands
          (id, tenant_id, profile_id, resource_type, resource_id, operation, state,
           idempotency_key, payload_hash, payload, attempt_count, max_attempts,
           next_attempt_at, lease_until, worker_id, provider_command_id, result,
           error_code, error_message, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
                 $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        configurationCommandParams(command)
      );
      if (result.rows[0]) return decodeConfigurationCommand(result.rows[0]);
      const replay = await pg.query<VoicePgRow>(
        `SELECT command.* FROM ivekit_voice_configuration_commands command
         WHERE command.tenant_id = $1 AND command.idempotency_key = $2`,
        [command.tenant_id, command.idempotency_key]
      );
      return requiredCommandReplay(
        replay.rows[0] ? decodeConfigurationCommand(replay.rows[0]) : null,
        command.payload_hash
      );
    });
  }

  claimConfigurationDue(input: VoiceQueueClaimInput): Promise<VoiceConfigurationCommand[]> {
    return this.claimDue('ivekit_voice_configuration_commands', input, decodeConfigurationCommand, false);
  }

  claimConfigurationUncertain(input: VoiceQueueClaimInput): Promise<VoiceConfigurationCommand[]> {
    return this.claimDue('ivekit_voice_configuration_commands', input, decodeConfigurationCommand, true);
  }

  completeConfiguration(input: VoiceCommandCompletionInput): Promise<VoiceConfigurationCommand> {
    return this.complete('ivekit_voice_configuration_commands', input, decodeConfigurationCommand);
  }

  releaseConfiguration(input: VoiceCommandReleaseInput): Promise<VoiceConfigurationCommand> {
    return this.release('ivekit_voice_configuration_commands', input, decodeConfigurationCommand);
  }

  private findByIdempotencyKey<T extends Command>(
    table: CommandTable,
    tenantId: string,
    key: string,
    decode: (row: VoicePgRow) => T
  ): Promise<T | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT command.* FROM ${table} command
         WHERE command.tenant_id = $1 AND command.idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decode(result.rows[0]) : null;
    });
  }

  private claimDue<T extends Command>(
    table: CommandTable,
    input: VoiceQueueClaimInput,
    decode: (row: VoicePgRow) => T,
    uncertain: boolean
  ): Promise<T[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const now = input.now.toISOString();
      const leaseUntil = new Date(input.now.getTime() + boundedLease(input.lease_ms)).toISOString();
      const predicate = uncertain
        ? `command.state = 'uncertain' AND (command.next_attempt_at IS NULL OR command.next_attempt_at <= $2)`
        : `(
             command.state = 'pending'
             OR (command.state = 'retry_wait' AND (command.next_attempt_at IS NULL OR command.next_attempt_at <= $2))
             OR (command.state = 'processing' AND command.lease_until <= $2)
           ) AND command.attempt_count < command.max_attempts`;
      const result = await pg.query<VoicePgRow>(
        `WITH candidate AS (
           SELECT command.id
           FROM ${table} command
           WHERE command.tenant_id = $1 AND ${predicate}
           ORDER BY COALESCE(command.next_attempt_at, command.created_at), command.id
           FOR UPDATE SKIP LOCKED
           LIMIT $5
         )
         UPDATE ${table} command
         SET state = 'processing', worker_id = $3, lease_until = $4,
             attempt_count = CASE WHEN command.state = 'uncertain'
               THEN command.attempt_count ELSE command.attempt_count + 1 END,
             updated_at = $2
         FROM candidate
         WHERE command.tenant_id = $1 AND command.id = candidate.id
         RETURNING command.*`,
        [input.tenant_id, now, input.worker_id, leaseUntil, limit]
      );
      return result.rows.map(decode);
    });
  }

  private complete<T extends Command>(
    table: CommandTable,
    input: VoiceCommandCompletionInput,
    decode: (row: VoicePgRow) => T
  ): Promise<T> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ${table}
         SET state = $4, provider_command_id = $5, result = $6::jsonb,
             error_code = $7, error_message = $8, worker_id = '', lease_until = NULL,
             next_attempt_at = NULL, completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
         RETURNING *`,
        [
          input.tenant_id, input.command_id, input.worker_id, input.state,
          input.provider_command_id ?? '', JSON.stringify(input.result ?? {}),
          input.error_code ?? '', input.error_message ?? ''
        ]
      );
      if (!result.rows[0]) throw new VoiceError({ code: 'lease_lost', status: 409 });
      return decode(result.rows[0]);
    });
  }

  private release<T extends Command>(
    table: CommandTable,
    input: VoiceCommandReleaseInput,
    decode: (row: VoicePgRow) => T
  ): Promise<T> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ${table}
         SET state = $4, next_attempt_at = $5, provider_command_id = $6,
             error_code = $7, error_message = $8, worker_id = '', lease_until = NULL,
             completed_at = CASE WHEN $4 = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND id = $2 AND worker_id = $3
         RETURNING *`,
        [
          input.tenant_id, input.command_id, input.worker_id, input.state,
          input.next_attempt_at?.toISOString() ?? null, input.provider_command_id ?? '',
          input.error_code, input.error_message ?? ''
        ]
      );
      if (!result.rows[0]) throw new VoiceError({ code: 'lease_lost', status: 409 });
      return decode(result.rows[0]);
    });
  }
}

function callCommandParams(command: VoiceCallCommand): unknown[] {
  return [
    command.id, command.tenant_id, command.call_id, command.kind, command.state,
    command.idempotency_key, command.payload_hash, JSON.stringify(command.payload),
    command.attempt_count, command.max_attempts, command.next_attempt_at, command.lease_until,
    command.worker_id, command.provider_command_id, JSON.stringify(command.result),
    command.error_code, command.error_message, command.created_at, command.updated_at,
    command.completed_at
  ];
}

function configurationCommandParams(command: VoiceConfigurationCommand): unknown[] {
  return [
    command.id, command.tenant_id, command.profile_id, command.resource_type,
    command.resource_id, command.operation, command.state, command.idempotency_key,
    command.payload_hash, JSON.stringify(command.payload), command.attempt_count,
    command.max_attempts, command.next_attempt_at, command.lease_until, command.worker_id,
    command.provider_command_id, JSON.stringify(command.result), command.error_code,
    command.error_message, command.created_at, command.updated_at, command.completed_at
  ];
}

function decodeCallCommand(row: VoicePgRow): VoiceCallCommand {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), call_id: String(row.call_id),
    kind: row.kind as VoiceCallCommand['kind'], state: row.state as VoiceCallCommand['state'],
    idempotency_key: String(row.idempotency_key), payload_hash: String(row.payload_hash),
    payload: jsonRecord(row.payload), attempt_count: numberValue(row.attempt_count),
    max_attempts: numberValue(row.max_attempts), next_attempt_at: nullableTimestamp(row.next_attempt_at),
    lease_until: nullableTimestamp(row.lease_until), worker_id: String(row.worker_id ?? ''),
    provider_command_id: String(row.provider_command_id ?? ''), result: jsonRecord(row.result),
    error_code: String(row.error_code ?? ''), error_message: String(row.error_message ?? ''),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function decodeConfigurationCommand(row: VoicePgRow): VoiceConfigurationCommand {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), profile_id: String(row.profile_id),
    resource_type: row.resource_type as VoiceConfigurationCommand['resource_type'],
    resource_id: String(row.resource_id), operation: row.operation as VoiceConfigurationCommand['operation'],
    state: row.state as VoiceConfigurationCommand['state'], idempotency_key: String(row.idempotency_key),
    payload_hash: String(row.payload_hash), payload: jsonRecord(row.payload),
    attempt_count: numberValue(row.attempt_count), max_attempts: numberValue(row.max_attempts),
    next_attempt_at: nullableTimestamp(row.next_attempt_at), lease_until: nullableTimestamp(row.lease_until),
    worker_id: String(row.worker_id ?? ''), provider_command_id: String(row.provider_command_id ?? ''),
    result: jsonRecord(row.result), error_code: String(row.error_code ?? ''), error_message: String(row.error_message ?? ''),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at), completed_at: nullableTimestamp(row.completed_at)
  };
}

function requiredCommandReplay<T extends Command>(command: T | null, payloadHash: string): T {
  const found = requiredRow(command ?? undefined, 'idempotency_conflict');
  if (found.payload_hash !== payloadHash) {
    return requiredRow(undefined, 'idempotency_conflict');
  }
  return found;
}

function boundedLease(value: number): number {
  return Number.isInteger(value) ? Math.min(15 * 60_000, Math.max(1_000, value)) : 30_000;
}
