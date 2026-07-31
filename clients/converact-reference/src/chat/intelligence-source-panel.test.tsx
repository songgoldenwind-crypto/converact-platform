import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { IveKitClient, IveKitIntelligenceSourceSnapshot } from '@converact/sdk';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { installTestDom } from '../test-dom.js';
import { IntelligenceSourcePanel } from './intelligence-source-panel.js';

let closeDom: () => void;

before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('recording source import uses stable IDs and refreshes processing status', async () => {
  const imports: Array<Record<string, unknown>> = [];
  let current = snapshot('pending');
  const client = fakeClient({
    importSource: async (sessionId: string, input: Record<string, unknown>, options: { idempotencyKey: string }) => {
      imports.push({ sessionId, ...input, idempotencyKey: options.idempotencyKey });
      return current;
    },
    getSource: async () => current
  });
  const view = render(<IntelligenceSourcePanel client={client} initialSessionId="session-1" refreshVersion={0} />);

  fireEvent.change(view.getByLabelText('Recording source type'), { target: { value: 'remote_recording' } });
  fireEvent.input(view.getByLabelText('Recording source ID'), { target: { value: 'evidence-1' } });
  fireEvent.click(view.getByRole('button', { name: 'Import recording' }));

  await waitFor(() => assert.equal(imports.length, 1));
  assert.equal(imports[0].sessionId, 'session-1');
  assert.equal(imports[0].source_type, 'remote_recording');
  assert.equal(imports[0].source_ref_id, 'evidence-1');
  assert.ok(imports[0].idempotencyKey);
  assert.ok(await view.findByText('Pending'));

  current = snapshot('succeeded');
  view.rerender(<IntelligenceSourcePanel client={client} initialSessionId="session-1" refreshVersion={1} />);
  await waitFor(() => assert.ok(view.getByText('Succeeded')));
});

test('failed recording source exposes an explicit manual retry', async () => {
  const retries: string[] = [];
  const failed = snapshot('failed', 'provider_unavailable');
  const client = fakeClient({
    importSource: async () => failed,
    getSource: async () => failed,
    retrySource: async (_sessionId: string, sourceId: string) => {
      retries.push(sourceId);
      return snapshot('pending');
    }
  });
  const view = render(<IntelligenceSourcePanel client={client} initialSessionId="session-1" />);
  fireEvent.input(view.getByLabelText('Recording source ID'), { target: { value: 'recording-1' } });
  fireEvent.click(view.getByRole('button', { name: 'Import recording' }));
  await waitFor(() => assert.ok(view.getByText('Failed')));
  fireEvent.click(view.getByRole('button', { name: 'Retry recording processing' }));
  await waitFor(() => assert.deepEqual(retries, ['source-1']));
});

function fakeClient(intelligence: Record<string, unknown>): IveKitClient {
  return { intelligence } as unknown as IveKitClient;
}

function snapshot(status: 'pending' | 'succeeded' | 'failed', errorCode = ''): IveKitIntelligenceSourceSnapshot {
  return {
    source: { id: 'source-1', session_id: 'session-1', status, error_code: errorCode },
    message_id: 'message-1', replayed: false,
    attachment: { id: 'attachment-1', processing_status: status === 'succeeded' ? 'ready' : status },
    processing_job: null,
    findings: []
  };
}
