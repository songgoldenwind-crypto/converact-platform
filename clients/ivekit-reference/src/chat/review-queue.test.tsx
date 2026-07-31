import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { IveKitClient, IveKitPolicyFinding } from '@opc/ivekit-sdk';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { installTestDom } from '../test-dom.js';
import { ReviewQueue } from './review-queue.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('review queue applies operational filters, paginates, and submits a review transition', async () => {
  const filters: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const first = finding({ id: 'finding-1', policy_type: 'Contact exchange' });
  const second = finding({ id: 'finding-2', policy_type: 'Private payment' });
  const client = fakeClient({
    intelligence: {
      listFindings: async (input: Record<string, unknown>) => {
        filters.push(input);
        return input.cursor ? { items: [second], next_cursor: '' } : { items: [first], next_cursor: 'cursor-2' };
      },
      getFinding: async () => ({
        session_id: 'session-1',
        finding: { ...first, rationale: 'Detailed finding rationale' },
        reviews: []
      }),
      reviewFinding: async (_findingId: string, input: Record<string, unknown>) => {
        reviews.push(input);
        return { session_id: 'session-1', finding: { ...first, review_status: input.review_status }, reviews: [] };
      }
    },
    chat: {}
  });
  const view = render(<ReviewQueue client={client} initialSessionId="session-1" />);

  await waitFor(() => assert.ok(view.getByText('Contact exchange')));
  fireEvent.change(view.getByLabelText('Finding severity'), { target: { value: 'high' } });
  fireEvent.change(view.getByLabelText('Finding source'), { target: { value: 'ocr' } });
  fireEvent.click(view.getByRole('button', { name: 'Apply filters' }));
  await waitFor(() => assert.equal(filters.at(-1)?.severity, 'high'));
  assert.equal(filters.at(-1)?.source, 'ocr');

  fireEvent.click(view.getByRole('button', { name: 'Load more findings' }));
  await waitFor(() => assert.ok(view.getByText('Private payment')));
  assert.equal(filters.at(-1)?.cursor, 'cursor-2');

  fireEvent.click(view.getByText('Contact exchange'));
  await waitFor(() => assert.ok(view.getByText('Detailed finding rationale')));
  const reason = view.getByLabelText('Review reason') as HTMLTextAreaElement;
  fireEvent.input(reason, { target: { value: 'Verified in context' } });
  await waitFor(() => assert.equal(reason.value, 'Verified in context'));
  fireEvent.click(view.getByRole('button', { name: 'Confirm finding' }));
  await waitFor(() => assert.deepEqual(reviews, [{ review_status: 'confirmed', note: 'Verified in context' }]));
});

test('review queue reports reviewer authorization denial without exposing raw payloads', async () => {
  const client = fakeClient({
    intelligence: { listFindings: async () => { throw Object.assign(new Error('internal response body'), { status: 403 }); } },
    chat: {}
  });
  const view = render(<ReviewQueue client={client} />);

  await waitFor(() => assert.ok(view.getByText('Review queue unavailable for your role')));
  assert.equal(view.queryByText('internal response body'), null);
});

function fakeClient(value: Record<string, unknown>): IveKitClient {
  return value as unknown as IveKitClient;
}

function finding(overrides: Partial<IveKitPolicyFinding> = {}): IveKitPolicyFinding {
  return {
    id: 'finding-1', tenant_id: 'tenant-1', session_id: 'session-1', message_id: 'message-1',
    source: 'text', source_ref_id: 'message-1', policy_type: 'Contact exchange', severity: 'medium',
    matched_text_hash: '', fingerprint: 'fingerprint-1', action: 'review', confidence: 0.8,
    rationale: 'Potential contact exchange', review_status: 'pending', evidence_refs: [], reviewed_by: '',
    detector_version: 'rules-v1', policy_version: 'policy-v1', evidence_snapshot_hash: 'snapshot-hash', content_version: 1,
    reviewed_at: null, review_note: '', metadata: {}, created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z', resolved_at: null,
    ...overrides
  };
}
