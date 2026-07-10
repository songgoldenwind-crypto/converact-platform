import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCollaborationModule,
  RustDeskDeviceCommandStore,
  RustDeskDeviceStore,
  RustDeskPhysicalDisconnectService,
  rustDeskClientConfig,
  rustDeskLaunchHtml,
  rustDeskLaunchPlan,
  rustDeskLaunchUrl
} from '../src/agent-runtime/collaboration/index.js';
import { MemoryPg } from '../src/db-pg.js';

test('collaboration public entry exports RustDesk client config helper', () => {
  const module = createCollaborationModule({ pg: new MemoryPg() });

  assert.equal(typeof rustDeskClientConfig, 'function');
  assert.equal(typeof rustDeskLaunchHtml, 'function');
  assert.equal(typeof rustDeskLaunchPlan, 'function');
  assert.equal(typeof rustDeskLaunchUrl, 'function');
  assert.equal(typeof RustDeskDeviceCommandStore, 'function');
  assert.equal(module.rustdeskCommands instanceof RustDeskDeviceCommandStore, true);
  assert.equal(typeof RustDeskPhysicalDisconnectService, 'function');
  assert.equal(module.rustdeskPhysicalDisconnect instanceof RustDeskPhysicalDisconnectService, true);
});

test('RustDeskDeviceStore registers resolves and deactivates tenant scoped devices', async () => {
  const store = new RustDeskDeviceStore(new MemoryPg());
  const tenantId = 'tenant_rustdesk_devices';
  const otherTenantId = 'tenant_rustdesk_other';

  const device = await store.registerDevice({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-device-1' },
    rustdesk_id: '123456789',
    display_name: 'LED controller A',
    metadata: { id_server: 'rustdesk-id.example.com', device_platform: 'windows' }
  });
  const fetched = await store.getDevice({ tenant_id: tenantId, device_id: device.id });
  const crossTenantFetch = await store.getDevice({ tenant_id: otherTenantId, device_id: device.id });
  const byRef = await store.getByBusinessRef({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-device-1' }
  });
  const heartbeat = await store.heartbeatDevice({
    tenant_id: tenantId,
    device_id: device.id,
    actor_identity: 'rustdesk-edge-agent',
    runtime_status: 'online',
    seen_at: '2026-07-04T01:00:00.000Z',
    metadata: {
      client_version: '1.2.3',
      os: 'windows'
    }
  });
  const crossTenantHeartbeat = await store.heartbeatDevice({
    tenant_id: otherTenantId,
    device_id: device.id,
    actor_identity: 'other-edge-agent',
    runtime_status: 'online'
  });
  const deactivated = await store.deactivateDevice({
    tenant_id: tenantId,
    device_id: device.id
  });
  const heartbeatAfterDeactivate = await store.heartbeatDevice({
    tenant_id: tenantId,
    device_id: device.id,
    actor_identity: 'rustdesk-edge-agent',
    runtime_status: 'online'
  });
  const byRefAfterDeactivate = await store.getByBusinessRef({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-device-1' }
  });

  assert.equal(device.tenant_id, tenantId);
  assert.equal(device.business_ref_type, 'service_order');
  assert.equal(device.business_ref_id, 'order-rustdesk-device-1');
  assert.equal(device.rustdesk_id, '123456789');
  assert.equal(device.display_name, 'LED controller A');
  assert.equal(device.metadata.id_server, 'rustdesk-id.example.com');
  assert.equal(fetched?.id, device.id);
  assert.equal(crossTenantFetch, null);
  assert.equal(byRef.length, 1);
  assert.equal(byRef[0]?.id, device.id);
  assert.equal(device.runtime_status, 'unknown');
  assert.equal(device.last_seen_at, null);
  assert.equal(heartbeat?.runtime_status, 'online');
  assert.equal(heartbeat?.last_seen_at, '2026-07-04T01:00:00.000Z');
  assert.equal(heartbeat?.last_seen_actor, 'rustdesk-edge-agent');
  assert.deepEqual(heartbeat?.metadata.last_heartbeat, {
    actor_identity: 'rustdesk-edge-agent',
    client_version: '1.2.3',
    os: 'windows',
    runtime_status: 'online',
    seen_at: '2026-07-04T01:00:00.000Z'
  });
  assert.equal(crossTenantHeartbeat, null);
  assert.equal(deactivated?.status, 'inactive');
  assert.equal(typeof deactivated?.deactivated_at, 'string');
  assert.equal(heartbeatAfterDeactivate, null);
  assert.deepEqual(byRefAfterDeactivate, []);
});

test('RustDeskDeviceStore rejects duplicate active RustDesk ids per tenant', async () => {
  const store = new RustDeskDeviceStore(new MemoryPg());
  const tenantId = 'tenant_rustdesk_duplicate';

  const first = await store.registerDevice({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-duplicate-1' },
    rustdesk_id: '987654321',
    display_name: 'LED controller B'
  });
  await assert.rejects(
    () =>
      store.registerDevice({
        tenant_id: tenantId,
        business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-duplicate-2' },
        rustdesk_id: '987654321',
        display_name: 'LED controller duplicate'
      }),
    /rustdesk device already registered/
  );
  const otherTenant = await store.registerDevice({
    tenant_id: 'tenant_rustdesk_duplicate_other',
    business_ref: { tenant_id: 'tenant_rustdesk_duplicate_other', type: 'service_order', id: 'order-other' },
    rustdesk_id: '987654321',
    display_name: 'Other tenant controller'
  });
  await store.deactivateDevice({ tenant_id: tenantId, device_id: first.id });
  const replacement = await store.registerDevice({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-duplicate-3' },
    rustdesk_id: '987654321',
    display_name: 'LED controller replacement'
  });

  assert.notEqual(otherTenant.tenant_id, tenantId);
  assert.equal(replacement.rustdesk_id, '987654321');
  assert.notEqual(replacement.id, first.id);
});

test('RustDeskDeviceStore rejects invalid registration refs before writing devices', async () => {
  const store = new RustDeskDeviceStore(new MemoryPg());
  const tenantId = 'tenant_rustdesk_invalid_register';
  const validInput = {
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-invalid-register' },
    rustdesk_id: '223344556',
    display_name: 'LED controller invalid register'
  };

  await assert.rejects(
    () => store.registerDevice({ ...validInput, tenant_id: '  ' }),
    /tenant_id is required/
  );
  await assert.rejects(
    () =>
      store.registerDevice({
        ...validInput,
        business_ref: { tenant_id: tenantId, type: '  ', id: 'order-rustdesk-invalid-register' }
      }),
    /business_ref type is required/
  );
  await assert.rejects(
    () =>
      store.registerDevice({
        ...validInput,
        business_ref: { tenant_id: tenantId, type: 'service_order', id: '  ' }
      }),
    /business_ref id is required/
  );
  await assert.rejects(
    () => store.registerDevice({ ...validInput, rustdesk_id: '  ' }),
    /rustdesk_id is required/
  );
  await assert.rejects(
    () => store.registerDevice({ ...validInput, display_name: '  ' }),
    /display_name is required/
  );

  const devices = await store.getByBusinessRef({
    tenant_id: tenantId,
    business_ref: validInput.business_ref
  });
  assert.deepEqual(devices, []);
});

test('RustDeskDeviceStore rejects invalid lookup and heartbeat inputs', async () => {
  const store = new RustDeskDeviceStore(new MemoryPg());
  const tenantId = 'tenant_rustdesk_invalid_lifecycle';
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: 'order-rustdesk-invalid-lifecycle' };
  const device = await store.registerDevice({
    tenant_id: tenantId,
    business_ref: businessRef,
    rustdesk_id: '334455667',
    display_name: 'LED controller invalid lifecycle'
  });

  await assert.rejects(
    () => store.getDevice({ tenant_id: '  ', device_id: device.id }),
    /tenant_id is required/
  );
  await assert.rejects(
    () => store.getDevice({ tenant_id: tenantId, device_id: '  ' }),
    /device_id is required/
  );
  await assert.rejects(
    () => store.getByBusinessRef({ tenant_id: '  ', business_ref: businessRef }),
    /tenant_id is required/
  );
  await assert.rejects(
    () => store.getByBusinessRef({ tenant_id: tenantId, business_ref: { tenant_id: tenantId, type: '  ', id: businessRef.id } }),
    /business_ref type is required/
  );
  await assert.rejects(
    () => store.getByBusinessRef({ tenant_id: tenantId, business_ref: businessRef, limit: 0 }),
    /limit must be an integer from 1 to 200/
  );
  await assert.rejects(
    () => store.getByBusinessRef({ tenant_id: tenantId, business_ref: businessRef, limit: Number.NaN }),
    /limit must be an integer from 1 to 200/
  );
  await assert.rejects(
    () => store.deactivateDevice({ tenant_id: tenantId, device_id: '  ' }),
    /device_id is required/
  );
  await assert.rejects(
    () =>
      store.heartbeatDevice({
        tenant_id: tenantId,
        device_id: device.id,
        actor_identity: '  '
      }),
    /actor_identity is required/
  );
  await assert.rejects(
    () =>
      store.heartbeatDevice({
        tenant_id: tenantId,
        device_id: '  ',
        actor_identity: 'rustdesk-edge-agent'
      }),
    /device_id is required/
  );
  await assert.rejects(
    () =>
      store.heartbeatDevice({
        tenant_id: tenantId,
        device_id: device.id,
        actor_identity: 'rustdesk-edge-agent',
        // @ts-expect-error Runtime guard for HTTP/JS callers that bypass the TypeScript union.
        runtime_status: ''
      }),
    /runtime_status must be online or offline/
  );

  const unchanged = await store.getDevice({ tenant_id: tenantId, device_id: device.id });
  assert.equal(unchanged?.runtime_status, 'unknown');
  assert.equal(unchanged?.last_seen_at, null);
});
