import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { IveKitClient, IveKitMediaCall, IveKitMediaRecording } from '@opc/ivekit-sdk';
import { installTestDom } from '../test-dom.js';
import { RecordingPanel } from './recording-panel.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('recording panel is host-only for writes and shows evidence and retention state', async () => {
  const recording = item('completed');
  const client = fakeClient({ listRecordingsPage: async () => ({ items: [recording], next_cursor: null, has_more: false }) });
  const participantView = render(<RecordingPanel client={client} call={call()} role="participant" />);
  await waitFor(() => assert.ok(participantView.getByText('Completed')));
  assert.equal(participantView.queryByTitle('Start recording'), null);
  assert.ok(participantView.getByText('evidence-1'));
  assert.ok(participantView.getByText(/2027-01-01/));
});

test('recording panel renders active and terminal lifecycle states', async () => {
  const statuses: IveKitMediaRecording['status'][] = ['pending', 'recording', 'completed', 'failed', 'deleted'];
  const recordings = statuses.map((status, index) => ({
    ...item(status),
    id: `recording-${index}`,
    egress_id: `egress-${index}`
  }));
  const client = fakeClient({
    listRecordingsPage: async () => ({ items: recordings, next_cursor: null, has_more: false })
  });
  const view = render(<RecordingPanel client={client} call={call()} role="participant" pollMs={60_000} />);
  for (const status of statuses) {
    await waitFor(() => assert.ok(view.getByText(status.replace(/^./, (value) => value.toUpperCase()))));
  }
});

test('host starts and stops by egress id, then refreshes the call recording list', async () => {
  const calls: string[] = [];
  let recordings: IveKitMediaRecording[] = [];
  const active = item('recording');
  const client = fakeClient({
    listRecordingsPage: async (input) => { calls.push(`list:${input?.call_id}`); return { items: recordings, next_cursor: null, has_more: false }; },
    startRecording: async (_room, input) => { calls.push(`start:${input.media_call_id}`); recordings = [active]; return active; },
    stopRecording: async (egressId) => { calls.push(`stop:${egressId}`); recordings = [item('stopped')]; return recordings[0]; }
  });
  const view = render(<RecordingPanel client={client} call={call()} role="host" pollMs={60_000} />);
  await waitFor(() => assert.ok(view.getByTitle('Start recording')));
  fireEvent.click(view.getByTitle('Start recording'));
  await waitFor(() => assert.ok(view.getByText('Recording')));
  fireEvent.click(view.getByTitle('Stop recording'));
  await waitFor(() => assert.ok(view.getByText('Stopped')));
  assert.deepEqual(calls.filter((value) => !value.startsWith('list:')), ['start:call-1', 'stop:egress-1']);
});

test('active recording polls until completion and object inspection is explicit', async () => {
  let loads = 0;
  let inspections = 0;
  const client = fakeClient({
    listRecordingsPage: async () => {
      loads += 1;
      return { items: [item(loads < 2 ? 'pending' : 'completed')], next_cursor: null, has_more: false };
    },
    inspectRecordingObject: async () => { inspections += 1; return { status: 'readable', readable: true, source: 's3', size_bytes: 42, checksum: 'sha256:test' }; }
  });
  const view = render(<RecordingPanel client={client} call={call()} role="host" pollMs={10} />);
  await waitFor(() => assert.ok(view.getByText('Completed')));
  const settledLoads = loads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(loads, settledLoads);
  fireEvent.click(view.getByTitle('Inspect recording object'));
  await waitFor(() => assert.ok(view.getByText('42 bytes')));
  assert.equal(inspections, 1);
});

test('active recording shows elapsed time when provider duration is not final', async () => {
  const pending = {
    ...item('pending'),
    duration_ms: null,
    created_at: new Date(Date.now() - 5_000).toISOString()
  };
  const client = fakeClient({
    listRecordingsPage: async () => ({ items: [pending], next_cursor: null, has_more: false })
  });
  const view = render(<RecordingPanel client={client} call={call()} role="participant" pollMs={60_000} />);
  await waitFor(() => assert.match(view.getByText(/elapsed/i).textContent || '', /[4-6]s elapsed/i));
});

test('unsupported exported content is not mounted as playable media', async () => {
  const readable = item('completed');
  const client = fakeClient({
    listRecordingsPage: async () => ({ items: [readable], next_cursor: null, has_more: false }),
    exportRecordingObject: async () => ({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'application/octet-stream',
      filename: 'recording.bin'
    })
  });
  const view = render(<RecordingPanel client={client} call={call()} role="participant" />);
  await waitFor(() => assert.ok(view.getByTitle('Play recording')));
  fireEvent.click(view.getByTitle('Play recording'));
  await waitFor(() => assert.match(view.getByRole('alert').textContent || '', /cannot play/i));
  assert.equal(view.container.querySelector('audio,video'), null);
});

test('authorization loss stops active recording polling', async () => {
  let loads = 0;
  const client = fakeClient({
    listRecordingsPage: async () => {
      loads += 1;
      if (loads > 1) throw Object.assign(new Error('membership removed'), { status: 403 });
      return { items: [item('recording')], next_cursor: null, has_more: false };
    }
  });
  const view = render(<RecordingPanel client={client} call={call()} role="host" pollMs={10} />);
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('membership removed')));
  const stoppedAt = loads;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(loads, stoppedAt);
});

function fakeClient(overrides: Partial<IveKitClient['media']>): IveKitClient {
  return { media: { ...overrides } } as IveKitClient;
}

function call(): IveKitMediaCall {
  return {
    id: 'call-1', tenant_id: 'tenant-1', room_name: 'room-1', media: 'video', status: 'active', initiated_by: 'host-1',
    business_ref: { type: 'order', id: 'order-1', metadata: {} }, title: 'Support', metadata: {}, ring_timeout_seconds: 30,
    ring_expires_at: null, accepted_at: '2026-07-12T00:00:00Z', started_at: '2026-07-12T00:00:01Z', ended_at: null,
    end_reason: '', created_at: '2026-07-12T00:00:00Z', updated_at: '2026-07-12T00:00:01Z'
  };
}

function item(status: IveKitMediaRecording['status']): IveKitMediaRecording {
  return {
    id: 'recording-1', tenant_id: 'tenant-1', call_session_id: '', media_call_id: 'call-1', room_name: 'room-1',
    business_ref_type: 'order', business_ref_id: 'order-1', business_ref: { type: 'order', id: 'order-1', metadata: {} },
    source: 'livekit_egress', format: 'mp4', duration_ms: 5_000,
    file_size_bytes: 42, has_video: 1, egress_id: 'egress-1', status, retention_until: '2027-01-01T00:00:00Z',
    object_status: status === 'completed' ? 'readable' : 'unchecked', object_checked_at: null, failure_code: '',
    completed_at: status === 'completed' ? '2026-07-12T00:01:00Z' : null, deleted_at: null,
    updated_at: '2026-07-12T00:01:00Z', created_at: '2026-07-12T00:00:00Z', evidence_record_id: 'evidence-1'
  };
}
