import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import React from 'react';

import { installTestDom } from '../test-dom.js';

const closeDom = installTestDom();
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { ParticipantRail } = await import('./participant-rail.js');

after(() => { cleanup(); closeDom(); });
afterEach(() => cleanup());

test('participant rail exposes a closeable quality drawer when a finding is selected', async () => {
  let closed = 0;
  const view = render(<ParticipantRail
    participants={[]}
    realtime={[]}
    findings={[]}
    identity="agent-1"
    selectedFindingId="finding-1"
    findingDetail={null}
    onSelectFinding={() => undefined}
    onCloseFinding={() => { closed += 1; }}
    onLoadFinding={() => new Promise(() => undefined)}
    onReviewFinding={async () => { throw new Error('not reviewed'); }}
  />);
  await waitFor(() => assert.ok(view.getByText('No findings')));
  assert.equal(view.container.querySelector('aside')?.classList.contains('finding-open'), true);
  fireEvent.click(view.getByTitle('Close quality review'));
  assert.equal(closed, 1);
});
