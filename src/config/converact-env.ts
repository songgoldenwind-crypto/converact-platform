export type BrandEnvScope = 'brand' | 'fabric';

export interface BrandEnvDeprecationEvent {
  event: 'converact.config.deprecated_environment_key';
  scope: BrandEnvScope;
  current_key: string;
  legacy_key: string;
}

export interface BrandEnvOptions {
  onDeprecation?: (event: BrandEnvDeprecationEvent) => void;
}

export interface InstalledBrandEnvAliases {
  installed: string[];
}

type Environment = Readonly<Record<string, string | undefined>>;
type MutableEnvironment = Record<string, string | undefined>;

const ENV_SUFFIX = /^[A-Z][A-Z0-9_]*$/;
const emittedLegacyKeys = new Set<string>();

function owns(env: Environment, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function defaultDeprecationEmitter(event: BrandEnvDeprecationEvent): void {
  if (emittedLegacyKeys.has(event.legacy_key)) return;
  emittedLegacyKeys.add(event.legacy_key);
  process.emitWarning(JSON.stringify(event), {
    code: 'CONVERACT_DEPRECATED_ENV',
  });
}

function keysFor(scope: BrandEnvScope, suffix: string): {
  currentKey: string;
  legacyKey: string;
} {
  if (!ENV_SUFFIX.test(suffix)) {
    throw new Error(`invalid branded environment variable suffix: ${suffix}`);
  }

  return scope === 'fabric'
    ? {
        currentKey: `CONVERACT_FABRIC_${suffix}`,
        legacyKey: `OPC_IVEKIT_${suffix}`,
      }
    : {
        currentKey: `CONVERACT_${suffix}`,
        legacyKey: `OPC_${suffix}`,
      };
}

function resolve(
  env: Environment,
  scope: BrandEnvScope,
  suffix: string,
  options: BrandEnvOptions,
): string | undefined {
  const { currentKey, legacyKey } = keysFor(scope, suffix);
  const hasCurrent = owns(env, currentKey);
  const hasLegacy = owns(env, legacyKey);

  if (hasCurrent && hasLegacy && env[currentKey] !== env[legacyKey]) {
    throw new Error(
      `conflicting branded environment variables: ${currentKey} and ${legacyKey}`,
    );
  }

  if (hasCurrent) return env[currentKey];
  if (!hasLegacy) return undefined;

  (options.onDeprecation ?? defaultDeprecationEmitter)({
    event: 'converact.config.deprecated_environment_key',
    scope,
    current_key: currentKey,
    legacy_key: legacyKey,
  });
  return env[legacyKey];
}

export function resolveBrandEnv(
  env: Environment,
  suffix: string,
  options: BrandEnvOptions = {},
): string | undefined {
  return resolve(env, 'brand', suffix, options);
}

export function resolveFabricEnv(
  env: Environment,
  suffix: string,
  options: BrandEnvOptions = {},
): string | undefined {
  return resolve(env, 'fabric', suffix, options);
}

export function resolveConveractEnv(
  env: Environment,
  key: string,
  options: BrandEnvOptions = {},
): string | undefined {
  if (key.startsWith('CONVERACT_FABRIC_')) {
    return resolveFabricEnv(env, key.slice('CONVERACT_FABRIC_'.length), options);
  }
  if (key.startsWith('OPC_IVEKIT_')) {
    return resolveFabricEnv(env, key.slice('OPC_IVEKIT_'.length), options);
  }
  if (key.startsWith('CONVERACT_')) {
    return resolveBrandEnv(env, key.slice('CONVERACT_'.length), options);
  }
  if (key.startsWith('OPC_')) {
    return resolveBrandEnv(env, key.slice('OPC_'.length), options);
  }
  return owns(env, key) ? env[key] : undefined;
}

export function installBrandEnvAliases(
  env: MutableEnvironment = process.env,
  options: BrandEnvOptions = {},
): InstalledBrandEnvAliases {
  const aliases = new Map<string, { scope: BrandEnvScope; suffix: string }>();

  for (const key of Object.keys(env)) {
    if (key.startsWith('CONVERACT_FABRIC_')) {
      aliases.set(key, { scope: 'fabric', suffix: key.slice('CONVERACT_FABRIC_'.length) });
    } else if (key.startsWith('OPC_IVEKIT_')) {
      const suffix = key.slice('OPC_IVEKIT_'.length);
      aliases.set(`CONVERACT_FABRIC_${suffix}`, { scope: 'fabric', suffix });
    } else if (key.startsWith('CONVERACT_')) {
      aliases.set(key, { scope: 'brand', suffix: key.slice('CONVERACT_'.length) });
    } else if (key.startsWith('OPC_')) {
      const suffix = key.slice('OPC_'.length);
      aliases.set(`CONVERACT_${suffix}`, { scope: 'brand', suffix });
    }
  }

  const pending: Array<{ currentKey: string; value: string | undefined }> = [];
  const deprecations: BrandEnvDeprecationEvent[] = [];

  for (const [currentKey, alias] of [...aliases].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const hadCurrent = owns(env, currentKey);
    const value = resolve(env, alias.scope, alias.suffix, {
      onDeprecation: (event) => deprecations.push(event),
    });
    if (!hadCurrent) pending.push({ currentKey, value });
  }

  for (const { currentKey, value } of pending) env[currentKey] = value;
  const emit = options.onDeprecation ?? defaultDeprecationEmitter;
  for (const event of deprecations) emit(event);

  return { installed: pending.map(({ currentKey }) => currentKey) };
}
