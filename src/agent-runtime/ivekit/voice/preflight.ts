import type { PgQueryable } from '../../../db-pg.js';
import { voiceProfileConfigHash } from './deployment-profile-service.js';
import { iveKitVoiceWorkerConfig, type IveKitVoiceWorkerConfig } from './runtime.js';
import type { VoiceAdapter, VoiceDeploymentProfile } from './types.js';

export interface IveKitVoicePreflightReport {
  ready: boolean;
  issues: string[];
  database: {
    configured: boolean;
    connected: boolean;
    migration_present: boolean;
    runtime_role_safe: boolean;
  };
  address_keys: { configured: boolean; valid: boolean };
  workers: IveKitVoiceWorkerConfig;
  profiles: IveKitVoicePreflightProfile[];
  verification_scope: 'configuration_and_database';
}

export interface IveKitVoicePreflightProfile {
  adapter: VoiceAdapter;
  status: VoiceDeploymentProfile['status'];
  endpoint: SafeEndpoint | null;
  rwi_endpoint: SafeEndpoint | null;
  secret_refs: { total: number; configured: number; ready: boolean };
  capability: {
    status: 'ready' | 'degraded' | 'not_available' | 'failed' | 'missing';
    age: 'fresh' | 'stale' | 'missing';
    config_hash_matches: boolean;
  };
}

interface SafeEndpoint {
  scheme: string;
  origin: string;
  path: string;
}

interface ProfileRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  name: string;
  adapter: VoiceAdapter;
  status: VoiceDeploymentProfile['status'];
  base_url: string;
  desired_version: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  capability_status?: string | null;
  capability_checked_at?: string | Date | null;
  capability_config_hash?: string | null;
}

export async function inspectIveKitVoice(input: {
  pg: PgQueryable | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): Promise<IveKitVoicePreflightReport> {
  const env = input.env || process.env;
  const now = input.now ?? (() => new Date());
  const issues = new Set<string>();
  let workers: IveKitVoiceWorkerConfig;
  try {
    workers = iveKitVoiceWorkerConfig(env);
  } catch {
    workers = iveKitVoiceWorkerConfig({});
    workers.enabled = String(env.OPC_IVEKIT_VOICE_WORKERS_ENABLED || '') === '1';
    issues.add('worker_config_invalid');
  }
  const addressKeys = addressKeyStatus(env);
  if (workers.enabled && !addressKeys.valid) issues.add('address_key_invalid');

  const configured = databaseConfigured(env);
  if (!configured) issues.add('database_configuration_missing');
  let connected = false;
  let migrationPresent = false;
  let runtimeRoleSafe = false;
  let rows: ProfileRow[] = [];
  if (!input.pg) {
    if (configured) issues.add('database_unavailable');
  } else {
    try {
      const database = await input.pg.query<{
        migration_present: boolean;
        runtime_role_safe: boolean;
      }>(DATABASE_PREFLIGHT_SQL);
      connected = true;
      migrationPresent = database.rows[0]?.migration_present === true;
      runtimeRoleSafe = database.rows[0]?.runtime_role_safe === true;
      if (!migrationPresent) issues.add('migration_missing');
      if (!runtimeRoleSafe) issues.add('runtime_role_unsafe');
      if (migrationPresent) {
        const profiles = await input.pg.query<ProfileRow>(PROFILE_PREFLIGHT_SQL);
        rows = profiles.rows;
      }
    } catch {
      issues.add('database_unavailable');
    }
  }

  const profiles = rows.map((row) => inspectProfile(row, env, now(), issues));
  if (workers.enabled && migrationPresent && !profiles.length) issues.add('profile_missing');
  const report: IveKitVoicePreflightReport = {
    ready: issues.size === 0,
    issues: [...issues].sort(),
    database: {
      configured,
      connected,
      migration_present: migrationPresent,
      runtime_role_safe: runtimeRoleSafe
    },
    address_keys: addressKeys,
    workers,
    profiles,
    verification_scope: 'configuration_and_database'
  };
  assertSecretSafe(report, env);
  return report;
}

const DATABASE_PREFLIGHT_SQL = `
SELECT
  to_regclass('public.ivekit_voice_deployment_profiles') IS NOT NULL
    AND to_regclass('public.ivekit_voice_call_commands') IS NOT NULL
    AND to_regclass('public.ivekit_voice_provider_events') IS NOT NULL AS migration_present,
  COALESCE((
    SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
    FROM pg_roles
    WHERE rolname = current_user
  ), false) AS runtime_role_safe
`;

const PROFILE_PREFLIGHT_SQL = `
SELECT p.id, p.tenant_id, p.name, p.adapter, p.status, p.base_url,
       p.desired_version, p.config, p.secret_refs, p.revision,
       p.created_by, p.updated_by, p.created_at, p.updated_at,
       snapshot.status AS capability_status,
       snapshot.checked_at AS capability_checked_at,
       snapshot.config_hash AS capability_config_hash
FROM ivekit_voice_deployment_profiles p
LEFT JOIN LATERAL (
  SELECT status, checked_at, config_hash
  FROM ivekit_voice_capability_snapshots s
  WHERE s.tenant_id = p.tenant_id AND s.profile_id = p.id
  ORDER BY s.checked_at DESC, s.created_at DESC
  LIMIT 1
) snapshot ON true
WHERE p.status IN ('enabled', 'degraded')
ORDER BY p.adapter, p.created_at
`;

function inspectProfile(
  row: ProfileRow,
  env: NodeJS.ProcessEnv,
  now: Date,
  issues: Set<string>
): IveKitVoicePreflightProfile {
  const profile = profileFromRow(row);
  const internalService = profile.config.internal_service === true;
  const endpoint = safeEndpoint(profile.base_url, env.NODE_ENV === 'production', internalService, issues);
  const rwiEndpoint = safeEndpoint(
    typeof profile.config.rwi_url === 'string' ? profile.config.rwi_url : '',
    env.NODE_ENV === 'production',
    internalService,
    issues
  );
  const refs = Object.values(profile.secret_refs);
  const configured = refs.filter((ref) => configuredSecretRef(ref, env)).length;
  if (configured !== refs.length) issues.add('profile_secret_unavailable');
  const snapshotStatus = capabilityStatus(row.capability_status);
  const checkedAt = timestamp(row.capability_checked_at);
  const ageMs = checkedAt === null ? null : Math.max(0, now.getTime() - checkedAt);
  const maxAgeMs = safeBoundedInteger(env.OPC_IVEKIT_VOICE_CAPABILITY_MAX_AGE_MS, 300_000, 10_000, 86_400_000);
  const age = ageMs === null ? 'missing' : ageMs <= maxAgeMs ? 'fresh' : 'stale';
  const configHashMatches = typeof row.capability_config_hash === 'string'
    && row.capability_config_hash === voiceProfileConfigHash(profile);
  if (snapshotStatus === 'missing') issues.add('capability_snapshot_missing');
  else if (snapshotStatus !== 'ready') issues.add('capability_snapshot_not_ready');
  if (age === 'stale') issues.add('capability_snapshot_stale');
  if (snapshotStatus !== 'missing' && !configHashMatches) issues.add('capability_config_drift');
  return {
    adapter: profile.adapter,
    status: profile.status,
    endpoint,
    rwi_endpoint: rwiEndpoint,
    secret_refs: { total: refs.length, configured, ready: configured === refs.length },
    capability: { status: snapshotStatus, age, config_hash_matches: configHashMatches }
  };
}

function profileFromRow(row: ProfileRow): VoiceDeploymentProfile {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), name: String(row.name),
    adapter: row.adapter, status: row.status, base_url: String(row.base_url || ''),
    desired_version: String(row.desired_version || ''), config: record(row.config),
    secret_refs: stringRecord(row.secret_refs), revision: Number(row.revision),
    created_by: String(row.created_by || ''), updated_by: String(row.updated_by || ''),
    created_at: timestampText(row.created_at), updated_at: timestampText(row.updated_at)
  };
}

function safeEndpoint(
  value: string,
  production: boolean,
  internalService: boolean,
  issues: Set<string>
): SafeEndpoint | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.add('profile_endpoint_invalid');
    return null;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    issues.add('profile_endpoint_invalid');
    return null;
  }
  if (production && (url.protocol === 'http:' || url.protocol === 'ws:') && !internalService) {
    issues.add('profile_endpoint_insecure');
  }
  return { scheme: url.protocol, origin: url.origin, path: url.pathname };
}

function capabilityStatus(value: unknown): IveKitVoicePreflightProfile['capability']['status'] {
  if (value === 'ready' || value === 'degraded' || value === 'not_available' || value === 'failed') return value;
  return 'missing';
}

function addressKeyStatus(env: NodeJS.ProcessEnv): { configured: boolean; valid: boolean } {
  const encryption = String(env.OPC_IVEKIT_VOICE_ADDRESS_KEY || '');
  const hmac = String(env.OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY || '');
  const configured = Boolean(encryption && hmac);
  return { configured, valid: configured && canonicalKey(encryption) && canonicalKey(hmac) };
}

function canonicalKey(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

function configuredSecretRef(ref: string, env: NodeJS.ProcessEnv): boolean {
  const match = ref.match(/^env:\/\/([A-Z][A-Z0-9_]*)$/);
  return Boolean(match && String(env[match[1]] || ''));
}

function databaseConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(String(env.DATABASE_URL || '').trim()) || (
    Boolean(String(env.PGHOST || '').trim())
    && Boolean(String(env.PGDATABASE || '').trim())
    && Boolean(String(env.PGUSER || '').trim())
  );
}

function safeBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function timestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = new Date(value as string | Date).getTime();
  return Number.isFinite(result) ? result : null;
}

function timestampText(value: unknown): string {
  const result = timestamp(value);
  return result === null ? '' : new Date(result).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string'
  ));
}

function assertSecretSafe(report: IveKitVoicePreflightReport, env: NodeJS.ProcessEnv): void {
  const serialized = JSON.stringify(report);
  const secrets = Object.entries(env)
    .filter(([key, value]) => /(?:PASSWORD|TOKEN|SECRET|DATABASE_URL|ADDRESS_KEY)/.test(key)
      && String(value || '').length >= 6)
    .map(([, value]) => String(value));
  if (secrets.some((secret) => serialized.includes(secret))) {
    throw new Error('voice preflight report failed secret-safety validation');
  }
}
