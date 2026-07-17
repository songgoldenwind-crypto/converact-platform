import { NotificationError } from './errors.js';
import type { NotificationSecretResolver } from './ports.js';

export interface EnvNotificationSecretResolverOptions {
  env?: Readonly<Record<string, string | undefined>>;
  allowlist: Readonly<Record<string, readonly string[]>>;
}

export class EnvNotificationSecretResolver implements NotificationSecretResolver {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #allowlist: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(options: EnvNotificationSecretResolverOptions) {
    this.#env = options.env || process.env;
    const allowlist = new Map<string, ReadonlySet<string>>();
    for (const [purpose, names] of Object.entries(options.allowlist)) {
      if (!purpose || !Array.isArray(names) || names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
        throw new NotificationError({ code: 'validation_failed', status: 500 });
      }
      allowlist.set(purpose, new Set(names));
    }
    this.#allowlist = allowlist;
  }

  async resolve(ref: string, purpose: 'webhook_signing' | 'provider_credential'): Promise<string> {
    const match = typeof ref === 'string' ? ref.match(/^env:\/\/([A-Z][A-Z0-9_]*)$/) : null;
    const name = match?.[1] || '';
    if (!name || !this.#allowlist.get(purpose)?.has(name)) {
      throw new NotificationError({ code: 'secret_ref_invalid', status: 422 });
    }
    const value = this.#env[name];
    if (!value) {
      throw new NotificationError({
        code: 'secret_unavailable', retryable: true, status: 503
      });
    }
    return value;
  }
}

export function configuredNotificationSecretResolver(
  env: Readonly<Record<string, string | undefined>> = process.env
): EnvNotificationSecretResolver {
  return new EnvNotificationSecretResolver({
    env,
    allowlist: {
      webhook_signing: envNames(env.OPC_IVEKIT_NOTIFICATION_WEBHOOK_SECRET_ENV_NAMES),
      provider_credential: envNames(env.OPC_IVEKIT_NOTIFICATION_PROVIDER_SECRET_ENV_NAMES)
    }
  });
}

function envNames(value: string | undefined): string[] {
  if (!String(value || '').trim()) return [];
  const names = String(value).split(',').map((name) => name.trim()).filter(Boolean);
  if (new Set(names).size !== names.length
    || names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error('notification secret environment allowlist is invalid');
  }
  return names;
}
