import assert from 'node:assert/strict';
import test from 'node:test';

import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { TinodeProviderUserStore } from '../src/agent-runtime/collaboration/tinode-provider-user-store.js';
import { MemoryPg } from '../src/db-pg.js';

async function fixture() {
  const pg = new MemoryPg();
  const collaboration = new CollaborationStore(pg);
  const session = await collaboration.openSession({
    tenant_id: 'tenant_provider_user',
    business_ref: { tenant_id: 'tenant_provider_user', type: 'order', id: 'ORDER-1' }
  });
  await collaboration.addParticipant({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    identity: 'customer-1',
    role: 'customer'
  });
  const binding = await collaboration.ensureChatBinding({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    provider: 'tinode',
    provider_topic_id: 'grpProviderUser'
  });
  return { pg, collaboration, session, binding };
}

test('Tinode provider user mapping is idempotent and resolves active participants only', async () => {
  const { pg, collaboration, session, binding } = await fixture();
  const store = new TinodeProviderUserStore(pg);

  const first = await store.upsert({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usrTinodeCustomer',
    identity: 'customer-1'
  });
  const replay = await store.upsert({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usrTinodeCustomer',
    identity: 'customer-1'
  });

  assert.equal(replay.id, first.id);
  assert.equal(await store.resolveIdentity({
    tenant_id: 'tenant_provider_user',
    binding_id: binding.id,
    provider_user_id: 'usrTinodeCustomer'
  }), 'customer-1');

  await collaboration.leaveParticipant({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    identity: 'customer-1'
  });
  assert.equal(await store.resolveIdentity({
    tenant_id: 'tenant_provider_user',
    binding_id: binding.id,
    provider_user_id: 'usrTinodeCustomer'
  }), null);
});

test('Tinode provider user mapping cannot bind one provider id to two identities', async () => {
  const { pg, collaboration, session, binding } = await fixture();
  await collaboration.addParticipant({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    identity: 'customer-2',
    role: 'customer'
  });
  const store = new TinodeProviderUserStore(pg);
  await store.upsert({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usrTinodeShared',
    identity: 'customer-1'
  });

  await assert.rejects(() => store.upsert({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usrTinodeShared',
    identity: 'customer-2'
  }), /already mapped/i);
});

test('revoking provider mapping is idempotent', async () => {
  const { pg, session, binding } = await fixture();
  const store = new TinodeProviderUserStore(pg);
  await store.upsert({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    binding_id: binding.id,
    provider_user_id: 'usrTinodeCustomer',
    identity: 'customer-1'
  });

  await store.revokeIdentity({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    provider: 'tinode',
    identity: 'customer-1'
  });
  await store.revokeIdentity({
    tenant_id: 'tenant_provider_user',
    session_id: session.id,
    provider: 'tinode',
    identity: 'customer-1'
  });
  assert.equal(await store.resolveIdentity({
    tenant_id: 'tenant_provider_user',
    binding_id: binding.id,
    provider_user_id: 'usrTinodeCustomer'
  }), null);
});
