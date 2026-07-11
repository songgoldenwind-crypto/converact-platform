import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { installTestDom } from '../test-dom.js';
import { NetworkStatus, normalizeNetworkQuality } from './network-status.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('provider quality is normalized without exposing diagnostics', () => {
  assert.equal(normalizeNetworkQuality('excellent'), 'excellent');
  assert.equal(normalizeNetworkQuality('good'), 'good');
  assert.equal(normalizeNetworkQuality('poor'), 'poor');
  assert.equal(normalizeNetworkQuality('lost'), 'lost');
  assert.equal(normalizeNetworkQuality('unexpected-provider-value'), 'unknown');
});

test('network banner handles reconnect, offline, fatal, and autoplay unblock', () => {
  let starts = 0;
  const view = render(<NetworkStatus connection="reconnecting" autoplayBlocked={false} onStartAudio={async () => { starts += 1; }} />);
  assert.ok(view.getByRole('status').textContent?.includes('Reconnecting'));
  view.rerender(<NetworkStatus connection="offline" autoplayBlocked onStartAudio={async () => { starts += 1; }} />);
  fireEvent.click(view.getByRole('button', { name: 'Start audio' }));
  assert.equal(starts, 1);
  view.rerender(<NetworkStatus connection="fatal" autoplayBlocked={false} fatalReason="Room closed" onStartAudio={async () => undefined} />);
  assert.ok(view.getByRole('alert').textContent?.includes('Room closed'));
  view.rerender(<NetworkStatus connection="online" autoplayBlocked={false} onStartAudio={async () => undefined} />);
  assert.equal(view.queryByRole('status'), null);
});
