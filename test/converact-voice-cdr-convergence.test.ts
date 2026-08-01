import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';
import {
  mergeVoiceCdrProjection,
  parseVoiceDualLegCdr,
  PostgresVoiceCdrConvergenceStore,
  createPostgresVoiceHttpModule,
  routeConveractFabricVoiceApi,
  type VoiceCdrDurabilityContract,
  type VoiceCdrProjection,
  type VoiceHttpModule
} from '../src/agent-runtime/converact/voice/index.js';

const STARTED_AT = '2026-07-27T01:00:00.000Z';
const ANSWERED_AT = '2026-07-27T01:00:02.000Z';
const ENDED_AT = '2026-07-27T01:01:00.000Z';
const MIGRATION = 'src/migrations/103_ivekit_voice_cdr_convergence.sql';
const POSTGRES_STORE =
  'src/agent-runtime/converact/voice/postgres/cdr-convergence-store.ts';

const durability: VoiceCdrDurabilityContract = {
  id: 'cdr-contract-1',
  region_id: 'region-cn-1',
  fault_domains: ['zone-a', 'zone-b', 'zone-c'],
  quorum_size: 2,
  status: 'active'
};

test('dual-leg CDR remains pending until both legs reach a durable Region contract', () => {
  const caller = parseVoiceDualLegCdr(cdrFixture({
    sequence: '7',
    legs: [legFixture('caller')]
  }));
  const first = mergeVoiceCdrProjection(null, caller, durability);

  assert.equal(first.outcome, 'accepted');
  assert.equal(first.projection.state, 'pending_unacknowledged');
  assert.equal(first.emit_billing_event, false);
  assert.deepEqual(Object.keys(first.projection.legs), ['caller']);

  const callee = parseVoiceDualLegCdr(cdrFixture({
    sequence: '8',
    legs: [legFixture('callee')]
  }));
  const second = mergeVoiceCdrProjection(first.projection, callee, durability);

  assert.equal(second.outcome, 'accepted');
  assert.equal(second.projection.state, 'committed');
  assert.equal(second.emit_billing_event, true);
  assert.deepEqual(Object.keys(second.projection.legs).sort(), ['callee', 'caller']);
  assert.equal(second.projection.legs.caller?.sequence, '7');
  assert.equal(second.projection.legs.callee?.sequence, '8');
});

test('exact replay does not duplicate billing', () => {
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const committed = mergeVoiceCdrProjection(null, envelope, durability);
  const projection: VoiceCdrProjection = {
    ...committed.projection,
    billing_event_id: 'billing-event-1'
  };
  const replay = mergeVoiceCdrProjection(projection, envelope, durability);

  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.projection.state, 'committed');
  assert.equal(replay.projection.billing_event_id, 'billing-event-1');
  assert.equal(replay.emit_billing_event, false);
});

test('higher sequence updates one leg without losing the other leg', () => {
  const initial = mergeVoiceCdrProjection(
    null,
    parseVoiceDualLegCdr(cdrFixture({
      sequence: '10',
      legs: [legFixture('caller'), legFixture('callee')]
    })),
    durability
  );
  const projection: VoiceCdrProjection = {
    ...initial.projection,
    billing_event_id: 'billing-event-1'
  };
  const callerUpdate = parseVoiceDualLegCdr(cdrFixture({
    sequence: '11',
    call: { media_timeout: true },
    legs: [legFixture('caller', { media_result: 'timeout' })]
  }));
  const updated = mergeVoiceCdrProjection(projection, callerUpdate, durability);

  assert.equal(updated.outcome, 'accepted');
  assert.equal(updated.projection.highest_sequence, '11');
  assert.equal(updated.projection.legs.caller?.media_result, 'timeout');
  assert.equal(updated.projection.legs.callee?.sequence, '10');
  assert.equal(updated.projection.billing_event_id, 'billing-event-1');
  assert.equal(updated.emit_billing_event, false);
});

test('lower sequence is stale and cannot overwrite a newer CDR', () => {
  const newer = mergeVoiceCdrProjection(
    null,
    parseVoiceDualLegCdr(cdrFixture({
      sequence: '12',
      legs: [legFixture('caller'), legFixture('callee')]
    })),
    durability
  ).projection;
  const stale = mergeVoiceCdrProjection(
    newer,
    parseVoiceDualLegCdr(cdrFixture({
      sequence: '11',
      legs: [legFixture('caller', { media_result: 'failed' })]
    })),
    durability
  );

  assert.equal(stale.outcome, 'stale');
  assert.equal(stale.projection.highest_sequence, '12');
  assert.equal(stale.projection.legs.caller?.media_result, 'relayed');
  assert.equal(stale.emit_billing_event, false);
});

test('lower sequence can fill a missing leg without overwriting newer call data', () => {
  const calleeFirst = mergeVoiceCdrProjection(
    null,
    parseVoiceDualLegCdr(cdrFixture({
      sequence: '12',
      call: { media_timeout: true },
      legs: [legFixture('callee', { media_result: 'timeout' })]
    })),
    durability
  ).projection;
  const callerLate = mergeVoiceCdrProjection(
    calleeFirst,
    parseVoiceDualLegCdr(cdrFixture({
      sequence: '11',
      call: { media_timeout: false },
      legs: [legFixture('caller')]
    })),
    durability
  );

  assert.equal(callerLate.outcome, 'accepted');
  assert.equal(callerLate.projection.highest_sequence, '12');
  assert.equal(callerLate.projection.call.media_timeout, true);
  assert.equal(callerLate.projection.legs.caller?.sequence, '11');
  assert.equal(callerLate.projection.legs.callee?.sequence, '12');
  assert.equal(callerLate.projection.state, 'committed');
  assert.equal(callerLate.emit_billing_event, true);
});

test('same sequence with a different payload is rejected', () => {
  const original = mergeVoiceCdrProjection(
    null,
    parseVoiceDualLegCdr(cdrFixture({
      sequence: '13',
      legs: [legFixture('caller'), legFixture('callee')]
    })),
    durability
  ).projection;

  assert.throws(
    () => mergeVoiceCdrProjection(
      original,
      parseVoiceDualLegCdr(cdrFixture({
        sequence: '13',
        call: { media_timeout: true },
        legs: [legFixture('caller'), legFixture('callee')]
      })),
      durability
    ),
    (error: unknown) => voiceError(error, 'event_sequence_conflict', 409)
  );
});

test('pending sequence can become committed when Region durability recovers', () => {
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '14',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const unavailable: VoiceCdrDurabilityContract = {
    ...durability,
    status: 'unavailable'
  };
  const pending = mergeVoiceCdrProjection(null, envelope, unavailable);
  const recovered = mergeVoiceCdrProjection(pending.projection, envelope, durability);

  assert.equal(pending.projection.state, 'pending_unacknowledged');
  assert.equal(recovered.outcome, 'accepted');
  assert.equal(recovered.projection.state, 'committed');
  assert.equal(recovered.emit_billing_event, true);
});

test('client cannot claim committed state', () => {
  assert.throws(
    () => parseVoiceDualLegCdr(cdrFixture({
      state: 'committed',
      legs: [legFixture('caller')]
    })),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
});

test('CDR accepts a standards-shaped SIP Call-ID without weakening internal identifiers', () => {
  const parsed = parseVoiceDualLegCdr({
    ...cdrFixture({ legs: [legFixture('caller')] }),
    provider_call_id: 'call-1@example.invalid'
  });

  assert.equal(parsed.provider_call_id, 'call-1@example.invalid');
  assert.throws(
    () => parseVoiceDualLegCdr({
      ...cdrFixture({ legs: [legFixture('caller')] }),
      interaction_id: 'interaction@example.invalid'
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
});

test('CDR envelope binds the emitting Cell, node, availability profile and owner epoch', () => {
  const parsed = parseVoiceDualLegCdr({
    ...cdrFixture({ legs: [legFixture('caller'), legFixture('callee')] }),
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    availability_profile: 'VOICE-HA-T1',
    owner_epoch: '7'
  });

  assert.equal(parsed.cell_id, 'cell-a');
  assert.equal(parsed.owner_node_id, 'rustpbx-a');
  assert.equal(parsed.availability_profile, 'VOICE-HA-T1');
  assert.equal(parsed.owner_epoch, '7');
  assert.equal(parsed.expected_region_id, 'region-cn-1');
  assert.equal(parsed.legs.every((leg) => leg.owner_epoch === parsed.owner_epoch), true);
  assert.throws(
    () => parseVoiceDualLegCdr({
      ...cdrFixture({
        legs: [legFixture('caller', { owner_epoch: '8' })]
      }),
      owner_epoch: '7'
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
});

test('CDR expected Region is hash-bound and rejected before the wrong Region can write', async () => {
  const envelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '9',
      legs: [legFixture('caller'), legFixture('callee')]
    }),
    expected_region_id: 'region-cn-2'
  });
  const pg = new ScriptedPg([]);

  await assert.rejects(
    cdrStore(pg, 'region-cn-1').converge({
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      authoritative_availability_profile: envelope.availability_profile,
      envelope
    }),
    (error: unknown) => voiceError(error, 'event_sequence_conflict', 409)
  );
  pg.assertDone();
});

test('CDR decimal fields reject values outside runtime and PostgreSQL authority bounds', () => {
  assert.throws(
    () => parseVoiceDualLegCdr({
      ...cdrFixture({
        sequence: '9007199254740992',
        legs: [legFixture('caller'), legFixture('callee')]
      }),
      cell_id: 'cell-a',
      owner_node_id: 'rustpbx-a',
      availability_profile: 'VOICE-ORDINARY',
      owner_epoch: '7'
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
  assert.throws(
    () => parseVoiceDualLegCdr({
      ...cdrFixture({
        legs: [
          legFixture('caller', { owner_epoch: '4294967296' }),
          legFixture('callee', { owner_epoch: '4294967296' })
        ]
      }),
      cell_id: 'cell-a',
      owner_node_id: 'rustpbx-a',
      availability_profile: 'VOICE-HA-T1',
      owner_epoch: '4294967296'
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
  assert.throws(
    () => parseVoiceDualLegCdr({
      ...cdrFixture({
        legs: [
          legFixture('caller', { route_snapshot_revision: '9007199254740992' }),
          legFixture('callee', { route_snapshot_revision: '9007199254740992' })
        ]
      }),
      cell_id: 'cell-a',
      owner_node_id: 'rustpbx-a',
      availability_profile: 'VOICE-ORDINARY',
      owner_epoch: '7'
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
});

test('CDR accepts only hashed dialog identities and rejects extra PII or SDP fields', () => {
  assert.throws(
    () => parseVoiceDualLegCdr(cdrFixture({
      legs: [legFixture('caller', { dialog_id_hash: 'raw-call-id@carrier.example' })]
    })),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
  assert.throws(
    () => parseVoiceDualLegCdr({
      ...cdrFixture({ legs: [legFixture('caller')] }),
      phone_number: '+8613800138000'
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
  assert.throws(
    () => parseVoiceDualLegCdr({
      ...cdrFixture({ legs: [legFixture('caller')] }),
      sdp: 'v=0'
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
});

test('durability requires active quorum across at least two distinct fault domains', () => {
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '15',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const sameZone = mergeVoiceCdrProjection(null, envelope, {
    ...durability,
    fault_domains: ['zone-a', 'zone-a'],
    quorum_size: 2
  });
  const noQuorum = mergeVoiceCdrProjection(null, envelope, {
    ...durability,
    fault_domains: ['zone-a', 'zone-b'],
    quorum_size: 1
  });

  assert.equal(sameZone.projection.state, 'pending_unacknowledged');
  assert.equal(noQuorum.projection.state, 'pending_unacknowledged');
});

test('CDR migration stores durability, call convergence and both legs with tenant RLS', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_durability_contracts/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_calls/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_legs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_submissions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_receipts/);
  assert.match(sql, /fault_domains TEXT\[\] NOT NULL/);
  assert.match(sql, /quorum_size SMALLINT NOT NULL/);
  assert.match(sql, /state IN \('pending_unacknowledged', 'committed'\)/);
  assert.match(sql, /UNIQUE \(tenant_id, billing_key\)/);
  assert.match(
    sql,
    /to_regclass\('public\.uq_ivekit_tenant_events_tenant_id'\)/
  );
  assert.match(
    sql,
    /UNIQUE USING INDEX uq_ivekit_tenant_events_tenant_id/
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX CONCURRENTLY uq_ivekit_tenant_events_tenant_id/
  );
  assert.match(
    sql,
    /requires the prebuilt concurrent unique index/
  );
  assert.match(sql, /latest_payload_hash TEXT NOT NULL/);
  assert.match(sql, /highest_sequence BIGINT NOT NULL/);
  assert.match(sql, /acknowledged_sequence BIGINT NOT NULL/);
  assert.match(sql, /committed_sequence BIGINT NOT NULL/);
  assert.match(sql, /acknowledged_payload_hash TEXT NOT NULL/);
  assert.match(sql, /terminal_cdr_call_id TEXT/);
  assert.match(sql, /terminal_cdr_receipt_id TEXT/);
  assert.match(sql, /terminal_cdr_region_id TEXT/);
  assert.match(sql, /terminal_cdr_durability_contract_id TEXT/);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, terminal_cdr_receipt_id\)/
  );
  assert.match(
    sql,
    /REFERENCES ivekit_voice_cdr_receipts\(tenant_id, receipt_id\)/
  );
  assert.match(sql, /PRIMARY KEY \(tenant_id, call_id, acknowledged_sequence\)/);
  assert.match(sql, /UNIQUE \(id, region_id\)/);
  assert.match(sql, /UNIQUE \(tenant_id, id\)/);
  assert.match(sql, /FOREIGN KEY \(durability_contract_id, region_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, billing_event_id\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, call_id, billing_event_id\)/);
  assert.match(
    sql,
    /ivekit_voice_cdr_calls\(tenant_id, billing_event_id\)/
  );
  assert.match(
    sql,
    /ivekit_voice_cdr_receipts\(tenant_id, billing_event_id\)/
  );
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, call_id, acknowledged_sequence,\s*acknowledged_payload_hash\)/
  );
  assert.match(sql, /route_snapshot_revision BIGINT NOT NULL/);
  assert.match(sql, /owner_epoch BIGINT NOT NULL/);
  assert.match(
    sql,
    /committed_sequence BETWEEN acknowledged_sequence AND 9007199254740991/
  );
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/g);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON ivekit_voice_cdr_calls/);
  assert.match(sql, /GRANT SELECT, INSERT ON ivekit_voice_cdr_receipts TO opc_runtime/);
  assert.match(sql, /GRANT SELECT, INSERT ON ivekit_voice_cdr_submissions TO opc_runtime/);
  assert.doesNotMatch(
    sql,
    /GRANT[^;]*UPDATE[^;]*ON ivekit_voice_cdr_receipts/
  );
  assert.doesNotMatch(
    sql,
    /GRANT[^;]*UPDATE[^;]*ON ivekit_voice_cdr_submissions/
  );
  assert.match(
    sql,
    /REVOKE UPDATE, DELETE, TRUNCATE ON ivekit_voice_cdr_submissions FROM opc_runtime/
  );
  assert.match(
    sql,
    /REVOKE UPDATE, DELETE, TRUNCATE ON ivekit_voice_cdr_receipts FROM opc_runtime/
  );
  assert.match(
    sql,
    /REVOKE DELETE, TRUNCATE ON ivekit_voice_cdr_calls FROM opc_runtime/
  );
  assert.match(
    sql,
    /REVOKE DELETE, TRUNCATE ON ivekit_voice_cdr_legs FROM opc_runtime/
  );
  assert.match(
    sql,
    /REFERENCES ivekit_voice_calls\(tenant_id, id\) ON DELETE RESTRICT/
  );
  assert.match(
    sql,
    /REFERENCES ivekit_voice_cdr_calls\(tenant_id, call_id\) ON DELETE RESTRICT/g
  );
  assert.match(sql, /index_meta\.indisvalid/);
  assert.match(sql, /index_meta\.indisready/);
  assert.match(
    sql,
    /unnest\(index_meta\.indkey::smallint\[\]\) WITH ORDINALITY/
  );
  assert.match(sql, /named unique index is invalid/);
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION opc_ivekit_event_retention_tenant_ids/
  );
  assert.match(
    sql,
    /cdr_call\.tenant_id = event\.tenant_id[\s\S]*cdr_call\.billing_event_id = event\.id/
  );
  assert.match(
    sql,
    /cdr_receipt\.tenant_id = event\.tenant_id[\s\S]*cdr_receipt\.billing_event_id = event\.id/
  );
  assert.doesNotMatch(sql, /sqlite/i);
});

test('CDR convergence locks both active and retained durability contracts until commit', () => {
  const source = readFileSync(POSTGRES_STORE, 'utf8');
  const durabilityQueries = source.match(
    /FROM ivekit_voice_cdr_durability_contracts[\s\S]*?LIMIT 1(?:\s+FOR SHARE)?/g
  ) || [];

  assert.equal(durabilityQueries.length, 2);
  for (const query of durabilityQueries) {
    assert.match(query, /LIMIT 1\s+FOR SHARE/);
  }
});

test('CDR migration persists the Region-committed pending-shadow fence', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  assert.match(sql, /terminal_shadow_pending BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql, /terminal_cdr_sequence BIGINT/);
  assert.match(sql, /terminal_cdr_payload_hash TEXT/);
});

test('CDR convergence rejects an authenticated T1 profile downgrade before database access', async () => {
  const pg = new ScriptedPg([]);
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    legs: [legFixture('caller'), legFixture('callee')]
  }));

  await assert.rejects(
    cdrStore(pg).converge({
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      authoritative_availability_profile: 'VOICE-HA-T1',
      envelope
    }),
    (error: unknown) => voiceError(error, 'event_sequence_conflict', 409)
  );
  pg.assertDone();
});

test('T1 CDR rejects a stale or takeover-pending RustPBX owner before convergence', async () => {
  const envelope = parseVoiceDualLegCdr({
    ...cdrFixture({ legs: [legFixture('caller'), legFixture('callee')] }),
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    availability_profile: 'VOICE-HA-T1',
    owner_epoch: '7'
  });
  const stalePg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', []),
    step('load-legs', []),
    step('load-acknowledgement', []),
    step('lock-dialog-authority', [{
      owner_node_id: 'rustpbx-b',
      owner_epoch: '8',
      pending_takeover_id: null
    }], {
      params: ['tenant-a', 'cell-a', 'provider-call-1']
    })
  ]);

  await assert.rejects(
    cdrStore(stalePg).converge({
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      authoritative_availability_profile: envelope.availability_profile,
      envelope
    }),
    (error: unknown) => voiceError(error, 'event_sequence_conflict', 409)
  );
  stalePg.assertDone();

  const pendingPg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', []),
    step('load-legs', []),
    step('load-acknowledgement', []),
    step('lock-dialog-authority', [{
      owner_node_id: 'rustpbx-a',
      owner_epoch: '7',
      pending_takeover_id: 'takeover-1'
    }], {
      params: ['tenant-a', 'cell-a', 'provider-call-1']
    })
  ]);
  await assert.rejects(
    cdrStore(pendingPg).converge({
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      authoritative_availability_profile: envelope.availability_profile,
      envelope
    }),
    (error: unknown) => voiceError(error, 'event_sequence_conflict', 409)
  );
  pendingPg.assertDone();
});

test('T1 Region commit terminally fences takeover and records pending shadow repair', async () => {
  const envelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '9',
      legs: [legFixture('caller'), legFixture('callee')]
    }),
    availability_profile: 'VOICE-HA-T1'
  });
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', []),
    step('load-legs', []),
    step('load-acknowledgement', []),
    step('lock-dialog-authority', [{
      owner_node_id: 'rustpbx-a',
      owner_epoch: '7',
      pending_takeover_id: null,
      terminal: false
    }]),
    step('load-durability', [durabilityRow()]),
    step('insert-billing-event', [{ id: '901' }]),
    step('upsert-cdr', []),
    step('upsert-leg', []),
    step('upsert-leg', []),
    step('insert-submission', []),
    step('insert-receipt', []),
    step('mark-dialog-terminal-pending-shadow', [{
      call_session_ref: 'provider-call-1'
    }], {
      sql: /SET terminal = TRUE,\s+terminal_shadow_pending = TRUE/,
      params: [
        'tenant-a',
        'cell-a',
        'provider-call-1',
        'rustpbx-a',
        '7',
        '9',
        envelope.payload_hash,
        'call-1',
        'cdr-receipt-1',
        'region-cn-1',
        'cdr-contract-1'
      ]
    })
  ]);

  const receipt = await cdrStore(pg).converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'committed');
  pg.assertDone();
});

test('T1 Region commit fails closed when the exact owner terminal fence is missing', async () => {
  const envelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '9',
      legs: [legFixture('caller'), legFixture('callee')]
    }),
    availability_profile: 'VOICE-HA-T1'
  });
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', []),
    step('load-legs', []),
    step('load-acknowledgement', []),
    step('lock-dialog-authority', [{
      owner_node_id: 'rustpbx-a',
      owner_epoch: '7',
      pending_takeover_id: null,
      terminal: false
    }]),
    step('load-durability', [durabilityRow()]),
    step('insert-billing-event', [{ id: '901' }]),
    step('upsert-cdr', []),
    step('upsert-leg', []),
    step('upsert-leg', []),
    step('insert-submission', []),
    step('insert-receipt', []),
    step('mark-dialog-terminal-pending-shadow', [])
  ]);

  await assert.rejects(
    cdrStore(pg).converge({
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      authoritative_availability_profile: envelope.availability_profile,
      envelope
    }),
    (error: unknown) => voiceError(error, 'event_sequence_conflict', 409)
  );
  pg.assertDone();
});

test('Postgres convergence commits both legs and emits one billing event in the Region transaction', async () => {
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', []),
    step('load-legs', []),
    step('load-acknowledgement', []),
    step('load-durability', [durabilityRow()], {
      sql: /WHERE status = 'active'\s+AND region_id = \$1/,
      params: ['region-cn-1']
    }),
    step('insert-billing-event', [{ id: '901' }]),
    step('upsert-cdr', []),
    step('upsert-leg', []),
    step('upsert-leg', []),
    step('insert-submission', []),
    step('insert-receipt', [], {
      sql: /INSERT INTO ivekit_voice_cdr_receipts/,
      params: [
        'tenant-a',
        'call-1',
        '9',
        '9',
        envelope.payload_hash,
        'cdr-receipt-1',
        'cdr-contract-1',
        'region-cn-1',
        '901',
        'cell-a',
        'rustpbx-a',
        'VOICE-ORDINARY',
        '7',
        '2026-07-27T01:01:01.000Z'
      ]
    })
  ]);
  const store = cdrStore(pg);

  const receipt = await store.converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.receipt_id, 'cdr-receipt-1');
  assert.equal(receipt.acknowledged_sequence, '9');
  assert.equal(receipt.committed_sequence, '9');
  assert.equal(receipt.acknowledged_payload_hash, envelope.payload_hash);
  assert.equal(receipt.region_id, 'region-cn-1');
  assert.equal(receipt.durability_contract_id, 'cdr-contract-1');
  assert.equal(receipt.replayed, false);
  pg.assertDone();
});

test('Postgres convergence persists pending state without a durability contract or billing event', async () => {
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', []),
    step('load-legs', []),
    step('load-acknowledgement', []),
    step('load-durability', [], {
      sql: /WHERE status = 'active'\s+AND region_id = \$1/,
      params: ['region-cn-1']
    }),
    step('upsert-cdr', []),
    step('upsert-leg', []),
    step('upsert-leg', []),
    step('insert-submission', [])
  ]);
  const store = cdrStore(pg);

  const receipt = await store.converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'pending_unacknowledged');
  assert.equal(receipt.receipt_id, null);
  assert.equal(receipt.committed_sequence, null);
  assert.equal(receipt.region_id, null);
  assert.equal(receipt.durability_contract_id, null);
  assert.equal(receipt.replayed, false);
  pg.assertDone();
});

test('Postgres convergence fails closed without a configured CDR Region', async () => {
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', []),
    step('load-legs', []),
    step('load-acknowledgement', []),
    step('upsert-cdr', []),
    step('upsert-leg', []),
    step('upsert-leg', []),
    step('insert-submission', [])
  ]);
  const store = new PostgresVoiceCdrConvergenceStore(pg, {
    now: () => new Date('2026-07-27T01:01:01.000Z'),
    id: () => 'cdr-receipt-1',
    event_retention_ms: 30 * 24 * 60 * 60 * 1_000
  });

  const receipt = await store.converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'pending_unacknowledged');
  assert.equal(receipt.receipt_id, null);
  assert.equal(receipt.region_id, null);
  pg.assertDone();
});

test('Postgres voice module validates the configured CDR Region', () => {
  assert.throws(
    () => createPostgresVoiceHttpModule(new MemoryPg(), {
      cdr_region_id: 'region cn 1',
      address_protector: {} as never
    }),
    (error: unknown) => voiceError(error, 'protocol_mismatch', 422)
  );
});

test('Postgres exact replay returns the durable receipt without another write or billing event', async () => {
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', [cdrRow(envelope)]),
    step('load-legs', [
      cdrLegRow('caller', '9'),
      cdrLegRow('callee', '9')
    ]),
    step('load-acknowledgement', [acknowledgementRow(envelope)])
  ]);
  const store = cdrStore(pg);

  const receipt = await store.converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.receipt_id, 'cdr-receipt-existing');
  assert.equal(receipt.replayed, true);
  pg.assertDone();
});

test('T1 exact replay returns its durable receipt after ownership takeover', async () => {
  const envelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '9',
      legs: [legFixture('caller'), legFixture('callee')]
    }),
    availability_profile: 'VOICE-HA-T1'
  });
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', [cdrRow(envelope)]),
    step('load-legs', [
      cdrLegRow('caller', '9'),
      cdrLegRow('callee', '9')
    ]),
    step('load-acknowledgement', [acknowledgementRow(envelope)])
  ]);

  const receipt = await cdrStore(pg).converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.receipt_id, 'cdr-receipt-existing');
  assert.equal(receipt.replayed, true);
  pg.assertDone();
});

test('Postgres replay decodes retained legs from an earlier owner epoch after takeover', async () => {
  const envelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '10',
      legs: [legFixture('callee', { owner_epoch: '8' })]
    }),
    owner_epoch: '8'
  });
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', [cdrRow(envelope, { highest_sequence: '10' })]),
    step('load-legs', [
      { ...cdrLegRow('caller', '9'), owner_epoch: '7' },
      { ...cdrLegRow('callee', '10'), owner_epoch: '8' }
    ]),
    step('load-acknowledgement', [acknowledgementRow(envelope)])
  ]);

  const receipt = await cdrStore(pg).converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.receipt_id, 'cdr-receipt-existing');
  assert.equal(receipt.replayed, true);
  pg.assertDone();
});

test('T1 journaled submission receives a receipt after a newer owner commits', async () => {
  const previousEnvelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '10',
      legs: [
        legFixture('caller', { owner_epoch: '8' }),
        legFixture('callee', { owner_epoch: '8' })
      ]
    }),
    availability_profile: 'VOICE-HA-T1',
    owner_node_id: 'rustpbx-new',
    owner_epoch: '8'
  });
  const journaledEnvelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '9',
      legs: [legFixture('caller')]
    }),
    availability_profile: 'VOICE-HA-T1',
    owner_node_id: 'rustpbx-old'
  });
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', [cdrRow(previousEnvelope, { highest_sequence: '10' })]),
    step('load-legs', [
      { ...cdrLegRow('caller', '10'), owner_epoch: '8' },
      { ...cdrLegRow('callee', '10'), owner_epoch: '8' }
    ]),
    step('load-acknowledgement', [{
      submission_payload_hash: journaledEnvelope.payload_hash,
      receipt_id: null
    }]),
    step('load-durability', [durabilityRow()], {
      sql: /WHERE id = \$1/,
      params: ['cdr-contract-1']
    }),
    step('insert-receipt', [], {
      params: [
        'tenant-a',
        'call-1',
        '9',
        '10',
        journaledEnvelope.payload_hash,
        'cdr-receipt-1',
        'cdr-contract-1',
        'region-cn-1',
        '901',
        'cell-a',
        'rustpbx-old',
        'VOICE-HA-T1',
        '7',
        '2026-07-27T01:01:01.000Z'
      ]
    })
  ]);

  const receipt = await cdrStore(pg).converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: journaledEnvelope.availability_profile,
    envelope: journaledEnvelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.acknowledged_sequence, '9');
  assert.equal(receipt.committed_sequence, '10');
  assert.equal(receipt.replayed, true);
  pg.assertDone();
});

test('historical CDR replay rejects a payload not present in the submission journal', async () => {
  const previousEnvelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '10',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const unknownEnvelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    call: { media_timeout: true },
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', [cdrRow(previousEnvelope, { highest_sequence: '10' })]),
    step('load-legs', [
      cdrLegRow('caller', '10'),
      cdrLegRow('callee', '10')
    ]),
    step('load-acknowledgement', []),
    step('load-durability', [durabilityRow()], {
      sql: /WHERE id = \$1/,
      params: ['cdr-contract-1']
    })
  ]);

  await assert.rejects(
    cdrStore(pg).converge({
      tenant_id: 'tenant-a',
      profile_id: 'profile-a',
      authoritative_availability_profile: unknownEnvelope.availability_profile,
      envelope: unknownEnvelope
    }),
    (error: unknown) => voiceError(error, 'event_sequence_conflict', 409)
  );
  pg.assertDone();
});

test('known pending historical sequence receives an append-only receipt after a newer commit', async () => {
  const previousEnvelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '10',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const pendingEnvelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    legs: [legFixture('caller')]
  }));
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', [cdrRow(previousEnvelope, { highest_sequence: '10' })]),
    step('load-legs', [
      cdrLegRow('caller', '10'),
      cdrLegRow('callee', '10')
    ]),
    step('load-acknowledgement', [{
      submission_payload_hash: pendingEnvelope.payload_hash,
      receipt_id: null
    }]),
    step('load-durability', [durabilityRow()], {
      sql: /WHERE id = \$1/,
      params: ['cdr-contract-1']
    }),
    step('insert-receipt', [], {
      params: [
        'tenant-a',
        'call-1',
        '9',
        '10',
        pendingEnvelope.payload_hash,
        'cdr-receipt-1',
        'cdr-contract-1',
        'region-cn-1',
        '901',
        'cell-a',
        'rustpbx-a',
        'VOICE-ORDINARY',
        '7',
        '2026-07-27T01:01:01.000Z'
      ]
    })
  ]);

  const receipt = await cdrStore(pg).converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: pendingEnvelope.availability_profile,
    envelope: pendingEnvelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.acknowledged_sequence, '9');
  assert.equal(receipt.committed_sequence, '10');
  assert.equal(receipt.acknowledged_payload_hash, pendingEnvelope.payload_hash);
  assert.equal(receipt.receipt_id, 'cdr-receipt-1');
  assert.equal(receipt.replayed, true);
  pg.assertDone();
});

test('higher CDR sequence uses the active contract in the current Region', async () => {
  const previousEnvelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '9',
    legs: [legFixture('caller'), legFixture('callee')]
  }));
  const envelope = parseVoiceDualLegCdr(cdrFixture({
    sequence: '10',
    call: { media_timeout: true },
    legs: [
      legFixture('caller', { media_result: 'timeout' }),
      legFixture('callee', { media_result: 'timeout' })
    ],
    expected_region_id: 'region-cn-2'
  }));
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [authoritativeCallRow()]),
    step('lock-cdr', [cdrRow(previousEnvelope)]),
    step('load-legs', [
      cdrLegRow('caller', '9'),
      cdrLegRow('callee', '9')
    ]),
    step('load-acknowledgement', []),
    step('load-durability', [{
      ...durabilityRow(),
      id: 'cdr-contract-region-2',
      region_id: 'region-cn-2'
    }], {
      sql: /WHERE status = 'active'\s+AND region_id = \$1/,
      params: ['region-cn-2']
    }),
    step('upsert-cdr', []),
    step('upsert-leg', []),
    step('upsert-leg', []),
    step('insert-submission', []),
    step('insert-receipt', [], {
      params: [
        'tenant-a',
        'call-1',
        '10',
        '10',
        envelope.payload_hash,
        'cdr-receipt-1',
        'cdr-contract-region-2',
        'region-cn-2',
        '901',
        'cell-a',
        'rustpbx-a',
        'VOICE-ORDINARY',
        '7',
        '2026-07-27T01:01:01.000Z'
      ]
    })
  ]);
  const store = cdrStore(pg, 'region-cn-2');

  const receipt = await store.converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.receipt_id, 'cdr-receipt-1');
  assert.equal(receipt.region_id, 'region-cn-2');
  assert.equal(receipt.durability_contract_id, 'cdr-contract-region-2');
  assert.equal(receipt.replayed, false);
  pg.assertDone();
});

test('Postgres replay preserves the original Region receipt after its contract is disabled', async () => {
  const providerCallId = 'call-1@example.invalid';
  const envelope = parseVoiceDualLegCdr({
    ...cdrFixture({
      sequence: '9',
      legs: [legFixture('caller'), legFixture('callee')]
    }),
    provider_call_id: providerCallId
  });
  const pg = new ScriptedPg([
    step('lock-key', []),
    step('lock-authoritative-call', [{
      ...authoritativeCallRow(),
      provider_call_id: providerCallId
    }]),
    step('lock-cdr', [{
      ...cdrRow(envelope),
      provider_call_id: providerCallId
    }]),
    step('load-legs', [
      cdrLegRow('caller', '9'),
      cdrLegRow('callee', '9')
    ]),
    step('load-acknowledgement', [acknowledgementRow(envelope)])
  ]);

  const receipt = await cdrStore(pg).converge({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    authoritative_availability_profile: envelope.availability_profile,
    envelope
  });

  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.receipt_id, 'cdr-receipt-existing');
  assert.equal(receipt.region_id, 'region-cn-1');
  assert.equal(receipt.durability_contract_id, 'cdr-contract-1');
  assert.equal(receipt.replayed, true);
  pg.assertDone();
});

test('CDR webhook returns the convergence receipt instead of enqueueing a legacy provider event', async () => {
  const payload = cdrFixture({
    sequence: '16',
    legs: [legFixture('caller'), legFixture('callee')]
  });
  const parsed = parseVoiceDualLegCdr(payload);
  const calls: Record<string, unknown>[] = [];
  const module = {
    configuration_repository: {
      async getProfile(tenantId: string, profileId: string) {
        return {
          id: profileId,
          tenant_id: tenantId,
          adapter: 'rustpbx',
          status: 'enabled'
        };
      }
    },
    cdrs: {
      async converge(input: Record<string, unknown>) {
        calls.push(input);
        return {
          schema_version: '1.0.0',
          state: 'committed',
          receipt_id: 'cdr-receipt-http',
          interaction_id: 'call-1',
          provider_call_id: 'provider-call-1',
          acknowledged_sequence: '16',
          committed_sequence: '16',
          acknowledged_payload_hash: parsed.payload_hash,
          region_id: 'region-cn-1',
          durability_contract_id: 'cdr-contract-1',
          committed_at: '2026-07-27T01:01:01.000Z',
          replayed: false
        };
      }
    },
    rustpbx_events: {
      normalize() {
        assert.fail('legacy RustPBX CDR normalization must not run');
      }
    },
    provider_events: {
      ingest() {
        assert.fail('legacy provider event queue must not receive durable CDRs');
      }
    }
  } as unknown as VoiceHttpModule;

  const result = await routeConveractFabricVoiceApi(
    new MemoryPg(),
    'POST',
    '/api/ivekit/voice/providers/profile-a/cdrs',
    new URL('http://localhost/api/ivekit/voice/providers/profile-a/cdrs'),
    payload,
    JSON.stringify(payload),
    { 'x-pbx-key': 'service-key' },
    {
      create_module: () => module,
      webhook_authenticator: {
        async authenticate() {
          return {
            tenant_id: 'tenant-a',
            profile_id: 'profile-a',
            adapter: 'rustpbx',
            secret_refs: {},
            method: 'service_key'
          };
        }
      } as never
    }
  ) as {
    status: number;
    data: { state: string; receipt_id: string };
  };

  assert.equal(result.status, 200);
  assert.equal(result.data.state, 'committed');
  assert.equal(result.data.receipt_id, 'cdr-receipt-http');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tenant_id, 'tenant-a');
  assert.equal(calls[0]?.profile_id, 'profile-a');
  assert.deepEqual(calls[0]?.envelope, parsed);
});

function cdrFixture(overrides: {
  state?: string;
  sequence?: string;
  expected_region_id?: string;
  call?: Record<string, unknown>;
  legs: Array<Record<string, unknown>>;
}) {
  return {
    schema_version: '1.0.0',
    state: overrides.state ?? 'pending_unacknowledged',
    interaction_id: 'call-1',
    provider_call_id: 'provider-call-1',
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    expected_region_id: overrides.expected_region_id ?? 'region-cn-1',
    availability_profile: 'VOICE-ORDINARY',
    owner_epoch: '7',
    sequence: overrides.sequence ?? '1',
    call: {
      winning_branch_hash: 'c'.repeat(64),
      early_media: true,
      transfer_chain_hashes: ['d'.repeat(64)],
      media_timeout: false,
      started_at: STARTED_AT,
      answered_at: ANSWERED_AT,
      ended_at: ENDED_AT,
      ...overrides.call
    },
    legs: overrides.legs
  };
}

function legFixture(
  role: 'caller' | 'callee',
  overrides: Record<string, unknown> = {}
) {
  return {
    role,
    dialog_id_hash: (role === 'caller' ? 'a' : 'b').repeat(64),
    direction: role === 'caller' ? 'inbound' : 'outbound',
    sip_final_code: 200,
    hangup_cause: 'normal_clearing',
    answered_at: ANSWERED_AT,
    ended_at: ENDED_AT,
    media_result: 'relayed',
    reservation_ref: `reservation-${role}`,
    owner_epoch: '7',
    route_snapshot_revision: '42',
    ...overrides
  };
}

function voiceError(
  error: unknown,
  code: string,
  status: number
): boolean {
  return error instanceof Error &&
    (error as Error & { code?: string }).code === code &&
    (error as Error & { status?: number }).status === status;
}

function cdrStore(pg: PgQueryable, regionId = 'region-cn-1') {
  return new PostgresVoiceCdrConvergenceStore(pg, {
    now: () => new Date('2026-07-27T01:01:01.000Z'),
    id: () => 'cdr-receipt-1',
    event_retention_ms: 30 * 24 * 60 * 60 * 1_000,
    region_id: regionId
  });
}

function authoritativeCallRow() {
  return {
    id: 'call-1',
    provider_profile_id: 'profile-a',
    provider_call_id: 'provider-call-1'
  };
}

function durabilityRow() {
  return {
    id: 'cdr-contract-1',
    region_id: 'region-cn-1',
    fault_domains: ['zone-a', 'zone-b', 'zone-c'],
    quorum_size: 2,
    status: 'active'
  };
}

function cdrRow(
  envelope: ReturnType<typeof parseVoiceDualLegCdr>,
  overrides: Record<string, unknown> = {}
) {
  return {
    tenant_id: 'tenant-a',
    call_id: 'call-1',
    provider_profile_id: 'profile-a',
    provider_call_id: 'provider-call-1',
    cell_id: envelope.cell_id,
    owner_node_id: envelope.owner_node_id,
    availability_profile: envelope.availability_profile,
    owner_epoch: envelope.owner_epoch,
    highest_sequence: '9',
    latest_payload_hash: envelope.payload_hash,
    state: 'committed',
    call_summary: envelope.call,
    durability_contract_id: 'cdr-contract-1',
    durability_region_id: 'region-cn-1',
    receipt_id: 'cdr-receipt-existing',
    billing_event_id: '901',
    committed_at: new Date('2026-07-27T01:01:01.000Z'),
    ...overrides
  };
}

function acknowledgementRow(
  envelope: ReturnType<typeof parseVoiceDualLegCdr>
) {
  return {
    submission_payload_hash: envelope.payload_hash,
    receipt_id: 'cdr-receipt-existing',
    committed_sequence: envelope.sequence,
    acknowledged_payload_hash: envelope.payload_hash,
    durability_contract_id: 'cdr-contract-1',
    region_id: 'region-cn-1',
    billing_event_id: '901',
    committed_at: new Date('2026-07-27T01:01:01.000Z')
  };
}

function cdrLegRow(role: 'caller' | 'callee', sequence: string) {
  return {
    tenant_id: 'tenant-a',
    call_id: 'call-1',
    sequence,
    ...legFixture(role)
  };
}

interface ScriptStep {
  marker: string;
  rows: Record<string, unknown>[];
  sql?: RegExp;
  params?: unknown[];
}

function step(
  marker: string,
  rows: Record<string, unknown>[],
  expectations: Pick<ScriptStep, 'sql' | 'params'> = {}
): ScriptStep {
  return { marker, rows, ...expectations };
}

class ScriptedPg extends MemoryPg implements PgQueryable {
  readonly #steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    super();
    this.#steps = [...steps];
  }

  override async query(text: string, params: unknown[] = []): Promise<any> {
    const next = this.#steps.shift();
    assert.ok(next, `unexpected query: ${text}`);
    assert.match(text, new RegExp(`converact-voice-cdr:${next.marker}`));
    if (next.sql) assert.match(text, next.sql);
    if (next.params) assert.deepEqual(params, next.params);
    assert.equal(
      params.some((value) => String(value).includes('+8613800138000') ||
        String(value).includes('v=0')),
      false
    );
    return {
      rows: structuredClone(next.rows),
      rowCount: next.rows.length,
      command: '',
      oid: 0,
      fields: []
    };
  }

  assertDone(): void {
    assert.deepEqual(this.#steps, []);
  }
}
