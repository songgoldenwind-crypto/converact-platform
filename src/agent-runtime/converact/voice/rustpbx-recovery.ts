export interface RustPbxRecoveryOptions {
  base_url: string;
  attempts: number;
  retry_delay_ms: number;
}

export interface RustPbxRecoveryResult {
  status: 'ready';
  attempts: number;
  trunks_reloaded: number;
  generated_entries: number;
}

interface RustPbxRecoveryDependencies {
  fetch: typeof fetch;
  sleep: (delayMs: number) => Promise<void>;
}

const DEFAULT_RECOVERY_URL = 'http://127.0.0.1:8080';

export function rustPbxRecoveryOptionsFromEnv(
  env: NodeJS.ProcessEnv
): RustPbxRecoveryOptions {
  const baseUrl = loopbackHttpUrl(env.RUSTPBX_RECOVERY_URL || DEFAULT_RECOVERY_URL);
  return {
    base_url: baseUrl,
    attempts: boundedInteger(env.RUSTPBX_RECOVERY_ATTEMPTS, 60, 1, 300),
    retry_delay_ms: boundedInteger(env.RUSTPBX_RECOVERY_RETRY_MS, 1000, 10, 30_000)
  };
}

export async function recoverRustPbxRuntime(
  options: RustPbxRecoveryOptions,
  dependencies: RustPbxRecoveryDependencies = {
    fetch,
    sleep: async (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
  }
): Promise<RustPbxRecoveryResult> {
  const endpoint = new URL('/ami/v1/reload/trunks', `${loopbackHttpUrl(options.base_url)}/`);
  const attempts = boundedInteger(String(options.attempts), options.attempts, 1, 300);
  const retryDelayMs = boundedInteger(
    String(options.retry_delay_ms),
    options.retry_delay_ms,
    1,
    30_000
  );

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await tryReload(endpoint, dependencies.fetch);
    if (result) return { ...result, attempts: attempt };
    if (attempt < attempts) await dependencies.sleep(retryDelayMs);
  }
  throw new Error(`RustPBX runtime recovery failed after ${attempts} attempts`);
}

async function tryReload(
  endpoint: URL,
  fetchImpl: typeof fetch
): Promise<Omit<RustPbxRecoveryResult, 'attempts'> | null> {
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return null;
    const payload = await response.json() as Record<string, unknown>;
    if (payload.status !== 'ok') return null;
    const metrics = object(payload.metrics);
    const generated = object(metrics.generated);
    return {
      status: 'ready',
      trunks_reloaded: nonNegativeInteger(payload.trunks_reloaded),
      generated_entries: nonNegativeInteger(generated.entries)
    };
  } catch {
    return null;
  }
}

function loopbackHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('RUSTPBX_RECOVERY_URL must be a loopback HTTP URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('RUSTPBX_RECOVERY_URL must be a credential-free loopback HTTP origin');
  }
  return parsed.origin;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`RustPBX recovery integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
