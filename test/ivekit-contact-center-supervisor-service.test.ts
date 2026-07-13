import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterError,
  ContactCenterSupervisorService,
  type ContactCenterRepository,
  type ContactCenterSupervisorSession,
  type ContactCenterUnitOfWork
} from '../src/agent-runtime/ivekit/contact-center/index.js';

test('Contact Center supervisor starts and ends an authorized provider session idempotently', async () => {
  const provider = { supported: true };
  const fixture = setup(provider);
  const input = {
    tenant_id: 'tenant-a', call_id: 'call-a', target_agent_id: 'agent-a',
    supervisor_identity: 'admin-a', mode: 'whisper' as const,
    authorization_ref: 'policy:supervisor:42', idempotency_key: 'supervisor-key-a'
  };
  const started = await fixture.service.start(input);
  assert.equal(started.state, 'active');
  assert.equal(started.provider_session_id, 'provider-supervisor-a');
  assert.equal(started.started_at, '2026-07-13T00:00:00.000Z');
  assert.deepEqual(fixture.providerStarts, [{
    session_id: 'supervisor-a', tenant_id: 'tenant-a', call_id: 'call-a',
    target_agent_id: 'agent-a', supervisor_identity: 'admin-a', mode: 'whisper',
    authorization_ref: 'policy:supervisor:42'
  }]);

  provider.supported = false;
  const replay = await fixture.service.start(input);
  assert.equal(replay.id, started.id);
  assert.equal(fixture.providerStarts.length, 1);

  const ended = await fixture.service.end({
    tenant_id: 'tenant-a', session_id: started.id,
    supervisor_identity: 'admin-a', reason: 'review_complete'
  });
  assert.equal(ended.state, 'ended');
  assert.equal(ended.reason, 'review_complete');
  assert.equal(ended.ended_at, '2026-07-13T00:00:00.000Z');
  assert.deepEqual(fixture.providerEnds, [{
    tenant_id: 'tenant-a', provider_session_id: 'provider-supervisor-a',
    idempotency_key: 'supervisor-a:end'
  }]);
});

test('Contact Center supervisor keeps an active session retryable when provider end fails', async () => {
  const fixture = setup({ supported: true, providerEndError: new Error('temporary failure') });
  const started = await fixture.service.start({
    tenant_id: 'tenant-a', call_id: 'call-a', target_agent_id: 'agent-a',
    supervisor_identity: 'admin-a', mode: 'monitor', authorization_ref: 'policy:42',
    idempotency_key: 'supervisor-key-a'
  });
  await assert.rejects(() => fixture.service.end({
    tenant_id: 'tenant-a', session_id: started.id, supervisor_identity: 'admin-a'
  }), /temporary failure/);
  assert.equal(fixture.persisted?.state, 'active');
  assert.equal(fixture.persisted?.ended_at, null);
});

test('Contact Center supervisor rejects unsupported modes and unrelated target agents', async () => {
  const unavailable = setup({ supported: false });
  await assert.rejects(() => unavailable.service.start({
    tenant_id: 'tenant-a', call_id: 'call-a', target_agent_id: 'agent-a',
    supervisor_identity: 'admin-a', mode: 'barge', authorization_ref: 'policy:42',
    idempotency_key: 'supervisor-key-a'
  }), hasCode('capability_unavailable'));
  assert.equal(unavailable.persisted, null);

  const unrelated = setup({ supported: true, assigned: false });
  await assert.rejects(() => unrelated.service.start({
    tenant_id: 'tenant-a', call_id: 'call-a', target_agent_id: 'agent-b',
    supervisor_identity: 'admin-a', mode: 'monitor', authorization_ref: 'policy:42',
    idempotency_key: 'supervisor-key-a'
  }), hasCode('not_found'));
  assert.equal(unrelated.providerStarts.length, 0);
});

test('Contact Center supervisor persists a failed provider start without leaking provider details', async () => {
  const providerError = Object.assign(new Error('token=secret provider exploded'), { code: 'provider_unavailable' });
  const fixture = setup({ supported: true, providerError });
  await assert.rejects(() => fixture.service.start({
    tenant_id: 'tenant-a', call_id: 'call-a', target_agent_id: 'agent-a',
    supervisor_identity: 'admin-a', mode: 'monitor', authorization_ref: 'policy:42',
    idempotency_key: 'supervisor-key-a'
  }), hasCode('conflict'));
  assert.equal(fixture.persisted?.state, 'failed');
  assert.equal(fixture.persisted?.reason, 'provider_unavailable');
  assert.equal(JSON.stringify(fixture.persisted).includes('token=secret'), false);
});

function setup(input: {
  supported: boolean;
  assigned?: boolean;
  providerError?: Error & { code?: string };
  providerEndError?: Error;
}) {
  let persisted: ContactCenterSupervisorSession | null = null;
  const providerStarts: Array<Record<string, unknown>> = [];
  const providerEnds: Array<Record<string, unknown>> = [];
  const repository = {
    async findSupervisorByIdempotencyKey(_tenantId: string, key: string) {
      return persisted?.idempotency_key === key ? structuredClone(persisted) : null;
    },
    async isAgentAssignedToCall() { return input.assigned !== false; },
    async insertSupervisorSession(value: ContactCenterSupervisorSession) {
      persisted = structuredClone(value);
      return structuredClone(value);
    },
    async getSupervisorSession(_tenantId: string, id: string) {
      return persisted?.id === id ? structuredClone(persisted) : null;
    },
    async updateSupervisorSession(value: ContactCenterSupervisorSession) {
      persisted = { ...structuredClone(value), revision: value.revision + 1 };
      return structuredClone(persisted);
    }
  } as unknown as ContactCenterRepository;
  const unitOfWork: ContactCenterUnitOfWork = {
    run: async (_tenantId, operation) => operation({ repository })
  };
  const service = new ContactCenterSupervisorService({
    unit_of_work: unitOfWork,
    control: {
      supports: () => input.supported,
      async start(startInput) {
        providerStarts.push(structuredClone(startInput));
        if (input.providerError) throw input.providerError;
        return { provider_session_id: 'provider-supervisor-a' };
      },
      async end(endInput) {
        providerEnds.push(structuredClone(endInput));
        if (input.providerEndError) throw input.providerEndError;
      }
    },
    id: () => 'supervisor-a',
    now: () => new Date('2026-07-13T00:00:00.000Z')
  });
  return {
    service,
    providerStarts,
    providerEnds,
    get persisted() { return persisted; }
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ContactCenterError && error.code === code;
}
