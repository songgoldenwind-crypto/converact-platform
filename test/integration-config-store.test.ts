import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IntegrationConfigStore } from '../src/agent-runtime/integrations/integration-config-store.js';

/**
 * Security tests for integration config store — the most sensitive store
 * because it handles API keys / secrets / tokens. A redaction bug here
 * means plaintext secrets written to the DB or leaked in responses.
 */

let db: ReturnType<typeof createDatabase>;
let store: IntegrationConfigStore;
let tenantId: string;

const savedEnv: Record<string, string | undefined> = {};

before(() => {
  db = createDatabase(':memory:');
  store = new IntegrationConfigStore(db);
  tenantId = createTenant(db, { name: 'Integration Test' }).id;
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

test('upsertSecretRef never stores plaintext — only fingerprint + redacted preview', () => {
  const ref = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'twilio',
    secret_key: 'api_key',
    secret_value: 'SK1234567890abcdef',
    env_var_name: 'TWILIO_API_KEY'
  });
  // Fingerprint is a sha256 hash, not the secret
  assert.ok(ref.secret_fingerprint);
  assert.equal(ref.secret_fingerprint.length, 64); // sha256 hex
  assert.notEqual(ref.secret_fingerprint, 'SK1234567890abcdef');
  // Redacted preview shows first 2 + last 4 chars only
  assert.match(ref.redacted_preview, /^SK.{4,}cdef$/);
  assert.ok(!ref.redacted_preview.includes('1234567890'));
  // The raw DB row must not contain the plaintext
  assert.ok(!JSON.stringify(ref).includes('SK1234567890abcdef'));
});

test('upsertSecretRef redacts short secrets (≤4 chars) as ****', () => {
  const ref = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'short',
    secret_key: 'pin',
    secret_value: 'abc',
    env_var_name: 'SHORT_PIN'
  });
  assert.equal(ref.redacted_preview, '****');
});

test('upsertSecretRef fingerprints consistently — same secret = same fingerprint', () => {
  const ref1 = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'a',
    secret_key: 'key1',
    secret_value: 'my-secret-value'
  });
  const ref2 = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'b',
    secret_key: 'key2',
    secret_value: 'my-secret-value'
  });
  assert.equal(ref1.secret_fingerprint, ref2.secret_fingerprint);
});

test('upsertSecretRef updates existing ref (ON CONFLICT)', () => {
  store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'conflict',
    secret_key: 'token',
    secret_value: 'old-value-123456'
  });
  const updated = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'conflict',
    secret_key: 'token',
    secret_value: 'new-value-789012'
  });
  assert.notEqual(updated.redacted_preview, '');
  // redactSecret shows first 2 + last 4 chars: "ne" + "****" + "9012"
  assert.ok(updated.redacted_preview.endsWith('9012'));
  assert.ok(updated.redacted_preview.startsWith('ne'));
});

test('upsertConfig redacts secret-like keys in stored config', () => {
  const config = store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'stripe',
    config: {
      webhook_url: 'https://example.com/webhook',
      api_key: 'sk_live_1234567890',
      secret_token: 'tok_secret',
      password: 'hunter2',
      auth_secret_key: 'should_not_redact', // explicitly excluded
      public_key: 'pk_normal'
    }
  });
  // Secret-like keys are redacted in storage
  assert.equal(config.config.api_key, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.secret_token, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.password, '[REDACTED_CONFIG_SECRET]');
  // Non-secret keys preserved
  assert.equal(config.config.webhook_url, 'https://example.com/webhook');
  assert.equal(config.config.public_key, 'pk_normal');
  // auth_secret_key is explicitly excluded from redaction
  assert.equal(config.config.auth_secret_key, 'should_not_redact');
});

test('shouldRedactConfigKey covers common secret key patterns', () => {
  // Access via upsertConfig and verify redaction happened
  const config = store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'patterns',
    config: {
      apiKey: 'val',        // camelCase
      api_key: 'val',        // snake_case
      'api-key': 'val',      // kebab-case
      API_KEY: 'val',        // uppercase
      secret: 'val',
      token: 'val',
      password: 'val',
      accessToken: 'val',
      refresh_token: 'val',
      normal_setting: 'val'
    }
  });
  assert.equal(config.config.apiKey, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.api_key, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config['api-key'], '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.API_KEY, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.secret, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.token, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.password, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.accessToken, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.refresh_token, '[REDACTED_CONFIG_SECRET]');
  assert.equal(config.config.normal_setting, 'val');
});

test('resolveRuntimeConfig reads secrets from env, returns plaintext resolved_secrets', () => {
  setEnv('TEST_INTEGRATION_KEY', 'env-secret-value-123');
  const secretRef = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'runtime',
    secret_key: 'api_key',
    secret_value: 'stored-secret',
    env_var_name: 'TEST_INTEGRATION_KEY'
  });
  store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'runtime',
    config: { endpoint: 'https://api.example.com' },
    secret_ref_ids: [secretRef.id]
  });
  const runtime = store.resolveRuntimeConfig({
    tenant_id: tenantId,
    integration_id: 'runtime',
    required_secret_keys: ['api_key']
  });
  assert.equal(runtime.runtime_status, 'ready');
  assert.equal(runtime.resolved_secrets.api_key, 'env-secret-value-123');
  assert.equal(runtime.runtime_config.api_key, 'env-secret-value-123');
  assert.equal(runtime.runtime_config.endpoint, 'https://api.example.com');
});

test('resolveRuntimeConfig reports missing secrets when env var is unset', () => {
  const secretRef = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'missing',
    secret_key: 'api_key',
    secret_value: 'stored',
    env_var_name: 'UNSET_VAR_THAT_DOES_NOT_EXIST_12345'
  });
  store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'missing',
    config: {},
    secret_ref_ids: [secretRef.id]
  });
  const runtime = store.resolveRuntimeConfig({
    tenant_id: tenantId,
    integration_id: 'missing',
    required_secret_keys: ['api_key']
  });
  assert.equal(runtime.runtime_status, 'missing_secrets');
  assert.ok(runtime.missing_secret_keys.includes('api_key'));
});

test('resolveRuntimeConfig throws on non-existent integration config', () => {
  assert.throws(
    () => store.resolveRuntimeConfig({ tenant_id: tenantId, integration_id: 'nonexistent' }),
    /integration config not found/
  );
});

test('healthCheck reports degraded when required secret keys are missing', () => {
  store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'healthcheck',
    config: {},
    secret_ref_ids: []
  });
  const result = store.healthCheck({
    tenant_id: tenantId,
    integration_id: 'healthcheck',
    required_secret_keys: ['api_key', 'webhook_secret']
  });
  assert.equal(result.health.status, 'degraded');
  assert.ok(result.health.missing_secret_keys.includes('api_key'));
  assert.ok(result.health.missing_secret_keys.includes('webhook_secret'));
});

test('healthCheck reports healthy when all required secrets are present', () => {
  const secretRef = store.upsertSecretRef({
    tenant_id: tenantId,
    integration_id: 'healthcheck-ok',
    secret_key: 'api_key',
    secret_value: 'val123456',
    env_var_name: 'HEALTHCHECK_OK_KEY'
  });
  store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'healthcheck-ok',
    config: {},
    secret_ref_ids: [secretRef.id]
  });
  const result = store.healthCheck({
    tenant_id: tenantId,
    integration_id: 'healthcheck-ok',
    required_secret_keys: ['api_key']
  });
  assert.equal(result.health.status, 'healthy');
  assert.equal(result.health.missing_secret_keys.length, 0);
});

test('upsertConfig updates existing config (ON CONFLICT)', () => {
  store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'update-test',
    config: { version: 1 }
  });
  const updated = store.upsertConfig({
    tenant_id: tenantId,
    integration_id: 'update-test',
    config: { version: 2, new_field: true }
  });
  assert.equal(updated.config.version, 2);
  assert.equal(updated.config.new_field, true);
});

test('listConfigs filters by status', () => {
  store.upsertConfig({ tenant_id: tenantId, integration_id: 'active-1', config: {}, status: 'configured' });
  store.upsertConfig({ tenant_id: tenantId, integration_id: 'disabled-1', config: {}, status: 'disabled' });
  const all = store.listConfigs({ tenant_id: tenantId });
  const active = store.listConfigs({ tenant_id: tenantId, status: 'configured' });
  assert.ok(all.length >= 2);
  assert.ok(active.every((c) => c.status === 'configured'));
  assert.ok(!active.some((c) => c.integration_id === 'disabled-1'));
});
