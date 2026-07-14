import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { installTestDom } from './test-dom.js';
import { App } from './app.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

test('session cursor updates do not refetch the first page', async () => {
  let sessionRequests = 0;
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'agent-1';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/ivekit-config.json') {
      return Response.json({ baseUrl: 'http://ivekit.test', tenantId: 'tenant-1' });
    }
    if (url.includes('/api/ivekit/chat/sessions')) {
      sessionRequests += 1;
      return Response.json({ items: [], next_cursor: 'next-page', has_more: true });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  render(<App />);
  await waitFor(() => assert.equal(sessionRequests, 1), { timeout: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sessionRequests, 1);
});

test('mobile workspace switches between session and message views', () => {
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'agent-1';
  globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch;
  const view = render(<App />);
  const workspace = view.container.querySelector('main') as HTMLElement;
  assert.equal(workspace.dataset.mobileView, 'sessions');
  fireEvent.click(view.getByTitle('Show messages'));
  assert.equal(workspace.dataset.mobileView, 'chat');
  fireEvent.click(view.getByTitle('Show sessions'));
  assert.equal(workspace.dataset.mobileView, 'sessions');
});

test('call_id opens the media workspace and loads the durable call snapshot', async () => {
  window.history.replaceState({}, '', '/?call_id=call-1');
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'customer-1';
  let chatRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/ivekit-config.json') return Response.json({ baseUrl: 'http://ivekit.test', tenantId: 'tenant-1' });
    if (url.includes('/api/ivekit/media/calls/call-1')) return Response.json({
      call: {
        id: 'call-1', tenant_id: 'tenant-1', room_name: 'room-call-1', media: 'video', status: 'ringing',
        initiated_by: 'agent-1', business_ref: { type: 'order', id: 'order-1', metadata: {} }, title: 'Support call',
        metadata: {}, ring_timeout_seconds: 30, ring_expires_at: '2026-07-11T10:00:30.000Z', accepted_at: null,
        started_at: null, ended_at: null, end_reason: '', created_at: '2026-07-11T10:00:00.000Z', updated_at: '2026-07-11T10:00:00.000Z'
      },
      participants: [{
        id: 'participant-1', tenant_id: 'tenant-1', call_id: 'call-1', identity: 'customer-1', role: 'participant',
        status: 'ringing', display_name: 'Customer', metadata: {}, invited_at: '2026-07-11T10:00:00.000Z',
        accepted_at: null, joined_at: null, left_at: null, updated_at: '2026-07-11T10:00:00.000Z'
      }]
    });
    if (url.includes('/api/ivekit/chat/sessions')) {
      chatRequests += 1;
      return Response.json({ items: [], next_cursor: null, has_more: false });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<App />);
  await waitFor(() => assert.ok(view.getByText('Support call')));
  assert.equal(view.getByTitle('Show calls workspace').getAttribute('aria-pressed'), 'true');
  assert.ok(view.getByRole('button', { name: 'Accept' }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(chatRequests, 0);
});

test('voice_call_id opens the Voice workspace and loads the durable voice snapshot', async () => {
  window.history.replaceState({}, '', '/?voice_call_id=voice-call-1');
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'agent-voice';
  let chatRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/ivekit-config.json') return Response.json({ baseUrl: 'http://ivekit.test', tenantId: 'tenant-1' });
    if (url.includes('/api/ivekit/voice/calls/voice-call-1')) return Response.json({
      id: 'voice-call-1', tenant_id: 'tenant-1', business_ref: { type: 'service_order', id: 'SO-VOICE' },
      provider_profile_id: 'profile-1', provider_call_id: 'provider-call-1', provider_dialog_id: '', media_call_id: null,
      direction: 'inbound', state: 'ringing', from: { kind: 'e164', redacted: '+8613*******00' },
      to: { kind: 'extension', redacted: '10**' }, idempotency_key: 'dial-key', initiated_by: 'customer-1',
      metadata: {}, ringing_at: '2026-07-13T00:00:00.000Z', answered_at: null, ended_at: null,
      termination_reason: '', revision: 1, created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
    });
    if (url.includes('/api/ivekit/chat/sessions')) {
      chatRequests += 1;
      return Response.json({ items: [], next_cursor: null, has_more: false });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<App />);
  await waitFor(() => assert.ok(view.getByText('+8613*******00')));
  assert.equal(view.getByTitle('Show voice workspace').getAttribute('aria-pressed'), 'true');
  assert.equal((view.getByTitle('Answer call') as HTMLButtonElement).disabled, false);
  assert.equal(new URL(window.location.href).searchParams.get('voice_call_id'), 'voice-call-1');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(chatRequests, 0);
});

test('remote tab opens the RustDesk workspace without starting a session', async () => {
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'agent-remote';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/ivekit-config.json') return Response.json({ baseUrl: 'http://ivekit.test', tenantId: 'tenant-1' });
    if (url.includes('/api/ivekit/chat/sessions')) return Response.json({ items: [], next_cursor: null, has_more: false });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<App />);
  fireEvent.click(view.getByTitle('Show remote workspace'));
  await waitFor(() => assert.ok(view.getByText('Remote assistance')));
  assert.equal(new URL(window.location.href).searchParams.get('workspace'), 'remote');
  assert.equal(view.getByTitle('Show remote workspace').getAttribute('aria-pressed'), 'true');
  assert.ok(view.getByRole('button', { name: 'Start session' }));
});

test('quality tab opens the tenant review queue and recording source workspace', async () => {
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'quality-operator';
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === '/ivekit-config.json') return Response.json({ baseUrl: 'http://ivekit.test', tenantId: 'tenant-1' });
    if (url.includes('/api/ivekit/chat/sessions')) return Response.json({ items: [], next_cursor: null, has_more: false });
    if (url.includes('/api/ivekit/intelligence/findings')) return Response.json({ items: [], next_cursor: '' });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<App />);

  fireEvent.click(view.getByTitle('Show quality workspace'));

  await waitFor(() => assert.ok(view.getByText('Recording sources')));
  assert.ok(view.getByRole('region', { name: 'Tenant quality review queue' }));
  assert.ok(requests.some((request) => request.includes('/api/ivekit/intelligence/findings')));
  assert.equal(new URL(window.location.href).searchParams.get('workspace'), 'quality');
});

test('operations deep link opens the tenant Queue Monitor without loading chat', async () => {
  window.history.replaceState({}, '', '/?workspace=operations');
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'operations-viewer';
  let chatRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/ivekit-config.json') {
      return Response.json({ baseUrl: 'http://ivekit.test', tenantId: 'tenant-1' });
    }
    if (url.includes('/api/ivekit/contact-center/monitor')) return Response.json({
      generated_at: '2026-07-13T09:30:00.000Z',
      agents: {
        configured: 1, active: 1, offline: 0, available: 1, busy: 0,
        after_call: 0, away: 0, active_voice_count: 0, voice_capacity: 1
      },
      calls: { active_inbound: 0, active_outbound: 0 },
      operations: {
        callbacks_pending: 0, callbacks_failed_today: 0,
        overflows_pending: 0, overflows_failed_today: 0,
        supervisor_requested: 0, supervisor_active: 0
      },
      queues: [{
        queue_id: 'queue-1', queue_name: 'LED Support', status: 'active',
        routing_strategy: 'longest_idle', max_wait_seconds: 300,
        service_level_seconds: 20, waiting_count: 0, offered_count: 0,
        assigned_count: 0, answered_count: 0, available_agents: 1,
        available_capacity: 1, oldest_wait_seconds: 0, average_handle_seconds: 60,
        estimated_wait_seconds: 0, answered_today: 0,
        answered_in_service_level_today: 0, abandoned_today: 0,
        timed_out_today: 0, overflowed_today: 0, average_wait_seconds_today: 0,
        service_level_percent_today: 100, callbacks_pending: 0,
        callbacks_failed_today: 0, overflows_pending: 0, overflows_failed_today: 0
      }],
      alerts: []
    });
    if (url.includes('/api/ivekit/chat/sessions')) {
      chatRequests += 1;
      return Response.json({ items: [], next_cursor: null, has_more: false });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<App />);
  await waitFor(() => assert.ok(view.getByText('LED Support')));
  assert.equal(view.getByTitle('Show operations workspace').getAttribute('aria-pressed'), 'true');
  assert.equal(chatRequests, 0);
});

test('business reference deep link drives context, chat filtering, and remote defaults', async () => {
  window.history.replaceState({}, '', '/?business_ref_type=service_order&business_ref_id=SO-200');
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'agent-context';
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === '/ivekit-config.json') return Response.json({ baseUrl: 'http://ivekit.test', tenantId: 'tenant-1' });
    if (url.includes('/api/ivekit/context/by-ref')) return Response.json({
      tenant_id: 'tenant-1',
      business_ref: { type: 'service_order', id: 'SO-200' },
      viewer: { identity: 'agent-context', system: false },
      capabilities: { chat: true, media: false, remote_assistance: true },
      chat: { count: 2, sessions: [] },
      media: { count: 0, calls: [] },
      remote_assistance: { count: 1, sessions: [{ id: 'remote-200' }], devices: [] },
      authorization: {
        chat: [], media: [], remote_assistance: [{
          remote_session_id: 'remote-200', viewer_role: 'agent',
          consent: { active: true, scopes: ['view_screen'], expires_at: null }, gateway: null
        }]
      }
    });
    if (url.includes('/api/ivekit/chat/sessions')) {
      return Response.json({ items: [], next_cursor: null, has_more: false });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<App />);
  await waitFor(() => assert.ok(view.getByTitle('service_order: SO-200')));
  await waitFor(() => assert.ok(view.getByText('No sessions')));
  assert.ok(requests.some((request) => {
    const url = new URL(request, 'http://ivekit.test');
    return url.pathname === '/api/ivekit/chat/sessions' &&
      url.searchParams.get('business_ref_type') === 'service_order' &&
      url.searchParams.get('business_ref_id') === 'SO-200';
  }));
  assert.ok(view.getByText('2M · 0C · 1R'));
  fireEvent.click(view.getByTitle('Show authorization summary'));
  assert.ok(view.getByRole('complementary', { name: 'Business authorization summary' }));
  assert.ok(view.getByText('view_screen'));
  fireEvent.click(view.getByTitle('Close authorization summary'));

  assert.equal(new URL(window.location.href).searchParams.get('remote_session_id'), 'remote-200');
  fireEvent.click(view.getByTitle('Show remote workspace'));
  await waitFor(() => assert.ok(view.getByText('Remote assistance')));
});

test('popstate restores workspace and resource deep-link state', async () => {
  window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'test-token';
  window.__IVEKIT_DEV_IDENTITY__ = 'agent-history';
  globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch;
  const view = render(<App />);

  window.history.replaceState({}, '', '/?workspace=calls&call_id=call-back&business_ref_type=service_order&business_ref_id=SO-BACK');
  fireEvent(window, new window.Event('popstate'));

  await waitFor(() => assert.equal(view.getByTitle('Show calls workspace').getAttribute('aria-pressed'), 'true'));
  assert.ok(view.getByTitle('service_order: SO-BACK'));
  await waitFor(() => assert.ok(view.container.querySelector('.media-workspace-pane')));
  assert.equal(new URL(window.location.href).searchParams.get('call_id'), 'call-back');
});
