import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { installTestDom } from './test-dom.js';
import { App } from './app.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

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
