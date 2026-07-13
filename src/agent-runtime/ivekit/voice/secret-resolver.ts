import { VoiceError } from './errors.js';

export interface EnvVoiceSecretResolverOptions {
  env?: Readonly<Record<string, string | undefined>>;
  allowlist: Readonly<Record<string, readonly string[]>>;
}

export class EnvVoiceSecretResolver {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #allowlist: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(options: EnvVoiceSecretResolverOptions) {
    this.#env = options.env ?? process.env;
    const allowlist = new Map<string, ReadonlySet<string>>();
    for (const [purpose, names] of Object.entries(options.allowlist)) {
      if (!purpose || !Array.isArray(names) || names.some((name) => !isEnvName(name))) {
        throw new VoiceError({ code: 'validation_failed', status: 500 });
      }
      allowlist.set(purpose, new Set(names));
    }
    this.#allowlist = allowlist;
  }

  async resolve(ref: unknown, purpose: string): Promise<string> {
    if (typeof ref !== 'string') throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
    const match = ref.match(/^env:\/\/([A-Z][A-Z0-9_]*)$/);
    const name = match?.[1] ?? '';
    if (!name || !this.#allowlist.get(purpose)?.has(name)) {
      throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
    }
    const value = this.#env[name];
    if (!value) throw new VoiceError({ code: 'secret_unavailable', retryable: true, status: 503 });
    return value;
  }
}

function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
}
