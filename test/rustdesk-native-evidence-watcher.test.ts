import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RustDeskNativeEvidenceWatcher,
  type RustDeskNativeEvidenceWatcherConfig
} from '../scripts/rustdesk-native-evidence-watcher.js';

test('native evidence watcher stages a stable authorized recording exactly once', async (t) => {
  const fixture = createFixture(t);
  const source = join(fixture.recordingRoot, 'session.webm');
  writeFileSync(source, 'stable-recording');
  fixture.writeEvent('recording-event.json', recordingEvent(source));

  const watcher = await RustDeskNativeEvidenceWatcher.open(fixture.config);
  t.after(() => watcher.close());
  assert.deepEqual(await watcher.pollOnce(), {
    ingested: 1,
    staged: 0,
    waiting: 1,
    quarantined: 0
  });
  fixture.advance(2_000);
  assert.deepEqual(await watcher.pollOnce(), {
    ingested: 0,
    staged: 1,
    waiting: 0,
    quarantined: 0
  });

  const manifests = fixture.jsonFiles(fixture.evidenceDir);
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(readFileSync(join(fixture.evidenceDir, manifests[0]), 'utf8'));
  assert.equal(manifest.native_event_id, 'native-recording-1');
  assert.equal(manifest.authorization_scope, 'session');
  assert.equal(manifest.authorization_id, 'rdgw-native-1');
  assert.equal(manifest.interaction_id, 'remote-session-native-1');
  assert.equal(manifest.reservation_id, 'reservation-native-1');
  assert.equal(manifest.owner_epoch, '101');
  assert.equal(manifest.source_origin, 'rustdesk_native_event');
  assert.equal(
    readFileSync(join(fixture.evidenceDir, manifest.payload_filename), 'utf8'),
    'stable-recording'
  );

  fixture.writeEvent('recording-replay.json', recordingEvent(source));
  assert.deepEqual(await watcher.pollOnce(), {
    ingested: 0,
    staged: 0,
    waiting: 0,
    quarantined: 0
  });
  assert.equal(fixture.jsonFiles(fixture.evidenceDir).length, 1);
});

test('native evidence watcher rejects path escape, symbolic links, and unsupported event types', async (t) => {
  const fixture = createFixture(t);
  const outside = join(fixture.root, 'outside.bin');
  writeFileSync(outside, 'outside');
  fixture.writeEvent('outside.json', fileEvent(outside, 'native-outside'));

  const target = join(fixture.fileRoot, 'target.bin');
  const link = join(fixture.fileRoot, 'link.bin');
  writeFileSync(target, 'target');
  symlinkSync(target, link);
  fixture.writeEvent('link.json', fileEvent(link, 'native-link'));
  fixture.writeEvent('clipboard.json', {
    ...fileEvent(target, 'native-clipboard'),
    event_type: 'clipboard_synced'
  });

  const watcher = await RustDeskNativeEvidenceWatcher.open(fixture.config);
  t.after(() => watcher.close());
  assert.deepEqual(await watcher.pollOnce(), {
    ingested: 0,
    staged: 0,
    waiting: 0,
    quarantined: 3
  });
  assert.equal(fixture.jsonFiles(join(fixture.eventDir, 'quarantine')).length, 3);
  assert.equal(fixture.jsonFiles(fixture.evidenceDir).length, 0);
});

test('native evidence watcher waits for file stability and resets its timer after mutation', async (t) => {
  const fixture = createFixture(t);
  const source = join(fixture.fileRoot, 'growing.bin');
  writeFileSync(source, 'part-one');
  fixture.writeEvent('growing.json', fileEvent(source, 'native-growing'));
  const watcher = await RustDeskNativeEvidenceWatcher.open(fixture.config);
  t.after(() => watcher.close());

  assert.equal((await watcher.pollOnce()).waiting, 1);
  fixture.advance(1_500);
  writeFileSync(source, 'part-one-part-two');
  assert.equal((await watcher.pollOnce()).waiting, 1);
  fixture.advance(1_500);
  assert.equal((await watcher.pollOnce()).waiting, 1);
  fixture.advance(500);
  assert.equal((await watcher.pollOnce()).staged, 1);
});

test('native evidence watcher rejects source mutation during managed copy', async (t) => {
  const fixture = createFixture(t, 0);
  const source = join(fixture.fileRoot, 'mutating.bin');
  writeFileSync(source, 'before-copy');
  fixture.writeEvent('mutating.json', fileEvent(source, 'native-mutating'));
  const watcher = await RustDeskNativeEvidenceWatcher.open(fixture.config, {
    copyFile: async (from, to) => {
      await copyFile(from, to);
      writeFileSync(from, 'after-copy-is-different');
    }
  });
  t.after(() => watcher.close());

  assert.deepEqual(await watcher.pollOnce(), {
    ingested: 1,
    staged: 0,
    waiting: 0,
    quarantined: 1
  });
  assert.equal(fixture.jsonFiles(fixture.evidenceDir).length, 0);
  assert.equal(fixture.jsonFiles(join(fixture.eventDir, 'quarantine')).length, 1);
});

test('native evidence watcher restores staged idempotency state across restart', async (t) => {
  const fixture = createFixture(t, 0);
  const source = join(fixture.recordingRoot, 'restart.webm');
  writeFileSync(source, 'restart-recording');
  fixture.writeEvent('first.json', recordingEvent(source));
  const first = await RustDeskNativeEvidenceWatcher.open(fixture.config);
  assert.equal((await first.pollOnce()).staged, 1);
  await first.close();

  fixture.writeEvent('replay.json', recordingEvent(source));
  const reopened = await RustDeskNativeEvidenceWatcher.open(fixture.config);
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.pollOnce(), {
    ingested: 0,
    staged: 0,
    waiting: 0,
    quarantined: 0
  });
});

function recordingEvent(sourcePath: string) {
  return {
    schema_version: 1,
    native_event_id: 'native-recording-1',
    event_type: 'screen_recording_completed',
    external_id: 'rdgw-native-1',
    operation_id: 'recording-native-1',
    authorization_scope: 'session',
    authorization_id: 'rdgw-native-1',
    interaction_id: 'remote-session-native-1',
    reservation_id: 'reservation-native-1',
    owner_epoch: '101',
    source_path: sourcePath,
    filename: 'session.webm',
    declared_mime: 'video/webm',
    observed_at: '2026-07-16T00:00:00.000Z'
  };
}

function fileEvent(sourcePath: string, nativeEventId: string) {
  return {
    schema_version: 1,
    native_event_id: nativeEventId,
    event_type: 'file_transfer_completed',
    external_id: 'rdgw-native-1',
    operation_id: `transfer-${nativeEventId}`,
    authorization_scope: 'operation',
    authorization_id: `rdop-${nativeEventId}`,
    interaction_id: 'remote-session-native-1',
    reservation_id: 'reservation-native-1',
    owner_epoch: '101',
    source_path: sourcePath,
    filename: 'transfer.bin',
    declared_mime: 'application/octet-stream',
    observed_at: '2026-07-16T00:00:00.000Z',
    direction: 'download',
    control_version: 3
  };
}

function createFixture(t: { after(fn: () => void | Promise<void>): void }, stableMs = 2_000) {
  const root = mkdtempSync(join(tmpdir(), 'rustdesk-native-evidence-'));
  const eventDir = join(root, 'events');
  const evidenceDir = join(root, 'evidence');
  const spoolDir = join(root, 'spool');
  const fileRoot = join(root, 'files');
  const recordingRoot = join(root, 'recordings');
  for (const path of [eventDir, evidenceDir, spoolDir, fileRoot, recordingRoot]) {
    mkdirSync(path, { recursive: true });
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let nowMs = Date.parse('2026-07-16T00:00:00.000Z');
  const config: RustDeskNativeEvidenceWatcherConfig = {
    eventDirectory: eventDir,
    evidenceDirectory: evidenceDir,
    spoolDirectory: spoolDir,
    fileRoots: [fileRoot],
    recordingRoots: [recordingRoot],
    stableMs,
    maxFileBytes: 1_024 * 1_024,
    maxEventBytes: 64 * 1_024,
    maxQuarantineRecords: 100,
    now: () => new Date(nowMs)
  };
  return {
    root,
    eventDir,
    evidenceDir,
    fileRoot,
    recordingRoot,
    config,
    advance(ms: number) { nowMs += ms; },
    writeEvent(name: string, value: unknown) {
      writeFileSync(join(eventDir, name), `${JSON.stringify(value)}\n`);
    },
    jsonFiles(directory: string) {
      return readdirSync(directory).filter((name) => name.endsWith('.json'));
    }
  };
}
