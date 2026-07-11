import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import React from 'react';

import type { IveKitPolicyFinding, IveKitPolicyFindingResult } from '@opc/ivekit-sdk';
import { installTestDom } from '../test-dom.js';

const closeDom = installTestDom();
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { FindingPanel } = await import('./finding-panel.js');

after(() => { cleanup(); closeDom(); });
afterEach(() => cleanup());

test('finding panel requires a reason and submits an allowed review transition', async () => {
  const calls: unknown[] = [];
  const item = finding();
  const view = render(<FindingPanel
    findings={[item]}
    selectedId={item.id}
    detail={detail(item)}
    canReview
    onSelect={() => undefined}
    onLoadDetail={async () => detail(item)}
    onReview={async (...args) => { calls.push(args); return detail({ ...item, review_status: 'confirmed' }); }}
  />);

  fireEvent.click(view.getByRole('button', { name: 'Confirm finding' }));
  assert.match(view.getByRole('alert').textContent || '', /reason/i);
  assert.equal(calls.length, 0);

  fireEvent.input(view.getByLabelText('Review reason'), { target: { value: 'Verified against the conversation' } });
  fireEvent.click(view.getByRole('button', { name: 'Confirm finding' }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0], [item.id, { review_status: 'confirmed', note: 'Verified against the conversation' }]);
});

test('finding panel surfaces reviewer authorization failures without clearing the reason', async () => {
  const item = finding();
  const denied = Object.assign(new Error('finding review requires an authorized active participant'), { status: 403 });
  const view = render(<FindingPanel
    findings={[item]}
    selectedId={item.id}
    detail={detail(item)}
    canReview
    onSelect={() => undefined}
    onLoadDetail={async () => detail(item)}
    onReview={async () => { throw denied; }}
  />);
  const reason = view.getByLabelText('Review reason') as HTMLTextAreaElement;
  fireEvent.input(reason, { target: { value: 'Needs supervisor verification' } });
  fireEvent.click(view.getByRole('button', { name: 'Confirm finding' }));

  await waitFor(() => assert.match(view.getByRole('alert').textContent || '', /authorized active participant/));
  assert.equal(reason.value, 'Needs supervisor verification');
});

test('finding panel refreshes stale detail after a realtime finding update', async () => {
  const oldFinding = finding();
  const updatedFinding = {
    ...oldFinding,
    review_status: 'confirmed' as const,
    updated_at: '2026-07-11T13:00:00.000Z'
  };
  let loads = 0;
  const view = render(<FindingPanel
    findings={[updatedFinding]}
    selectedId={oldFinding.id}
    detail={detail(oldFinding)}
    canReview
    onSelect={() => undefined}
    onLoadDetail={async () => { loads += 1; return detail(updatedFinding); }}
    onReview={async () => detail(updatedFinding)}
  />);

  await waitFor(() => assert.equal(loads, 1));
  await waitFor(() => assert.equal(view.getAllByText('Confirmed').length, 2));
});

test('finding panel does not loop while the detail endpoint lags the list version', async () => {
  const oldFinding = finding();
  const listedFinding = { ...oldFinding, updated_at: '2026-07-11T14:00:00.000Z' };
  let loads = 0;
  render(<FindingPanel
    findings={[listedFinding]}
    selectedId={oldFinding.id}
    detail={detail(oldFinding)}
    canReview
    onSelect={() => undefined}
    onLoadDetail={async () => { loads += 1; return detail(oldFinding); }}
    onReview={async () => detail(oldFinding)}
  />);

  await waitFor(() => assert.equal(loads, 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(loads, 1);
});

test('finding panel clears the review reason when selecting another finding', () => {
  const first = finding();
  const second = { ...finding(), id: 'finding-2', fingerprint: 'fingerprint-2', message_id: 'message-2' };
  const view = render(<FindingPanel
    findings={[first, second]}
    selectedId={first.id}
    detail={detail(first)}
    canReview
    onSelect={() => undefined}
    onLoadDetail={async () => detail(first)}
    onReview={async () => detail(first)}
  />);
  fireEvent.input(view.getByLabelText('Review reason'), { target: { value: 'Reason for the first finding' } });
  view.rerender(<FindingPanel
    findings={[first, second]}
    selectedId={second.id}
    detail={detail(second)}
    canReview
    onSelect={() => undefined}
    onLoadDetail={async () => detail(second)}
    onReview={async () => detail(second)}
  />);
  assert.equal((view.getByLabelText('Review reason') as HTMLTextAreaElement).value, '');
});

test('finding panel redacts reviewer identities in immutable history', () => {
  const item = finding();
  const itemDetail = detail(item);
  itemDetail.reviews = [{
    id: 'review-1', tenant_id: 'tenant-1', finding_id: item.id,
    from_status: 'pending', to_status: 'confirmed', reviewed_by: 'user@example.com',
    note: 'Checked with 13900001111', note_hash: 'hidden', metadata: {},
    created_at: '2026-07-11T12:30:00.000Z'
  }];
  const view = render(<FindingPanel
    findings={[item]}
    selectedId={item.id}
    detail={itemDetail}
    canReview={false}
    onSelect={() => undefined}
    onLoadDetail={async () => itemDetail}
    onReview={async () => itemDetail}
  />);
  assert.equal(view.queryByText('user@example.com'), null);
  assert.ok(view.getByText(/\[email\]/));
  assert.ok(view.getByText(/\[phone\]/));
});

function finding(): IveKitPolicyFinding {
  return {
    id: 'finding-1', tenant_id: 'tenant-1', session_id: 'session-1', message_id: 'message-1',
    source: 'text', source_ref_id: 'message-1', policy_type: 'contact_exchange', severity: 'high',
    matched_text_hash: 'hidden', fingerprint: 'fingerprint-1', action: 'review', confidence: null,
    rationale: 'Detected by a redacted policy rule', review_status: 'pending', evidence_refs: [],
    reviewed_by: '', reviewed_at: null, review_note: '', metadata: {},
    created_at: '2026-07-11T12:00:00.000Z', updated_at: '2026-07-11T12:00:00.000Z', resolved_at: null
  };
}

function detail(item: IveKitPolicyFinding): IveKitPolicyFindingResult {
  return { session_id: item.session_id, finding: item, reviews: [] };
}
