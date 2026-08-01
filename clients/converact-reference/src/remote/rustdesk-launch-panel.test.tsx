import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type {
  ConveractFabricRustDeskClient,
  RustDeskControlOwnership,
  RustDeskDevice,
  RustDeskGatewayLaunchPlan
} from '@converact/sdk';

import { installTestDom } from '../test-dom.js';
import { RustDeskLaunchPanel } from './rustdesk-launch-panel.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('remote workspace resolves a device starts a session and revalidates before user launch', async () => {
  const calls: string[] = [];
  const opened: string[] = [];
  let ownership: RustDeskControlOwnership = {
    status: 'unowned', owner_identity: null, lease_expires_at: null, version: 0,
    updated_at: '2026-07-12T08:00:00.000Z'
  };
  const client = fakeClient(calls, () => ownership, (value) => { ownership = value; });
  const view = render(<RustDeskLaunchPanel
    client={client}
    identity="agent-1"
    openProtocol={(url) => opened.push(url)}
    initialBusinessRef={{ type: 'service_order', id: 'SO-100' }}
    initialRemoteSessionId="remote-1"
  />);

  fireEvent.click(view.getByRole('button', { name: /Resolve devices/ }));
  await waitFor(() => assert.equal((view.getByLabelText('Device') as HTMLSelectElement).value, 'device-1'));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled, false));
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Start session' }));
    await Promise.resolve();
  });

  await waitFor(() => assert.ok(view.getByText('LED controller')));
  assert.ok(view.getByText('sha256:0011223344556677'));
  assert.ok(view.getByText('rustdesk-id.example.test'));
  assert.equal(view.container.textContent?.includes('signed-secret-token'), false);
  assert.deepEqual(calls.slice(0, 5), [
    'listDevices:service_order:SO-100',
    'start:remote-1:device-1:attended',
    'plan:gateway-1:none',
    'ownership:gateway-1',
    'audit:gateway-1'
  ]);
  assert.equal((view.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled, true);

  fireEvent.click(view.getByRole('button', { name: 'Open RustDesk' }));
  await waitFor(() => assert.deepEqual(opened, ['rustdesk://connect/123456789?session=gateway-1']));
  assert.equal(calls.filter((call) => call.startsWith('plan:')).length, 2);

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Take control' }));
    await Promise.resolve();
  });
  await waitFor(() => assert.ok(view.getByText('agent-1')));
  assert.ok(calls.includes('confirm:gateway-1:control_mouse_keyboard'));
  assert.ok(calls.includes('acquire:gateway-1:confirm-control'));
});

test('unattended workspace consumes a launch confirmation before requesting the plan', async () => {
  const calls: string[] = [];
  const client = fakeClient(calls, () => ({
    status: 'unowned', owner_identity: null, lease_expires_at: null, version: 0,
    updated_at: '2026-07-12T08:00:00.000Z'
  }), () => undefined);
  const view = render(<RustDeskLaunchPanel
    client={client}
    identity="agent-1"
    initialBusinessRef={{ type: 'service_order', id: 'SO-200' }}
    initialRemoteSessionId="remote-2"
    initialAccessMode="unattended"
  />);
  fireEvent.click(view.getByRole('button', { name: /Resolve devices/ }));
  await waitFor(() => assert.equal((view.getByLabelText('Device') as HTMLSelectElement).value, 'device-1'));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled, false));
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Start session' }));
    await Promise.resolve();
  });
  await waitFor(() => assert.ok(calls.includes('plan:gateway-1:confirm-launch')));
  assert.ok(calls.includes('confirm:gateway-1:unattended_launch'));
  assert.ok(calls.includes('start:remote-2:device-1:unattended'));

  const launchConfirmationCount = calls.filter((call) => call === 'confirm:gateway-1:unattended_launch').length;
  await waitFor(() => assert.equal(
    (view.getByTitle('Refresh remote state') as HTMLButtonElement).disabled,
    false
  ));
  fireEvent.click(view.getByTitle('Refresh remote state'));
  await waitFor(() => assert.ok(calls.includes('disconnect:gateway-1')));
  assert.equal(
    calls.filter((call) => call === 'confirm:gateway-1:unattended_launch').length,
    launchConfirmationCount
  );
});

test('remote workspace renews a control lease only while the signed-in participant owns it', async () => {
  const calls: string[] = [];
  let ownership: RustDeskControlOwnership = {
    status: 'unowned', owner_identity: null, lease_expires_at: null, version: 0,
    updated_at: '2026-07-12T08:00:00.000Z'
  };
  const client = fakeClient(calls, () => ownership, (value) => { ownership = value; });
  const view = render(<RustDeskLaunchPanel
    client={client}
    identity="agent-1"
    controlHeartbeatIntervalMs={10}
    initialBusinessRef={{ type: 'service_order', id: 'SO-300' }}
    initialRemoteSessionId="remote-3"
  />);

  fireEvent.click(view.getByRole('button', { name: /Resolve devices/ }));
  await waitFor(() => assert.equal((view.getByLabelText('Device') as HTMLSelectElement).value, 'device-1'));
  await waitFor(() => assert.equal(
    (view.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
    false
  ));
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Start session' }));
    await Promise.resolve();
  });
  await waitFor(() => assert.equal(
    (view.getByRole('button', { name: 'Take control' }) as HTMLButtonElement).disabled,
    false
  ));
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Take control' }));
    await Promise.resolve();
  });

  await waitFor(() => assert.ok(calls.includes('heartbeat-control:gateway-1:1')));
  assert.ok(view.getByText('2 scopes'));
});

function fakeClient(
  calls: string[],
  getOwnership: () => RustDeskControlOwnership,
  setOwnership: (ownership: RustDeskControlOwnership) => void
): ConveractFabricRustDeskClient {
  const device = {
    id: 'device-1', tenant_id: 'tenant-1', business_ref_type: 'service_order', business_ref_id: 'SO-100',
    rustdesk_id: '123456789', display_name: 'LED controller', status: 'active', runtime_status: 'online',
    last_seen_at: '2026-07-12T08:00:00.000Z', last_seen_actor: 'edge-1', metadata: {},
    created_at: '2026-07-12T08:00:00.000Z', updated_at: '2026-07-12T08:00:00.000Z', deactivated_at: null
  } as RustDeskDevice;
  const client: Partial<ConveractFabricRustDeskClient> = {
    async listDevicesByBusinessRef(input) {
      calls.push(`listDevices:${input.business_ref.type}:${input.business_ref.id}`);
      return [device];
    },
    async startGatewaySession(input) {
      calls.push(`start:${input.remote_session_id}:${input.device_id}:${input.access_mode}`);
      return {
        id: 'tool-1', tenant_id: 'tenant-1', remote_session_id: input.remote_session_id,
        provider: 'rustdesk', external_id: 'gateway-1', launch_url: 'https://hidden/signed-secret-token',
        status: 'active', started_by: input.actor_identity, started_at: '2026-07-12T08:00:00.000Z',
        ended_at: null, metadata: {}
      };
    },
    async getGatewayLaunchPlan(_externalId, input) {
      calls.push(`plan:gateway-1:${input?.confirmation_id || 'none'}`);
      return launchPlan();
    },
    async issueControlConfirmation(_externalId, input) {
      calls.push(`confirm:gateway-1:${input.operation}`);
      return {
        id: input.operation === 'unattended_launch' ? 'confirm-launch' : input.operation === 'control_transfer' ? 'confirm-transfer' : 'confirm-control',
        external_id: 'gateway-1', actor_identity: 'agent-1', operation: input.operation,
        expires_at: '2026-07-12T08:02:00.000Z', consumed_at: null, created_at: '2026-07-12T08:00:00.000Z'
      };
    },
    async getControlOwnership() { calls.push('ownership:gateway-1'); return getOwnership(); },
    async listGatewayAuditEvents() { calls.push('audit:gateway-1'); return [{ external_id: 'gateway-1', event_type: 'remote.gateway_session.created', actor_identity: 'agent-1', target: '123456789', metadata: {}, occurred_at: '2026-07-12T08:00:00.000Z' }]; },
    async getGatewayDisconnectState() {
      calls.push('disconnect:gateway-1');
      return { required: true, status: 'unavailable', command: null, observation_status: 'not_observed' };
    },
    async acquireControl(_externalId, input) {
      calls.push(`acquire:gateway-1:${input.confirmation_id}`);
      const next: RustDeskControlOwnership = { status: 'owned', owner_identity: 'agent-1', lease_expires_at: '2026-07-12T08:00:30.000Z', version: 1, updated_at: '2026-07-12T08:00:00.000Z' };
      setOwnership(next); return next;
    },
    async heartbeatControl(_externalId, input) {
      calls.push(`heartbeat-control:gateway-1:${input.version}`);
      const next: RustDeskControlOwnership = {
        ...getOwnership(), version: input.version + 1, lease_expires_at: '2026-07-12T08:01:00.000Z'
      };
      setOwnership(next);
      return next;
    }
  };
  return client as ConveractFabricRustDeskClient;
}


function launchPlan(): RustDeskGatewayLaunchPlan {
  return {
    external_id: 'gateway-1', status: 'active', launch_url: 'https://hidden/signed-secret-token',
    target: { type: 'device', id: '123456789', display_name: 'LED controller' },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    runtime: {
      rustdesk_id: '123456789', id_server: 'rustdesk-id.example.test', relay_server: 'rustdesk-relay.example.test',
      api_server: '', server_key_fingerprint: 'sha256:0011223344556677', public_key_configured: 'true', public_key_source: 'env'
    },
    client_config: {
      public_key_configured: true, public_key_source: 'env',
      manual_fields: { id_server: 'rustdesk-id.example.test', relay_server: 'rustdesk-relay.example.test', key: 'public-key-value' }
    },
    actions: { can_launch: true, open_url: 'https://hidden/signed-secret-token', protocol_url: 'rustdesk://connect/123456789?session=gateway-1' },
    metadata: {}, created_at: '2026-07-12T08:00:00.000Z', ended_at: null,
    permission_scopes: {
      requested: ['view_screen', 'control_mouse_keyboard'],
      consented: ['view_screen', 'control_mouse_keyboard'],
      granted: ['view_screen', 'control_mouse_keyboard']
    }
  };
}
