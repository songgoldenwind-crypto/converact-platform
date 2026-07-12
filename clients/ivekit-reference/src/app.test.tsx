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
  assert.equal(view.getByTitle('Show remote workspace').getAttribute('aria-pressed'), 'true');
  assert.ok(view.getByRole('button', { name: 'Start session' }));
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
      remote_assistance: { count: 1, sessions: [{ id: 'remote-200' }], devices: [] }
    });
    if (url.includes('/api/ivekit/chat/sessions')) {
      return Response.json({ items: [], next_cursor: null, has_more: false });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<App />);
  await waitFor(() => assert.ok(view.getByTitle('service_order: SO-200')));
  await waitFor(() => assert.ok(requests.some((request) => {
    const url = new URL(request, 'http://ivekit.test');
    return url.pathname === '/api/ivekit/chat/sessions' &&
      url.searchParams.get('business_ref_type') === 'service_order' &&
      url.searchParams.get('business_ref_id') === 'SO-200';
  })));
  assert.ok(view.getByText('2M · 0C · 1R'));

  fireEvent.click(view.getByTitle('Show remote workspace'));
  await waitFor(() => assert.equal((view.getByLabelText('Business ID') as HTMLInputElement).value, 'SO-200'));
  assert.equal((view.getByLabelText('Remote session ID') as HTMLInputElement).value, 'remote-200');
  assert.equal(new URL(window.location.href).searchParams.get('workspace'), 'remote');
});
