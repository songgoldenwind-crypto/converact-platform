import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installBrandEnvAliases,
  resolveBrandEnv,
  resolveConveractEnv,
  resolveFabricEnv,
  type BrandEnvDeprecationEvent,
} from '../src/config/converact-env.js';

test('resolves current, legacy, and equal brand environment values', () => {
  assert.equal(resolveBrandEnv({ CONVERACT_API_KEY: 'new' }, 'API_KEY'), 'new');
  assert.equal(resolveBrandEnv({ OPC_API_KEY: 'old' }, 'API_KEY'), 'old');
  assert.equal(
    resolveBrandEnv({ CONVERACT_API_KEY: 'same', OPC_API_KEY: 'same' }, 'API_KEY'),
    'same',
  );
});

test('emits a redacted structured event only for a legacy-only value', () => {
  const events: BrandEnvDeprecationEvent[] = [];
  const secret = 'must-never-be-logged';

  assert.equal(
    resolveBrandEnv({ OPC_API_KEY: secret }, 'API_KEY', {
      onDeprecation: (event) => events.push(event),
    }),
    secret,
  );
  assert.deepEqual(events, [
    {
      event: 'converact.config.deprecated_environment_key',
      scope: 'brand',
      current_key: 'CONVERACT_API_KEY',
      legacy_key: 'OPC_API_KEY',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));

  events.length = 0;
  resolveBrandEnv({ CONVERACT_API_KEY: secret, OPC_API_KEY: secret }, 'API_KEY', {
    onDeprecation: (event) => events.push(event),
  });
  assert.deepEqual(events, []);
});

test('fails closed on conflicting brand values without exposing either value', () => {
  const currentSecret = 'current-secret-value';
  const legacySecret = 'legacy-secret-value';

  assert.throws(
    () =>
      resolveBrandEnv(
        { CONVERACT_API_KEY: currentSecret, OPC_API_KEY: legacySecret },
        'API_KEY',
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /conflicting branded environment variables/);
      assert.match(error.message, /CONVERACT_API_KEY/);
      assert.match(error.message, /OPC_API_KEY/);
      assert.doesNotMatch(error.message, new RegExp(currentSecret));
      assert.doesNotMatch(error.message, new RegExp(legacySecret));
      return true;
    },
  );
});

test('treats empty strings as explicit values and ignores inherited properties', () => {
  assert.equal(resolveBrandEnv({ CONVERACT_API_KEY: '' }, 'API_KEY'), '');
  assert.throws(
    () => resolveBrandEnv({ CONVERACT_API_KEY: '', OPC_API_KEY: 'legacy' }, 'API_KEY'),
    /conflicting branded environment variables/,
  );

  const inherited = Object.create({ CONVERACT_API_KEY: 'inherited' }) as Record<
    string,
    string | undefined
  >;
  inherited.OPC_API_KEY = 'owned';
  assert.equal(resolveBrandEnv(inherited, 'API_KEY'), 'owned');
});

test('maps the Fabric namespace to the OPC_IVEKIT compatibility namespace', () => {
  const events: BrandEnvDeprecationEvent[] = [];
  assert.equal(
    resolveFabricEnv({ OPC_IVEKIT_INSTANCE_ID: 'legacy-instance' }, 'INSTANCE_ID', {
      onDeprecation: (event) => events.push(event),
    }),
    'legacy-instance',
  );
  assert.deepEqual(events, [
    {
      event: 'converact.config.deprecated_environment_key',
      scope: 'fabric',
      current_key: 'CONVERACT_FABRIC_INSTANCE_ID',
      legacy_key: 'OPC_IVEKIT_INSTANCE_ID',
    },
  ]);
});

test('resolves full current keys and passes non-branded keys through', () => {
  assert.equal(
    resolveConveractEnv({ OPC_API_KEY: 'legacy' }, 'CONVERACT_API_KEY'),
    'legacy',
  );
  assert.equal(
    resolveConveractEnv(
      { OPC_IVEKIT_INSTANCE_ID: 'legacy-instance' },
      'CONVERACT_FABRIC_INSTANCE_ID',
    ),
    'legacy-instance',
  );
  assert.equal(resolveConveractEnv({ DATABASE_URL: '' }, 'DATABASE_URL'), '');
  assert.equal(resolveConveractEnv(Object.create({ DATABASE_URL: 'inherited' }), 'DATABASE_URL'), undefined);
});

test('installs discovered legacy aliases atomically into the current namespace', () => {
  const env: Record<string, string | undefined> = {
    OPC_API_KEY: 'brand-key',
    OPC_IVEKIT_INSTANCE_ID: 'fabric-instance',
  };
  const events: BrandEnvDeprecationEvent[] = [];

  const result = installBrandEnvAliases(env, {
    onDeprecation: (event) => events.push(event),
  });

  assert.deepEqual(result, {
    installed: ['CONVERACT_API_KEY', 'CONVERACT_FABRIC_INSTANCE_ID'],
  });
  assert.equal(env.CONVERACT_API_KEY, 'brand-key');
  assert.equal(env.CONVERACT_FABRIC_INSTANCE_ID, 'fabric-instance');
  assert.equal(events.length, 2);

  const conflicting: Record<string, string | undefined> = {
    OPC_API_KEY: 'legacy',
    OPC_IVEKIT_INSTANCE_ID: 'legacy-instance',
    CONVERACT_FABRIC_INSTANCE_ID: 'different-instance',
  };
  assert.throws(
    () => installBrandEnvAliases(conflicting),
    /conflicting branded environment variables/,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(conflicting, 'CONVERACT_API_KEY'),
    false,
    'validation must finish before any alias is installed',
  );
});
