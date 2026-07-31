import { resolveConveractEnv } from './config/converact-env.js';
/**
 * Centralized environment variable validation.
 *
 * Call validateEnv() at startup (src/server.ts) to fail-fast on missing
 * required config in production, and warn on missing recommended config
 * in any environment.
 *
 * Design:
 * - Production (NODE_ENV=production): missing required vars → errors (exit)
 * - Non-production: missing required vars → warnings (continue)
 * - Optional but important vars (LiveKit, LLM): always warn if missing
 */

export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

interface EnvRule {
  key: string;
  description: string;
  level: 'required' | 'recommended';
}

const ENV_RULES: EnvRule[] = [
  { key: 'DATABASE_URL', description: 'PostgreSQL connection string', level: 'required' },
  { key: 'REDIS_URL', description: 'Redis connection for session cache + pubsub', level: 'recommended' },
  { key: 'LIVEKIT_URL', description: 'LiveKit server WebSocket URL', level: 'recommended' },
  { key: 'LIVEKIT_PUBLIC_URL', description: 'Public LiveKit WebSocket URL returned to browser clients', level: 'recommended' },
  { key: 'LIVEKIT_API_KEY', description: 'LiveKit API key', level: 'recommended' },
  { key: 'LIVEKIT_API_SECRET', description: 'LiveKit API secret', level: 'recommended' },
  { key: 'CONVERACT_API_KEY', description: 'API key for OPC internal auth', level: 'recommended' },
  { key: 'LLM_API_KEY', description: 'Self-hosted primary LLM API key (requires LLM_BASE_URL)', level: 'recommended' },
  { key: 'LLM_BASE_URL', description: 'Self-hosted primary LLM base URL (requires LLM_API_KEY)', level: 'recommended' },
  { key: 'DEEPSEEK_API_KEY', description: 'DeepSeek fallback LLM API key', level: 'recommended' }
];

export function validateEnv(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = process.env.NODE_ENV === 'production';

  for (const rule of ENV_RULES) {
    const value = resolveConveractEnv(process.env, rule.key);
    const hasDiscretePostgresConfig = rule.key === 'DATABASE_URL' &&
      ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].every((key) =>
        String(resolveConveractEnv(process.env, key) || '').trim() !== ''
      );
    const hasValue = (value !== undefined && value.trim() !== '') || hasDiscretePostgresConfig;

    if (!hasValue) {
      const msg = `${rule.key} not set — ${rule.description}`;
      if (rule.level === 'required' && isProduction) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  return { errors, warnings };
}

/**
 * Validate env at startup. In production, missing required vars cause exit(1).
 * In other modes, just print warnings.
 */
export function validateEnvOrExit(): void {
  const { errors, warnings } = validateEnv();

  for (const w of warnings) {
    console.warn(`[env] WARN: ${w}`);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`[env] ERROR: ${e}`);
    }
    console.error(`[env] ${errors.length} required env var(s) missing in production. Exiting.`);
    process.exit(1);
  }
}
