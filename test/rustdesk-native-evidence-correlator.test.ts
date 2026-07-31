import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RustDeskNativeEvidenceCorrelator,
  type RustDeskNativeEvidenceContext
} from '../scripts/rustdesk-native-evidence-correlator.js';

test('native evidence correlator maps one controller-bound file candidate into an authorized event', async (t) => {
  const fixture = createFixture(t);
  const source = join(fixture.fileRoot, 'transfer.bin');
  writeFileSync(source, 'native file bytes');
  fixture.writeCandidate('candidate-file.json', {
    schema_version: 1,
    native_candidate_id: 'candidate-file-1',
    root_class: 'file',
    source_path: source,
    filename: 'transfer.bin',
    size_bytes: 17,
    observed_unix_ms: Date.parse('2026-07-16T00:01:00.000Z'),
    controller_rustdesk_ids: ['135792468']
  });

  const correlator = await RustDeskNativeEvidenceCorrelator.open(fixture.config);
  assert.deepEqual(await correlator.pollOnce(context()), {
    correlated: 1,
    waiting: 0,
    quarantined: 0
  });

  const eventFiles = readdirSync(fixture.eventDir).filter((name) => name.endsWith('.json'));
  assert.equal(eventFiles.length, 1);
  const event = JSON.parse(readFileSync(join(fixture.eventDir, eventFiles[0]), 'utf8'));
  assert.deepEqual(event, {
    schema_version: 1,
    native_event_id: 'candidate-file-1:file-transfer-1',
    event_type: 'file_transfer_completed',
    external_id: 'rdgw-native-1',
    operation_id: 'file-transfer-1',
    authorization_scope: 'operation',
    authorization_id: 'rdop-file-transfer-1',
    interaction_id: 'remote-session-native-1',
    reservation_id: 'reservation-native-1',
    owner_epoch: '91',
    source_path: source,
    filename: 'transfer.bin',
    declared_mime: 'application/octet-stream',
    observed_at: '2026-07-16T00:01:00.000Z',
    direction: 'upload',
    control_version: 3
  });
  assert.equal(readdirSync(fixture.candidateDir).filter((name) => name.endsWith('.json')).length, 0);
});

test('native evidence correlator waits on ambiguous bindings and quarantines expired candidates', async (t) => {
  const fixture = createFixture(t);
  const source = join(fixture.recordingRoot, 'session.webm');
  writeFileSync(source, 'recording bytes');
  fixture.writeCandidate('candidate-recording.json', {
    schema_version: 1,
    native_candidate_id: 'candidate-recording-1',
    root_class: 'recording',
    source_path: source,
    filename: 'session.webm',
    size_bytes: 15,
    observed_unix_ms: Date.parse('2026-07-16T00:01:00.000Z'),
    controller_rustdesk_ids: ['135792468']
  });
  const duplicate = context();
  duplicate.bindings = [
    recordingBinding('recording-1'),
    recordingBinding('recording-2')
  ];

  const correlator = await RustDeskNativeEvidenceCorrelator.open(fixture.config);
  assert.deepEqual(await correlator.pollOnce(duplicate), {
    correlated: 0,
    waiting: 1,
    quarantined: 0
  });
  fixture.advance(15 * 60_000 + 1);
  assert.deepEqual(await correlator.pollOnce(duplicate), {
    correlated: 0,
    waiting: 0,
    quarantined: 1
  });
  assert.equal(readdirSync(join(fixture.candidateDir, 'quarantine')).length, 1);
  assert.equal(readdirSync(fixture.eventDir).filter((name) => name.endsWith('.json')).length, 0);
});

function context(): RustDeskNativeEvidenceContext {
  return {
    schema_version: 1,
    device_id: 'rddev-native-1',
    rustdesk_id: '246813579',
    generated_at: '2026-07-16T00:01:00.000Z',
    expires_at: '2026-07-16T00:02:00.000Z',
    bindings: [{
      kind: 'file',
      external_id: 'rdgw-native-1',
      controller_rustdesk_id: '135792468',
      operation_id: 'file-transfer-1',
      authorization_scope: 'operation',
      authorization_id: 'rdop-file-transfer-1',
      interaction_id: 'remote-session-native-1',
      reservation_id: 'reservation-native-1',
      owner_epoch: '91',
      direction: 'upload',
      control_version: 3,
      started_at: '2026-07-16T00:00:00.000Z',
      valid_until: '2026-07-16T00:15:00.000Z',
      file_name: 'transfer.bin'
    }]
  };
}

function recordingBinding(operationId: string): RustDeskNativeEvidenceContext['bindings'][number] {
  return {
    kind: 'screen_recording',
    external_id: 'rdgw-native-1',
    controller_rustdesk_id: '135792468',
    operation_id: operationId,
    authorization_scope: 'session',
    authorization_id: 'rdgw-native-1',
    started_at: '2026-07-16T00:00:00.000Z',
    valid_until: '2026-07-16T00:15:00.000Z'
  };
}

function createFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'rustdesk-native-correlator-'));
  const candidateDir = join(root, 'candidates');
  const eventDir = join(root, 'events');
  const fileRoot = join(root, 'files');
  const recordingRoot = join(root, 'recordings');
  for (const path of [candidateDir, eventDir, fileRoot, recordingRoot]) {
    mkdirSync(path, { recursive: true });
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-07-16T00:01:00.000Z');
  return {
    candidateDir,
    eventDir,
    fileRoot,
    recordingRoot,
    config: {
      candidateDirectory: candidateDir,
      eventDirectory: eventDir,
      maxCandidateBytes: 64 * 1_024,
      maxPendingMs: 15 * 60_000,
      maxQuarantineRecords: 100,
      now: () => new Date(now)
    },
    advance(ms: number) { now += ms; },
    writeCandidate(name: string, value: unknown) {
      writeFileSync(join(candidateDir, name), `${JSON.stringify(value)}\n`);
    }
  };
}
