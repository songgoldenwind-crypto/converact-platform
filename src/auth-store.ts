import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { PgQueryable } from './db-pg.js';
import { MemoryPg, pgId, withPgTransaction } from './db-pg.js';
import { withPgBypass, withPgTenant } from './db-pg-tenant.js';
import { seedQuotaLimitsForPlanPg } from './plan-definitions-pg.js';

const scryptAsync = promisify(scrypt);

const SCRYPT_KEYLEN = 64;

export interface AuthUserRow {
  user_id: string;
  email: string;
  password_hash?: string;
  role: string;
  name: string | null;
  tenant_id: string;
  tenant_name: string;
  plan_code: string;
  tenant_status: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  tenantName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export class AuthStore {
  constructor(private readonly pg: PgQueryable) {}

  async register(input: RegisterInput): Promise<AuthUserRow> {
    const email = normalizeEmail(input.email);
    const password = String(input.password || '');
    const name = String(input.name || '').trim();
    const tenantName = String(input.tenantName || '').trim();

    if (!email || !email.includes('@')) {
      throw Object.assign(new Error('valid email is required'), { status: 400 });
    }
    if (password.length < 8) {
      throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 });
    }
    if (!tenantName) {
      throw Object.assign(new Error('tenantName is required'), { status: 400 });
    }

    const existing = await this.findByEmailAcrossTenants(email);
    if (existing) {
      throw Object.assign(new Error('email already registered'), { status: 409 });
    }

    const tenantId = pgId('tenant');
    const userId = pgId('user');
    const passwordHash = await hashPassword(password);

    try {
      await withPgTransaction(this.pg, async (client) => {
        if (this.pg instanceof MemoryPg) {
          await client.query(
            `INSERT INTO tenants (id, name, plan_code) VALUES ($1, $2, 'free')`,
            [tenantId, tenantName]
          );
          await client.query(
            `INSERT INTO users (id, tenant_id, email, password_hash, role, name)
             VALUES ($1, $2, $3, $4, 'owner', $5)`,
            [userId, tenantId, email, passwordHash, name || null]
          );
        } else {
          await client.query(
            'SELECT opc_register_tenant_owner($1, $2, $3, $4, $5, $6)',
            [tenantId, tenantName, userId, email, passwordHash, name]
          );
          await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
        }
        await seedQuotaLimitsForPlanPg(client, tenantId, 'free');
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw Object.assign(new Error('email already registered'), { status: 409 });
      }
      throw error;
    }

    const user = await withPgTenant(this.pg, tenantId, (client) =>
      this.findByUserIdOn(client, userId, tenantId)
    );
    if (!user) {
      throw Object.assign(new Error('failed to create user'), { status: 500 });
    }
    return user;
  }

  async login(input: LoginInput): Promise<AuthUserRow> {
    const email = normalizeEmail(input.email);
    const password = String(input.password || '');
    if (!email || !password) {
      throw Object.assign(new Error('email and password are required'), { status: 400 });
    }

    const row = await this.findByEmailAcrossTenants(email);
    if (!row?.password_hash) {
      throw Object.assign(new Error('invalid email or password'), { status: 401 });
    }

    const valid = await verifyPassword(password, row.password_hash);
    if (!valid) {
      throw Object.assign(new Error('invalid email or password'), { status: 401 });
    }

    if (row.tenant_status === 'suspended') {
      throw Object.assign(new Error('tenant is suspended'), { status: 403 });
    }

    const { password_hash: _ignored, ...user } = row;
    return user;
  }

  async findByEmail(email: string): Promise<AuthUserRow | null> {
    return this.findByEmailAcrossTenants(email);
  }

  private findByEmailAcrossTenants(email: string): Promise<AuthUserRow | null> {
    if (this.pg instanceof MemoryPg) {
      return withPgBypass(this.pg, (client) => this.findByEmailOn(client, email));
    }
    return this.pg.query<AuthUserRow>('SELECT * FROM opc_auth_user_by_email($1)', [email])
      .then((result) => result.rows[0] ?? null);
  }

  private async findByEmailOn(pg: PgQueryable, email: string): Promise<AuthUserRow | null> {
    const result = await pg.query<AuthUserRow>(
      `SELECT u.id AS user_id, u.email, u.password_hash, u.role, u.name,
              t.id AS tenant_id, t.name AS tenant_name, t.plan_code, t.status AS tenant_status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE LOWER(u.email) = LOWER($1) AND u.is_active = TRUE`,
      [email]
    );
    return result.rows[0] ?? null;
  }

  async findByUserId(userId: string, tenantId: string): Promise<AuthUserRow | null> {
    return withPgTenant(this.pg, tenantId, (client) => this.findByUserIdOn(client, userId, tenantId));
  }

  private async findByUserIdOn(
    pg: PgQueryable,
    userId: string,
    tenantId: string
  ): Promise<AuthUserRow | null> {
    const result = await pg.query<AuthUserRow>(
      `SELECT u.id AS user_id, u.email, u.role, u.name,
              t.id AS tenant_id, t.name AS tenant_name, t.plan_code, t.status AS tenant_status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.tenant_id = $2 AND u.is_active = TRUE`,
      [userId, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async getTenantStatus(tenantId: string): Promise<string | null> {
    return withPgTenant(this.pg, tenantId, async (client) => {
      const result = await client.query<{ status: string }>(
        'SELECT status FROM tenants WHERE id = $1',
        [tenantId]
      );
      return result.rows[0]?.status ?? null;
    });
  }

  async findByEmailInTenant(email: string, tenantId: string): Promise<AuthUserRow | null> {
    return withPgTenant(this.pg, tenantId, (client) =>
      this.findByEmailInTenantOn(client, email, tenantId)
    );
  }

  private async findByEmailInTenantOn(
    pg: PgQueryable,
    email: string,
    tenantId: string
  ): Promise<AuthUserRow | null> {
    const result = await pg.query<AuthUserRow>(
      `SELECT u.id AS user_id, u.email, u.password_hash, u.role, u.name,
              t.id AS tenant_id, t.name AS tenant_name, t.plan_code, t.status AS tenant_status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE LOWER(u.email) = LOWER($1) AND u.tenant_id = $2 AND u.is_active = TRUE`,
      [email, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async provisionOidcUser(input: {
    tenantId: string;
    email: string;
    name: string | null;
    externalSub: string;
    role?: string;
  }): Promise<AuthUserRow> {
    const email = normalizeEmail(input.email);
    if (!email) {
      throw Object.assign(new Error('email is required for SSO provisioning'), { status: 400 });
    }

    const existing = await this.findByEmailInTenant(email, input.tenantId);
    if (existing) {
      await withPgTenant(this.pg, input.tenantId, async (client) => {
        await client.query(
          `UPDATE users SET external_sub = COALESCE(external_sub, $1), name = COALESCE(name, $2)
           WHERE id = $3 AND tenant_id = $4`,
          [input.externalSub, input.name, existing.user_id, input.tenantId]
        );
      });
      const updated = await this.findByUserId(existing.user_id, input.tenantId);
      if (!updated) {
        throw Object.assign(new Error('failed to update SSO user'), { status: 500 });
      }
      return updated;
    }

    const userId = pgId('user');
    const role = input.role || 'operator';
    await withPgTenant(this.pg, input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, role, name, external_sub)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, input.tenantId, email, '', role, input.name, input.externalSub]
      );
    });
    const user = await this.findByUserId(userId, input.tenantId);
    if (!user) {
      throw Object.assign(new Error('failed to provision SSO user'), { status: 500 });
    }
    return user;
  }
}

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}
