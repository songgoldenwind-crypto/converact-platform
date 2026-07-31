import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  DialogShadowJournal,
  DialogShadowJournalError
} from '../src/agent-runtime/converact/voice/dialog-shadow-journal.js';
import type {
  DialogShadowRecord
} from '../src/agent-runtime/converact/voice/dialog-shadow.js';
import {
  dialogShadowPairHash,
  dialogShadowRecordHash
} from '../src/agent-runtime/converact/voice/dialog-shadow.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function record(
  sequence = 1,
  overrides: Partial<DialogShadowRecord> = {}
): DialogShadowRecord {
  return {
    schema_version: 1,
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: 'dialog-a',
    call_id_hash: HASH_A,
    owner_node_id: 'rustpbx-a',
    owner_fault_domain: 'zone-a-rack-1',
    owner_epoch: 7,
    sequence,
    state: sequence === 1 ? 'early' : 'confirmed',
    local_tag: 'caller-tag',
    remote_tag: 'callee-tag',
    route_set: ['sip:edge-a.internal:5061;transport=tls;lr'],
    local_cseq: sequence,
    remote_cseq: sequence,
    branch_hash: HASH_B,
    final_response_hash: sequence === 1 ? null : HASH_C,
    auth_context_ref: 'auth-context-a',
    logical_offer_hash: HASH_C,
    logical_answer_hash: sequence === 1 ? null : HASH_D,
    media_reservation_id: 'reservation-a-caller',
    provider_session_ref: null,
    cdr_sequence: sequence,
    recorded_at: `2026-07-26T00:00:0${sequence}.000Z`,
    terminal: false,
    ...overrides
  };
}

async function temporaryJournal(
  t: TestContext,
  options: {
    maxRecords?: number;
    maxBytes?: number;
    maxRecordBytes?: number;
  } = {}
): Promise<{ journal: DialogShadowJournal; journalPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ivekit-dialog-shadow-'));
  const journalPath = path.join(directory, 'dialog-shadow.wal');
  const journal = await DialogShadowJournal.open({
    path: journalPath,
    ...options
  });
  t.after(async () => {
    await journal.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return { journal, journalPath };
}

test('dialog shadow WAL persists checksummed binary frames across restart', async (t) => {
  const { journal, journalPath } = await temporaryJournal(t);
  await journal.append(record());
  await journal.append(record(2));
  await journal.close();

  const bytes = await readFile(journalPath);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'IVDS');
  assert.equal(bytes.readUInt16BE(4), 1);
  assert.ok(bytes.readUInt32BE(8) > 0);
  assert.notEqual(bytes.readUInt32BE(12), 0);

  const reopened = await DialogShadowJournal.open({ path: journalPath });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.replay(), [record(), record(2)]);
});

test('dialog shadow WAL commits a recovery pair as one crash-atomic frame', async (t) => {
  const { journal, journalPath } = await temporaryJournal(t);
  const pair = [
    recoveryRecord('dialog-caller', 1),
    recoveryRecord('dialog-callee', 1)
  ] as const;

  const committed = await journal.appendPair(pair);
  assert.deepEqual(committed, {
    status: 'committed',
    pair_hash: dialogShadowPairHash(pair),
    record_hashes: pair.map((item) => dialogShadowRecordHash(item)).sort()
  });
  await journal.close();

  const bytes = await readFile(journalPath);
  assert.equal(16 + bytes.readUInt32BE(8), bytes.byteLength);
  const reopened = await DialogShadowJournal.open({ path: journalPath });
  t.after(() => reopened.close());
  assert.deepEqual(
    await reopened.replay(),
    [...pair].sort((left, right) => left.dialog_id.localeCompare(right.dialog_id))
  );
});

test('dialog shadow WAL discards an incomplete recovery-pair frame as a unit', async (t) => {
  const { journal, journalPath } = await temporaryJournal(t);
  const pair = [
    recoveryRecord('dialog-caller', 1),
    recoveryRecord('dialog-callee', 1)
  ] as const;
  await journal.appendPair(pair);
  await journal.close();

  const bytes = await readFile(journalPath);
  await writeFile(journalPath, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
  const reopened = await DialogShadowJournal.open({ path: journalPath });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.replay(), []);
  assert.equal((await readFile(journalPath)).byteLength, 0);
});

test('dialog shadow WAL returns only the latest v2 pair for a recovery session', async (t) => {
  const { journal } = await temporaryJournal(t);
  await journal.appendPair([
    recoveryRecord('dialog-caller', 1),
    recoveryRecord('dialog-callee', 1)
  ]);
  await journal.appendPair([
    recoveryRecord('dialog-caller', 2),
    recoveryRecord('dialog-callee', 2)
  ]);

  const pair = await journal.latestRecoveryPair({
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a'
  });

  assert.deepEqual(
    pair.map((item) => [item.dialog_id, item.sequence]),
    [['dialog-callee', 2], ['dialog-caller', 2]]
  );
});

test('dialog shadow WAL resolves the complete pair selected by owner authority', async (t) => {
  const { journal } = await temporaryJournal(t);
  const oldPair = [
    recoveryRecord('dialog-caller', 1),
    recoveryRecord('dialog-callee', 1)
  ] as const;
  const preparedPair = oldPair.map((item) => ({
    ...item,
    owner_node_id: 'rustpbx-b',
    owner_fault_domain: 'zone-b-rack-1',
    owner_epoch: 8,
    sequence: 1,
    recorded_at: '2026-07-26T00:01:00.000Z',
    takeover_id: 'dto-takeover-a'
  })) as [DialogShadowRecord, DialogShadowRecord];
  await journal.appendPair(oldPair);
  await journal.appendPair(preparedPair);

  const active = await journal.latestRecoveryPair({
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    owner_node_id: 'rustpbx-a',
    owner_epoch: 7
  });
  const prepared = await journal.latestRecoveryPair({
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    call_session_ref: 'call-session-a',
    owner_node_id: 'rustpbx-b',
    owner_epoch: 8,
    takeover_id: 'dto-takeover-a'
  });

  assert.deepEqual(
    active,
    [...oldPair].sort((left, right) => left.dialog_id.localeCompare(right.dialog_id))
  );
  assert.deepEqual(
    prepared,
    [...preparedPair].sort((left, right) => left.dialog_id.localeCompare(right.dialog_id))
  );
});

test('dialog shadow WAL resolves the authoritative recovery pair from either dialog ID', async (t) => {
  const { journal } = await temporaryJournal(t);
  await journal.appendPair([
    recoveryRecord('dialog-caller', 1),
    recoveryRecord('dialog-callee', 1)
  ]);
  await journal.appendPair([
    recoveryRecord('dialog-caller', 2),
    recoveryRecord('dialog-callee', 2)
  ]);

  for (const dialogId of ['dialog-caller', 'dialog-callee']) {
    const recovery = await journal.resolveRecoveryPair({
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      dialog_id: dialogId
    });
    assert.equal(recovery?.call_session_ref, 'call-session-a');
    assert.deepEqual(
      recovery?.records.map((item) => [item.dialog_id, item.sequence]),
      [['dialog-callee', 2], ['dialog-caller', 2]]
    );
  }
  assert.equal(
    await journal.resolveRecoveryPair({
      tenant_id: 'tenant-a',
      cell_id: 'cell-a',
      dialog_id: 'dialog-missing'
    }),
    null
  );
});

test('dialog shadow WAL repairs only a truncated tail and rejects checksum corruption', async (t) => {
  const { journal, journalPath } = await temporaryJournal(t);
  await journal.append(record());
  await journal.close();
  const committedSize = (await readFile(journalPath)).byteLength;

  await appendFile(journalPath, Buffer.from([0x49, 0x56, 0x44]));
  const repaired = await DialogShadowJournal.open({ path: journalPath });
  assert.deepEqual(await repaired.replay(), [record()]);
  await repaired.close();
  assert.equal((await readFile(journalPath)).byteLength, committedSize);

  const corrupted = await readFile(journalPath);
  corrupted[corrupted.length - 1] ^= 0xff;
  await writeFile(journalPath, corrupted);
  await assert.rejects(
    DialogShadowJournal.open({ path: journalPath }),
    (error) => code(error) === 'dialog_shadow_checksum_mismatch'
  );
});

function recoveryRecord(
  dialogId: string,
  sequence: number,
  sessionRef = 'call-session-a'
): DialogShadowRecord {
  return record(sequence, {
    schema_version: 2,
    dialog_id: dialogId,
    provider_session_ref: sessionRef,
    recovery_capsule: {
      schema_version: 1,
      algorithm: 'A256GCM',
      key_id: 'recovery-2026-07',
      nonce: Buffer.alloc(12, 0x11).toString('base64url'),
      ciphertext: Buffer.from('opaque').toString('base64url'),
      auth_tag: Buffer.alloc(16, 0x22).toString('base64url')
    }
  });
}

test('dialog shadow WAL enforces epoch, sequence and replay identity', async (t) => {
  const { journal } = await temporaryJournal(t);
  assert.equal((await journal.append(record())).status, 'committed');
  assert.equal((await journal.append(record())).status, 'replayed');
  assert.equal((await journal.replay()).length, 1);

  await assert.rejects(
    journal.append(record(1, { cdr_sequence: 9 })),
    (error) => code(error) === 'dialog_shadow_payload_mismatch'
  );
  await assert.rejects(
    journal.append(record(3)),
    (error) => code(error) === 'dialog_shadow_sequence_gap'
  );

  await journal.append(record(1, {
    owner_epoch: 8,
    sequence: 1,
    state: 'confirmed',
    recorded_at: '2026-07-26T00:01:00.000Z'
  }));
  await assert.rejects(
    journal.append(record(2)),
    (error) => code(error) === 'dialog_shadow_stale_owner_epoch'
  );
});

test('dialog shadow WAL compacts atomically and fails closed at hard capacity', async (t) => {
  const { journal, journalPath } = await temporaryJournal(t, {
    maxRecords: 3,
    maxBytes: 64 * 1024
  });
  await journal.append(record());
  await journal.append(record(2));
  await journal.append(record(3, {
    state: 'confirmed',
    final_response_hash: HASH_D
  }));
  await assert.rejects(
    journal.append(record(4)),
    (error) => code(error) === 'dialog_shadow_capacity_exceeded'
  );

  const result = await journal.compact();
  assert.deepEqual(result, { removed_records: 2, retained_records: 1 });
  assert.deepEqual(await journal.replay(), [record(3, {
    state: 'confirmed',
    final_response_hash: HASH_D
  })]);
  assert.equal((await readFile(journalPath)).subarray(0, 4).toString('ascii'), 'IVDS');
});

test('dialog shadow WAL rejects symlink targets and permissive files', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ivekit-dialog-shadow-safe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'target.wal');
  const linked = path.join(directory, 'linked.wal');
  await writeFile(target, '', { mode: 0o600 });
  await symlink(target, linked);
  await assert.rejects(
    DialogShadowJournal.open({ path: linked }),
    (error) => code(error) === 'dialog_shadow_path_unsafe'
  );

  const permissive = path.join(directory, 'permissive.wal');
  await writeFile(permissive, '', { mode: 0o644 });
  await assert.rejects(
    DialogShadowJournal.open({ path: permissive }),
    (error) => code(error) === 'dialog_shadow_permissions_invalid'
  );
});

function code(error: unknown): string {
  assert.ok(error instanceof DialogShadowJournalError);
  return error.code;
}
