import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { installTestDom } from '../test-dom.js';
import { HostControls } from './host-controls.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('participant never sees host moderation commands', () => {
  const view = render(<HostControls role="participant" participants={[]} tracks={{}} disabled={false} onMute={async () => undefined} onRemove={async () => undefined} onClose={async () => undefined} />);
  assert.equal(view.container.textContent, '');
});

test('host confirms mute, remove, and close using the selected durable identity and track', async () => {
  const calls: string[] = [];
  const original = window.confirm;
  window.confirm = () => true;
  try {
    const view = render(<HostControls
      role="host"
      participants={[{ identity: 'customer-1', display_name: 'Customer', status: 'joined' }] as never}
      tracks={{ mic: { id: 'TR_MIC', participantIdentity: 'customer-1', source: 'microphone', kind: 'audio', muted: false } as never }}
      disabled={false}
      onMute={async (identity, track) => { calls.push(`mute:${identity}:${track.id}`); }}
      onRemove={async (identity) => { calls.push(`remove:${identity}`); }}
      onClose={async () => { calls.push('close'); }}
    />);
    fireEvent.click(view.getByTitle('Mute Customer'));
    fireEvent.click(view.getByTitle('Remove Customer'));
    fireEvent.click(view.getByTitle('Close call for everyone'));
    await Promise.resolve();
    assert.deepEqual(calls, ['mute:customer-1:TR_MIC', 'remove:customer-1', 'close']);
  } finally { window.confirm = original; }
});
