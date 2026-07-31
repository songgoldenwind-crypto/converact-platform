import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { VoiceError } from '../errors.js';
import type { VoiceParkingRepository } from '../ports.js';
import type { VoiceParkingSlot } from '../types.js';
import { boundedLimit, cursorTuple, pageFromRows } from './row-utils.js';

const SELECT = `SELECT parking.id, parking.tenant_id, parking.profile_id,
  parking.slot, parking.state, parking.parked_call_id, parking.park_command_id,
  parking.pickup_call_id, parking.pickup_command_id, parking.expires_at,
  parking.release_reason, parking.revision, parking.created_at,
  parking.updated_at, parking.released_at`;

export class PostgresVoiceParkingStore implements VoiceParkingRepository {
  constructor(private readonly pg: PgQueryable) {}

  list(input: {
    tenant_id: string;
    cursor?: string;
    limit: number;
    profile_id?: string;
    state?: VoiceParkingSlot['state'];
  }): Promise<{ items: VoiceParkingSlot[]; next_cursor: string | null }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const [cursorAt, cursorId] = cursorTuple(input.cursor);
      const result = await pg.query<Record<string, unknown>>(
        `${SELECT}
         FROM ivekit_voice_parking_slots parking
         WHERE parking.tenant_id = $1
           AND (parking.created_at, parking.id) < ($2::timestamptz, $3)
           AND ($4::text IS NULL OR parking.profile_id = $4)
           AND ($5::text IS NULL OR parking.state = $5)
         ORDER BY parking.created_at DESC, parking.id DESC
         LIMIT $6`,
        [input.tenant_id, cursorAt, cursorId, input.profile_id ?? null, input.state ?? null, limit + 1]
      );
      return pageFromRows(result.rows.map(decode), limit);
    });
  }

  async getBySlot(
    tenantId: string,
    profileId: string,
    slot: string,
    options: { for_update?: boolean; include_terminal?: boolean } = {}
  ): Promise<VoiceParkingSlot | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
      `${SELECT}
       FROM ivekit_voice_parking_slots parking
       WHERE parking.tenant_id = $1 AND parking.profile_id = $2 AND parking.slot = $3
         ${options.include_terminal ? '' : "AND parking.state IN ('parking', 'parked', 'retrieving')"}
       ORDER BY parking.created_at DESC, parking.id DESC
       LIMIT 1${options.for_update ? ' FOR UPDATE' : ''}`,
      [tenantId, profileId, slot]
      );
      return result.rows[0] ? decode(result.rows[0]) : null;
    });
  }

  async getByParkCommand(
    tenantId: string,
    commandId: string,
    options: { for_update?: boolean } = {}
  ): Promise<VoiceParkingSlot | null> {
    return this.#getByCommand('park_command_id', tenantId, commandId, options.for_update === true);
  }

  async getByPickupCommand(
    tenantId: string,
    commandId: string,
    options: { for_update?: boolean } = {}
  ): Promise<VoiceParkingSlot | null> {
    return this.#getByCommand('pickup_command_id', tenantId, commandId, options.for_update === true);
  }

  async insert(slot: VoiceParkingSlot): Promise<VoiceParkingSlot> {
    return withPgTenant(this.pg, slot.tenant_id, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
      `INSERT INTO ivekit_voice_parking_slots
        (id, tenant_id, profile_id, slot, state, parked_call_id, park_command_id,
         pickup_call_id, pickup_command_id, expires_at, release_reason, revision,
         created_at, updated_at, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz,
         $11, $12, $13::timestamptz, $14::timestamptz, $15::timestamptz)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      parameters(slot)
      );
      if (result.rows[0]) return decode(result.rows[0]);
      const replay = await this.#getByCommandWithPg(
        pg, 'park_command_id', slot.tenant_id, slot.park_command_id, false
      );
      if (replay) return replay;
      throw new VoiceError({
        code: 'revision_conflict', status: 409,
        details: { resource: 'voice_parking_slot', slot: slot.slot }
      });
    });
  }

  async update(slot: VoiceParkingSlot, expectedRevision: number): Promise<VoiceParkingSlot> {
    return withPgTenant(this.pg, slot.tenant_id, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
      `UPDATE ivekit_voice_parking_slots parking
       SET state = $3, pickup_call_id = $4, pickup_command_id = $5,
           expires_at = $6::timestamptz, release_reason = $7,
           revision = parking.revision + 1, updated_at = $8::timestamptz,
           released_at = $9::timestamptz
       WHERE parking.tenant_id = $1 AND parking.id = $2 AND parking.revision = $10
       RETURNING *`,
      [
        slot.tenant_id, slot.id, slot.state, slot.pickup_call_id,
        slot.pickup_command_id, slot.expires_at, slot.release_reason,
        slot.updated_at, slot.released_at, expectedRevision
      ]
      );
      if (!result.rows[0]) throw new VoiceError({ code: 'revision_conflict', status: 409 });
      return decode(result.rows[0]);
    });
  }

  async #getByCommand(
    column: 'park_command_id' | 'pickup_command_id',
    tenantId: string,
    commandId: string,
    forUpdate: boolean
  ): Promise<VoiceParkingSlot | null> {
    return withPgTenant(this.pg, tenantId, (pg) => this.#getByCommandWithPg(
      pg, column, tenantId, commandId, forUpdate
    ));
  }

  async #getByCommandWithPg(
    pg: PgQueryable,
    column: 'park_command_id' | 'pickup_command_id',
    tenantId: string,
    commandId: string,
    forUpdate: boolean
  ): Promise<VoiceParkingSlot | null> {
    const result = await pg.query<Record<string, unknown>>(
      `${SELECT}
       FROM ivekit_voice_parking_slots parking
       WHERE parking.tenant_id = $1 AND parking.${column} = $2
       LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, commandId]
    );
    return result.rows[0] ? decode(result.rows[0]) : null;
  }
}

function parameters(slot: VoiceParkingSlot): unknown[] {
  return [
    slot.id, slot.tenant_id, slot.profile_id, slot.slot, slot.state,
    slot.parked_call_id, slot.park_command_id, slot.pickup_call_id,
    slot.pickup_command_id, slot.expires_at, slot.release_reason, slot.revision,
    slot.created_at, slot.updated_at, slot.released_at
  ];
}

function decode(row: Record<string, unknown>): VoiceParkingSlot {
  return {
    id: text(row.id), tenant_id: text(row.tenant_id), profile_id: text(row.profile_id),
    slot: text(row.slot), state: row.state as VoiceParkingSlot['state'],
    parked_call_id: text(row.parked_call_id), park_command_id: text(row.park_command_id),
    pickup_call_id: nullable(row.pickup_call_id),
    pickup_command_id: nullable(row.pickup_command_id),
    expires_at: timestamp(row.expires_at), release_reason: text(row.release_reason),
    revision: number(row.revision), created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at), released_at: nullableTimestamp(row.released_at)
  };
}

function text(value: unknown): string {
  return String(value ?? '');
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
  return date.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : timestamp(value);
}

function number(value: unknown): number {
  const output = Number(value);
  if (!Number.isSafeInteger(output) || output < 1) {
    throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
  }
  return output;
}
