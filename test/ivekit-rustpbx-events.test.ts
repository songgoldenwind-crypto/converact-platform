import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  EnvVoiceSecretResolver,
  PostgresVoiceProfileContextResolver,
  RustPbxEventsAdapter,
  VoiceError,
  VoiceWebhookAuthenticator,
  type VoiceProfileContextResolver
} from '../src/agent-runtime/ivekit/voice/index.js';

test('Postgres profile context resolver uses only the security-definer binding', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const resolver = new PostgresVoiceProfileContextResolver({
    async query(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      return { rows: [{
        tenant_id: 'tenant-a', profile_id: 'profile-a', adapter: 'rustpbx',
        secret_refs: { webhook_hmac: 'env://RUSTPBX_WEBHOOK_HMAC' }
      }], rowCount: 1, command: '', oid: 0, fields: [] };
    }
  } as never);
  assert.equal((await resolver.resolve('profile-a'))?.tenant_id, 'tenant-a');
  assert.match(queries[0]!.text, /opc_ivekit_voice_profile_context\(\$1\)/);
  assert.deepEqual(queries[0]!.params, ['profile-a']);
  assert.doesNotMatch(queries[0]!.text, /ivekit_voice_deployment_profiles/);
});

test('Voice webhook auth prefers bounded HMAC and trusts only profile context tenant', async () => {
  const body = Buffer.from(JSON.stringify({ tenant_id: 'attacker', event: 'call.answered' }));
  const timestamp = '1783872000';
  const signature = createHmac('sha256', 'webhook-hmac-secret')
    .update(`${timestamp}.${body.toString('utf8')}`)
    .digest('hex');
  const authenticator = webhookAuthenticator();
  const authenticated = await authenticator.authenticate({
    profile_id: 'profile-a', raw_body: body,
    headers: {
      'x-ivekit-timestamp': timestamp,
      'x-ivekit-signature': `sha256=${signature}`,
      'x-tenant-id': 'attacker'
    }
  });
  assert.equal(authenticated.tenant_id, 'tenant-authoritative');
  assert.equal(authenticated.profile_id, 'profile-a');
  assert.equal(authenticated.method, 'hmac');
});

test('Voice webhook auth supports profile service keys and sanitizes failures', async () => {
  const authenticator = webhookAuthenticator();
  const serviceKey = await authenticator.authenticate({
    profile_id: 'profile-a', raw_body: Buffer.from('{}'),
    headers: { 'x-pbx-key': 'profile-service-key' }
  });
  assert.equal(serviceKey.method, 'service_key');

  for (const request of [
    { profile_id: 'profile-a', raw_body: Buffer.from('{}'), headers: { 'x-pbx-key': 'wrong-profile-service-key' } },
    {
      profile_id: 'profile-a', raw_body: Buffer.from('{}'),
      headers: { 'x-ivekit-timestamp': '1783871000', 'x-ivekit-signature': 'sha256=bad' }
    }
  ]) {
    await assert.rejects(() => authenticator.authenticate(request), (error: unknown) =>
      error instanceof VoiceError
      && error.code === 'webhook_auth_failed'
      && !JSON.stringify(error).includes('profile-service-key')
      && !JSON.stringify(error).includes('webhook-hmac-secret'));
  }
  await assert.rejects(() => authenticator.authenticate({
    profile_id: 'profile-a', raw_body: Buffer.alloc(2_048), headers: { 'x-pbx-key': 'profile-service-key' }
  }), hasVoiceCode('provider_payload_invalid'));
});

test('RustPBX events normalize call, RWI, and CDR payloads to safe convergence events', () => {
  const adapter = new RustPbxEventsAdapter();
  const answered = adapter.normalize('http', {
    event_id: 'event-a', event: 'call.answered', call_id: 'provider-call-a',
    occurred_at: '2026-07-13T00:00:01.000Z', from: '+8613800138000',
    authorization: 'private', sdp: 'v=0 private'
  });
  assert.equal(answered.event_type, 'call.answered');
  assert.equal(answered.provider_state, 'answered');
  assert.equal(answered.provider_call_id, 'provider-call-a');
  const safe = JSON.stringify(answered.safe_payload);
  assert.equal(safe.includes('+8613800138000'), false);
  assert.equal(safe.includes('private'), false);

  const held = adapter.normalize('rwi', {
    event: 'call_state_change', event_id: 'event-b', call_id: 'provider-call-a', state: 'held'
  });
  assert.equal(held.event_type, 'call.hold');
  assert.equal(held.provider_state, 'held');

  const cdr = adapter.normalize('cdr', {
    cdr_id: 'cdr-a', call_id: 'provider-call-a', state: 'completed', duration_ms: 12_000,
    hangup_reason: 'normal_clearing', recording_id: 'recording-a',
    metadata: JSON.stringify({ trunk: 'carrier-a', phone: '+8613800138000' })
  });
  assert.equal(cdr.event_type, 'call.cdr');
  assert.equal(cdr.safe_payload.duration_ms, 12_000);
  assert.equal(JSON.stringify(cdr.safe_payload).includes('+8613800138000'), false);
});

test('RustPBX events reject malformed and unsupported provider payloads', () => {
  const adapter = new RustPbxEventsAdapter();
  for (const input of [
    null,
    { event_id: 'event-a', event: 'call.unknown', call_id: 'call-a' },
    { event_id: '', event: 'call.answered', call_id: 'call-a' },
    { event_id: 'event-a', event: 'call.answered', call_id: '' }
  ]) {
    assert.throws(() => adapter.normalize('http', input), hasVoiceCode('protocol_mismatch'));
  }
});

function webhookAuthenticator(): VoiceWebhookAuthenticator {
  const contextResolver: VoiceProfileContextResolver = {
    async resolve(profileId) {
      if (profileId !== 'profile-a') return null;
      return {
        tenant_id: 'tenant-authoritative', profile_id: 'profile-a', adapter: 'rustpbx', status: 'enabled',
        secret_refs: {
          webhook_hmac: 'env://RUSTPBX_WEBHOOK_HMAC',
          webhook_service_key: 'env://RUSTPBX_WEBHOOK_SERVICE_KEY'
        }
      };
    }
  };
  return new VoiceWebhookAuthenticator({
    context_resolver: contextResolver,
    secret_resolver: new EnvVoiceSecretResolver({
      env: {
        RUSTPBX_WEBHOOK_HMAC: 'webhook-hmac-secret',
        RUSTPBX_WEBHOOK_SERVICE_KEY: 'profile-service-key'
      },
      allowlist: {
        webhook_hmac: ['RUSTPBX_WEBHOOK_HMAC'],
        webhook_service_key: ['RUSTPBX_WEBHOOK_SERVICE_KEY']
      }
    }),
    max_body_bytes: 1_024,
    max_skew_seconds: 300,
    now: () => new Date('2026-07-12T16:00:00.000Z')
  });
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
