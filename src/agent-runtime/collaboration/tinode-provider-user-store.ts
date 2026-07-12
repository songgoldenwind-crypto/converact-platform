import type { PgQueryable } from '../../db-pg.js';
import { pgId } from '../../db-pg.js';

export interface TinodeProviderUser {
  id: string;
  tenant_id: string;
  session_id: string;
  binding_id: string;
  provider_user_id: string;
  identity: string;
  status: 'active' | 'revoked';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class TinodeProviderUserStore {
  constructor(private readonly pg: PgQueryable) {}

  async upsert(input: {
    tenant_id: string;
    session_id: string;
    binding_id: string;
    provider_user_id: string;
    identity: string;
    metadata?: Record<string, unknown>;
  }): Promise<TinodeProviderUser> {
    const providerUserId = required(input.provider_user_id, 'provider_user_id');
    const identity = required(input.identity, 'identity');
    const binding = await this.pg.query(
      `SELECT * FROM collaboration_chat_bindings
       WHERE id = $1 AND tenant_id = $2 AND session_id = $3 AND provider = 'tinode'`,
      [input.binding_id, input.tenant_id, input.session_id]
    );
    if (!binding.rows[0]) throw storeError('Tinode chat binding not found', 404);
    const participant = await this.pg.query(
      `SELECT id FROM collaboration_participants
       WHERE tenant_id = $1 AND session_id = $2 AND identity = $3 AND left_at IS NULL
       LIMIT 1`,
      [input.tenant_id, input.session_id, identity]
    );
    if (!participant.rows[0]) throw storeError('active collaboration participant not found', 404);

    const conflicting = await this.pg.query(
      `SELECT * FROM collaboration_provider_users
       WHERE tenant_id = $1 AND session_id = $2 AND provider = 'tinode'
         AND provider_user_id = $3 AND status = 'active'
       LIMIT 1`,
      [input.tenant_id, input.session_id, providerUserId]
    );
    if (conflicting.rows[0] && String(conflicting.rows[0].identity) !== identity) {
      throw storeError('Tinode provider user is already mapped to another identity', 409);
    }

    try {
      const result = await this.pg.query(
        `INSERT INTO collaboration_provider_users
          (id, tenant_id, session_id, binding_id, provider, provider_user_id, identity, status, metadata)
         VALUES ($1, $2, $3, $4, 'tinode', $5, $6, 'active', $7)
         ON CONFLICT (tenant_id, session_id, provider, identity)
         DO UPDATE SET binding_id = EXCLUDED.binding_id,
                       provider_user_id = EXCLUDED.provider_user_id,
                       status = 'active',
                       metadata = EXCLUDED.metadata,
                       updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [
          pgId('cpuser'),
          input.tenant_id,
          input.session_id,
          input.binding_id,
          providerUserId,
          identity,
          JSON.stringify(input.metadata || {})
        ]
      );
      return decode(result.rows[0]);
    } catch (error) {
      if (String((error as { code?: unknown }).code || '') === '23505') {
        throw storeError('Tinode provider user is already mapped to another identity', 409);
      }
      throw error;
    }
  }

  async getByIdentity(input: {
    tenant_id: string;
    session_id: string;
    provider: 'tinode';
    identity: string;
  }): Promise<TinodeProviderUser | null> {
    const result = await this.pg.query(
      `SELECT * FROM collaboration_provider_users
       WHERE tenant_id = $1 AND session_id = $2 AND provider = $3 AND identity = $4
       LIMIT 1`,
      [input.tenant_id, input.session_id, input.provider, input.identity]
    );
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async resolveIdentity(input: {
    tenant_id: string;
    binding_id: string;
    provider_user_id: string;
  }): Promise<string | null> {
    const result = await this.pg.query<{ identity: string }>(
      `SELECT provider_user.identity
       FROM collaboration_provider_users AS provider_user
       JOIN collaboration_participants AS participant
         ON participant.tenant_id = provider_user.tenant_id
        AND participant.session_id = provider_user.session_id
        AND participant.identity = provider_user.identity
        AND participant.left_at IS NULL
       WHERE provider_user.tenant_id = $1
         AND provider_user.binding_id = $2
         AND provider_user.provider = 'tinode'
         AND provider_user.provider_user_id = $3
         AND provider_user.status = 'active'
       LIMIT 1`,
      [input.tenant_id, input.binding_id, input.provider_user_id]
    );
    return result.rows[0] ? String(result.rows[0].identity) : null;
  }

  async revokeIdentity(input: {
    tenant_id: string;
    session_id: string;
    provider: 'tinode';
    identity: string;
  }): Promise<void> {
    await this.pg.query(
      `UPDATE collaboration_provider_users
       SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND session_id = $2 AND provider = $3 AND identity = $4`,
      [input.tenant_id, input.session_id, input.provider, input.identity]
    );
  }
}

function decode(row: Record<string, unknown>): TinodeProviderUser {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    binding_id: String(row.binding_id),
    provider_user_id: String(row.provider_user_id),
    identity: String(row.identity),
    status: String(row.status) as TinodeProviderUser['status'],
    metadata: parseRecord(row.metadata),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function required(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw storeError(`${field} is required`, 400);
  return normalized;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value || ''));
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function storeError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
