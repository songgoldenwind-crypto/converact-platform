import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  attestLegacyCallId,
  deriveCallId,
  deriveInteractionId,
  deriveLegId,
  deriveMediaSessionId,
  deriveProtocolDialogId,
  deriveTransactionId,
  importLegacyCallId,
  parseCallId,
  parseInteractionId,
  parseLegId,
  parseMediaSessionId,
  parseProtocolDialogId,
  parseTransactionId
} from '../src/agent-runtime/converact/voice/foundation-identifiers.js';
import {
  CallLegRegistry
} from '../src/agent-runtime/converact/voice/call-leg-state-machine.js';

const TENANT_ID = 'tenant-foundation';

test('owned identifiers are bounded, typed and boundary-unambiguous', async () => {
  const callId = deriveCallId(TENANT_ID, 'order', '42');
  const legId = deriveLegId(TENANT_ID, callId, 'outbound', '1');
  const protocolDialogId = deriveProtocolDialogId(
    TENANT_ID,
    'wire-call@example.invalid',
    'local-tag',
    'remote-tag'
  );
  const transactionId = deriveTransactionId(TENANT_ID, protocolDialogId, '1');
  const mediaSessionId = deriveMediaSessionId(TENANT_ID, callId, '1');
  const interactionId = deriveInteractionId(TENANT_ID, 'case', '42');

  assert.equal(parseCallId(callId), callId);
  assert.equal(parseLegId(legId), legId);
  assert.equal(parseProtocolDialogId(protocolDialogId), protocolDialogId);
  assert.equal(parseTransactionId(transactionId), transactionId);
  assert.equal(parseMediaSessionId(mediaSessionId), mediaSessionId);
  assert.equal(parseInteractionId(interactionId), interactionId);
  assert.notEqual(
    deriveLegId(TENANT_ID, 'ab', 'c'),
    deriveLegId(TENANT_ID, 'a', 'bc')
  );

  for (const parse of [
    parseCallId,
    parseLegId,
    parseProtocolDialogId,
    parseTransactionId,
    parseMediaSessionId,
    parseInteractionId
  ]) {
    assert.throws(() => parse(''), hasCode('voice_foundation_identifier_invalid'));
    assert.throws(() => parse('x y'), hasCode('voice_foundation_identifier_invalid'));
    assert.throws(() => parse('x'.repeat(129)), hasCode('voice_foundation_identifier_invalid'));
  }

  assert.throws(
    () => parseCallId('wire-call@example.invalid'),
    hasCode('voice_foundation_identifier_invalid')
  );
  const vcallRecord = await attestLegacyCallId(
    legacyCallLookup('vcall_legacy-42'),
    TENANT_ID,
    'vcall_legacy-42'
  );
  assert.match(importLegacyCallId(TENANT_ID, vcallRecord), /^call_[a-f0-9]{32}$/);
  const uuidRecord = await attestLegacyCallId(
    legacyCallLookup('44444444-4444-4444-8444-444444444444'),
    TENANT_ID,
    '44444444-4444-4444-8444-444444444444'
  );
  assert.match(
    importLegacyCallId(TENANT_ID, uuidRecord),
    /^call_[a-f0-9]{32}$/
  );
  assert.throws(
    () => importLegacyCallId(TENANT_ID, {
      source: 'voice_call_repository',
      tenant_id: TENANT_ID,
      format: 'uuid',
      value: '44444444-4444-4444-8444-444444444444'
    } as never),
    hasCode('voice_foundation_legacy_call_id_invalid')
  );
  assert.throws(
    () => importLegacyCallId(TENANT_ID, '44444444-4444-4444-8444-444444444444' as never),
    hasCode('voice_foundation_legacy_call_id_invalid')
  );
  assert.throws(
    () => importLegacyCallId('tenant-other', uuidRecord),
    hasCode('voice_foundation_legacy_call_id_invalid')
  );
  await assert.rejects(
    () => attestLegacyCallId(legacyCallLookup(null), TENANT_ID, 'vcall_missing'),
    hasCode('voice_foundation_legacy_call_id_invalid')
  );
  await assert.rejects(
    () => attestLegacyCallId(
      legacyCallLookup('vcall_tenant-mismatch', 'tenant-other'),
      TENANT_ID,
      'vcall_tenant-mismatch'
    ),
    hasCode('voice_foundation_legacy_call_id_invalid')
  );
});

test('a recovered Call opens only at its durable positive generation', () => {
  const registry = boundedRegistry();
  const callId = deriveCallId(TENANT_ID, 'recovered-generation');
  const legId = deriveLegId(TENANT_ID, callId, 'outbound', '1');
  registry.openCall({
    tenant_id: TENANT_ID,
    call_id: callId,
    interaction_id: deriveInteractionId(TENANT_ID, 'recovered-generation'),
    owner_epoch: '7',
    generation: '9'
  });
  assert.throws(
    () => registry.addLeg(
      fence(callId, '0', '1'),
      { leg_id: legId, direction: 'outbound' }
    ),
    hasCode('call_leg_stale_generation')
  );
  assert.doesNotThrow(() => registry.addLeg(
    fence(callId, '0', '9'),
    { leg_id: legId, direction: 'outbound' }
  ));
  assert.throws(
    () => registry.openCall({
      tenant_id: TENANT_ID,
      call_id: callId,
      interaction_id: deriveInteractionId(TENANT_ID, 'recovered-generation'),
      owner_epoch: '7',
      generation: '10'
    }),
    hasCode('call_leg_call_conflict')
  );
});

test('Call/Leg mutations are owner, generation and revision fenced', () => {
  const fixture = callFixture();
  const first = fixture.registry.applyLegEvent(
    fixture.fence('1'),
    event(fixture.legA, 'evt-start', 'start_invite')
  );
  assert.equal(first.state, 'inviting');
  assert.equal(first.revision, '2');
  assert.equal(first.replayed, false);

  const replay = fixture.registry.applyLegEvent(
    fixture.fence('1'),
    event(fixture.legA, 'evt-start', 'start_invite')
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, first.revision);
  assert.equal(fixture.registry.getCall(fixture.callId).revision, '2');

  assert.throws(
    () => fixture.registry.applyLegEvent(
      fixture.fence('2'),
      { ...event(fixture.legA, 'evt-start', 'start_invite'), event_hash: sha256('conflict') }
    ),
    hasCode('call_leg_event_conflict')
  );
  assert.throws(
    () => fixture.registry.applyLegEvent(
      { ...fixture.fence('2'), owner_epoch: '6' },
      event(fixture.legA, 'evt-owner', 'provisional')
    ),
    hasCode('call_leg_stale_owner')
  );
  assert.throws(
    () => fixture.registry.applyLegEvent(
      { ...fixture.fence('2'), generation: '2' },
      event(fixture.legA, 'evt-generation', 'provisional')
    ),
    hasCode('call_leg_stale_generation')
  );
  assert.throws(
    () => fixture.registry.applyLegEvent(
      fixture.fence('1'),
      event(fixture.legA, 'evt-revision', 'provisional')
    ),
    hasCode('call_leg_revision_conflict')
  );
});

test('CANCEL/2xx, transfer and re-INVITE races retain one unambiguous Leg', () => {
  const fixture = callFixture();
  fixture.registry.applyLegEvent(
    fixture.fence('1'),
    event(fixture.legA, 'evt-start', 'start_invite')
  );
  const cancelled = fixture.registry.applyLegEvent(
    fixture.fence('2'),
    event(fixture.legA, 'evt-cancel', 'cancel_requested')
  );
  assert.equal(cancelled.state, 'terminating');
  assert.equal(cancelled.required_effect, 'send_cancel');
  const late = fixture.registry.applyLegEvent(
    fixture.fence('3'),
    event(fixture.legA, 'evt-late', 'late_final_2xx')
  );
  assert.equal(late.required_effect, 'ack_then_bye');
  assert.equal(late.state, 'terminating');

  const transfer = callFixture();
  transfer.registry.applyLegEvent(
    transfer.fence('1'),
    event(transfer.legA, 'evt-start-2', 'start_invite')
  );
  transfer.registry.applyLegEvent(
    transfer.fence('2'),
    event(transfer.legA, 'evt-answer', 'final_2xx')
  );
  transfer.registry.applyLegEvent(
    transfer.fence('3'),
    event(transfer.legA, 'evt-transfer', 'transfer_prepare')
  );
  assert.equal(transfer.registry.getLeg(transfer.legA).state, 'transferring');
  transfer.registry.applyLegEvent(
    transfer.fence('4'),
    event(transfer.legA, 'evt-transfer-abort', 'transfer_abort')
  );
  assert.equal(transfer.registry.getLeg(transfer.legA).state, 'confirmed');

  const before = transfer.registry.getLeg(transfer.legA);
  const negotiation = transfer.registry.advanceNegotiation(
    transfer.fence('5'),
    {
      leg_id: transfer.legA,
      event_id: 'evt-reinvite',
      event_hash: sha256('evt-reinvite'),
      glare: false
    }
  );
  assert.equal(negotiation.negotiation_generation, '2');
  assert.equal(negotiation.leg_id, before.leg_id);
  assert.equal(transfer.registry.getCall(transfer.callId).legs.length, 1);

  const heldTransfer = callFixture();
  heldTransfer.registry.applyLegEvent(
    heldTransfer.fence('1'),
    event(heldTransfer.legA, 'evt-held-start', 'start_invite')
  );
  heldTransfer.registry.applyLegEvent(
    heldTransfer.fence('2'),
    event(heldTransfer.legA, 'evt-held-answer', 'final_2xx')
  );
  heldTransfer.registry.applyLegEvent(
    heldTransfer.fence('3'),
    event(heldTransfer.legA, 'evt-held', 'hold_committed')
  );
  heldTransfer.registry.applyLegEvent(
    heldTransfer.fence('4'),
    event(heldTransfer.legA, 'evt-held-transfer', 'transfer_prepare')
  );
  heldTransfer.registry.applyLegEvent(
    heldTransfer.fence('5'),
    event(heldTransfer.legA, 'evt-held-abort', 'transfer_abort')
  );
  assert.equal(heldTransfer.registry.getLeg(heldTransfer.legA).state, 'held');
});

test('durable fork selection keeps one winner and cleans a late 2xx branch', () => {
  const fixture = callFixture({ legs_per_call: 2 });
  fixture.registry.addLeg(
    fixture.fence('1', '1'),
    { leg_id: fixture.legB, direction: 'outbound' }
  );
  fixture.registry.applyLegEvent(
    fixture.fence('2', '1'),
    event(fixture.legA, 'evt-fork-start', 'start_invite')
  );
  const winner = fixture.registry.observeDurableForkWinner(
    fixture.fence('3', '1'),
    forkEvent(fixture.legA, 'evt-winner')
  );
  assert.equal(winner.selected_leg_id, fixture.legA);
  assert.equal(winner.required_effect, 'ack_2xx');
  assert.equal(fixture.registry.getLeg(fixture.legA).state, 'confirmed');

  fixture.registry.applyLegEvent(
    fixture.fence('4', '1'),
    event(fixture.legB, 'evt-fork-start-b', 'start_invite')
  );

  const loser = fixture.registry.observeDurableForkWinner(
    fixture.fence('5', '1'),
    forkEvent(fixture.legB, 'evt-loser')
  );
  assert.equal(loser.selected_leg_id, fixture.legA);
  assert.equal(loser.required_effect, 'ack_then_bye_non_winner');
  assert.equal(fixture.registry.getCall(fixture.callId).selected_leg_id, fixture.legA);
  assert.equal(fixture.registry.getLeg(fixture.legB).state, 'terminating');
});

test('fork branch ceilings are isolated by bounded attempt identity', () => {
  const fixture = callFixture({
    legs_per_call: 2,
    fork_branches_per_attempt: 1
  });
  fixture.registry.addLeg(
    fixture.fence('1'),
    { leg_id: fixture.legB, direction: 'outbound' }
  );
  fixture.registry.applyLegEvent(
    fixture.fence('2'),
    event(fixture.legA, 'evt-attempt-start-a', 'start_invite')
  );
  fixture.registry.observeDurableForkWinner(
    fixture.fence('3'),
    forkEvent(fixture.legA, 'evt-attempt-a', 'attempt-a')
  );
  fixture.registry.applyLegEvent(
    fixture.fence('4'),
    event(fixture.legB, 'evt-attempt-start-b', 'start_invite')
  );
  assert.throws(
    () => fixture.registry.observeDurableForkWinner(
      fixture.fence('5'),
      forkEvent(fixture.legB, 'evt-attempt-overflow', 'attempt-a')
    ),
    hasCode('call_leg_capacity_exhausted')
  );
  assert.doesNotThrow(() => fixture.registry.observeDurableForkWinner(
    fixture.fence('5'),
    forkEvent(fixture.legB, 'evt-attempt-b', 'attempt-b')
  ));
});

test('durable transfer commit atomically moves selection before retiring the old Leg', () => {
  const fixture = callFixture({ legs_per_call: 2 });
  fixture.registry.addLeg(
    fixture.fence('1'),
    { leg_id: fixture.legB, direction: 'outbound' }
  );
  fixture.registry.applyLegEvent(
    fixture.fence('2'),
    event(fixture.legA, 'evt-transfer-start-a', 'start_invite')
  );
  fixture.registry.applyLegEvent(
    fixture.fence('3'),
    event(fixture.legA, 'evt-transfer-answer-a', 'final_2xx')
  );
  fixture.registry.observeDurableForkWinner(
    fixture.fence('4'),
    forkEvent(fixture.legA, 'evt-transfer-select-a')
  );
  fixture.registry.applyLegEvent(
    fixture.fence('5'),
    event(fixture.legA, 'evt-transfer-prepare', 'transfer_prepare')
  );
  fixture.registry.applyLegEvent(
    fixture.fence('6'),
    event(fixture.legB, 'evt-transfer-start-b', 'start_invite')
  );
  fixture.registry.applyLegEvent(
    fixture.fence('7'),
    event(fixture.legB, 'evt-transfer-answer-b', 'final_2xx')
  );
  const committed = fixture.registry.commitTransferSelection(
    fixture.fence('8'),
    {
      old_leg_id: fixture.legA,
      old_leg_generation: '1',
      new_leg_id: fixture.legB,
      event_id: 'evt-transfer-commit',
      event_hash: sha256('evt-transfer-commit')
    }
  );
  assert.equal(committed.selected_leg_id, fixture.legB);
  assert.equal(committed.required_effect, 'bye_old_selected_leg');
  assert.equal(fixture.registry.getLeg(fixture.legA).state, 'terminating');
  assert.equal(fixture.registry.getLeg(fixture.legB).state, 'confirmed');
});

test('bounded Leg, Dialog and mailbox overflow preserves existing state', () => {
  const fixture = callFixture({
    legs_per_call: 1,
    protocol_dialog_history_per_leg: 1,
    mailbox_per_call: 1
  });
  const initialRevision = fixture.registry.getCall(fixture.callId).revision;
  assert.throws(
    () => fixture.registry.addLeg(
      fixture.fence(initialRevision),
      { leg_id: fixture.legB, direction: 'outbound' }
    ),
    hasCode('call_leg_capacity_exhausted')
  );
  assert.equal(fixture.registry.getCall(fixture.callId).legs.length, 1);
  assert.equal(fixture.registry.getCall(fixture.callId).revision, initialRevision);

  const dialogA = deriveProtocolDialogId(TENANT_ID, 'call-a', 'local', 'remote-a');
  fixture.registry.bindProtocolDialog(
    fixture.fence(initialRevision),
    {
      leg_id: fixture.legA,
      protocol_dialog_id: dialogA,
      event_id: 'evt-dialog-a',
      event_hash: sha256('evt-dialog-a')
    }
  );
  const afterDialog = fixture.registry.getCall(fixture.callId).revision;
  assert.throws(
    () => fixture.registry.bindProtocolDialog(
      fixture.fence(afterDialog),
      {
        leg_id: fixture.legA,
        protocol_dialog_id: deriveProtocolDialogId(TENANT_ID, 'call-b', 'local', 'remote-b'),
        event_id: 'evt-dialog-b',
        event_hash: sha256('evt-dialog-b')
      }
    ),
    hasCode('call_leg_capacity_exhausted')
  );
  assert.deepEqual(fixture.registry.getLeg(fixture.legA).protocol_dialog_history, [dialogA]);

  fixture.registry.enqueueCallWork(fixture.fence(afterDialog), {
    work_id: 'work-1',
    kind: 'protocol_event'
  });
  const afterEnqueue = fixture.registry.getCall(fixture.callId).revision;
  assert.throws(
    () => fixture.registry.enqueueCallWork(fixture.fence(afterEnqueue), {
      work_id: 'work-2',
      kind: 'protocol_event'
    }),
    hasCode('call_leg_capacity_exhausted')
  );
  assert.deepEqual(fixture.registry.dequeueCallWork(fixture.fence(afterEnqueue)), {
    work_id: 'work-1',
    kind: 'protocol_event'
  });
});

test('a failing synchronous or asynchronous handler cannot damage another Call', async () => {
  const registry = boundedRegistry({ active_calls: 2 });
  const first = openCall(registry, 'first');
  const second = openCall(registry, 'second');
  registry.addLeg(
    fence(first.callId, '0'),
    { leg_id: first.legId, direction: 'outbound' }
  );
  assert.throws(
    () => registry.applyLegEvent(
      fence(first.callId, '1'),
      event(first.legId, 'evt-invalid', 'resume_committed')
    ),
    hasCode('call_leg_transition_invalid')
  );
  assert.equal(registry.active_call_count, 2);
  assert.equal(registry.getCall(second.callId).revision, '0');

  registry.enqueueCallWork(fence(first.callId, '1'), {
    work_id: 'work-handler-failure',
    kind: 'protocol_event'
  });
  assert.deepEqual(
    registry.processNextCallWork(fence(first.callId, '2'), () => {
      throw new Error('controlled worker failure');
    }),
    {
      status: 'failed',
      item: {
        work_id: 'work-handler-failure',
        kind: 'protocol_event'
      },
      failure_code: 'handler_failed'
    }
  );
  assert.equal(registry.getCall(second.callId).revision, '0');

  registry.enqueueCallWork(fence(first.callId, '3'), {
    work_id: 'work-async-handler-failure',
    kind: 'protocol_event'
  });
  assert.deepEqual(
    registry.processNextCallWork(fence(first.callId, '4'), async () => {
      throw new Error('controlled async worker failure');
    }),
    {
      status: 'failed',
      item: {
        work_id: 'work-async-handler-failure',
        kind: 'protocol_event'
      },
      failure_code: 'async_handler_forbidden'
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(registry.getCall(second.callId).revision, '0');
});

test('mailbox and timer work require the same owner/generation/revision fence', () => {
  const fixture = callFixture();
  assert.throws(
    () => fixture.registry.enqueueCallWork(
      { ...fixture.fence('1'), owner_epoch: '6' },
      { work_id: 'work-stale-owner', kind: 'protocol_event' }
    ),
    hasCode('call_leg_stale_owner')
  );
  fixture.registry.registerTimer(fixture.fence('1'), 'timer-a');
  assert.equal(fixture.registry.getCall(fixture.callId).revision, '2');
  assert.throws(
    () => fixture.registry.releaseTimer(
      { ...fixture.fence('2'), generation: '2' },
      'timer-a'
    ),
    hasCode('call_leg_stale_generation')
  );
  assert.equal(fixture.registry.releaseTimer(fixture.fence('2'), 'timer-a'), true);
  assert.equal(fixture.registry.getCall(fixture.callId).revision, '3');
});

test('active Call capacity is reclaimable only through fenced bounded teardown', () => {
  const registry = boundedRegistry({ active_calls: 1 });
  const first = openCall(registry, 'release-first');
  assert.throws(
    () => openCall(registry, 'release-blocked'),
    hasCode('call_leg_capacity_exhausted')
  );
  registry.releaseCall({
    tenant_id: TENANT_ID,
    call_id: first.callId,
    owner_epoch: '7',
    expected_revision: '0'
  });
  assert.equal(registry.active_call_count, 0);
  assert.doesNotThrow(() => openCall(registry, 'release-second'));
});

function callFixture(overrides: Partial<ConstructorParameters<typeof CallLegRegistry>[0]> = {}) {
  const registry = boundedRegistry(overrides);
  const opened = openCall(registry, 'fixture');
  registry.addLeg(
    fence(opened.callId, '0'),
    { leg_id: opened.legId, direction: 'outbound' }
  );
  return {
    registry,
    callId: opened.callId,
    legA: opened.legId,
    legB: deriveLegId(TENANT_ID, opened.callId, 'outbound', '2'),
    fence(revision: string, generation = '1') {
      return fence(opened.callId, revision, generation);
    }
  };
}

function boundedRegistry(overrides: Partial<ConstructorParameters<typeof CallLegRegistry>[0]> = {}) {
  return new CallLegRegistry({
    active_calls: 4,
    legs_per_call: 4,
    fork_branches_per_attempt: 4,
    protocol_dialog_history_per_leg: 4,
    mailbox_per_call: 4,
    dedupe_receipts_per_call: 16,
    timers_per_call: 4,
    ...overrides
  });
}

function openCall(registry: CallLegRegistry, seed: string) {
  const callId = deriveCallId(TENANT_ID, seed);
  const legId = deriveLegId(TENANT_ID, callId, 'outbound', '1');
  registry.openCall({
    tenant_id: TENANT_ID,
    call_id: callId,
    interaction_id: deriveInteractionId(TENANT_ID, seed),
    owner_epoch: '7',
    generation: '1'
  });
  return { callId, legId };
}

function fence(callId: ReturnType<typeof deriveCallId>, revision: string, generation = '1') {
  return {
    tenant_id: TENANT_ID,
    call_id: callId,
    owner_epoch: '7',
    generation,
    expected_revision: revision
  };
}

function event(
  leg_id: ReturnType<typeof deriveLegId>,
  event_id: string,
  event: Parameters<CallLegRegistry['applyLegEvent']>[1]['event']
) {
  return {
    leg_id,
    event_id,
    event_hash: sha256(event_id),
    event
  };
}

function forkEvent(
  leg_id: ReturnType<typeof deriveLegId>,
  event_id: string,
  fork_attempt_id = 'fork-attempt-1'
) {
  return {
    leg_id,
    fork_attempt_id,
    event_id,
    event_hash: sha256(event_id)
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasCode(code: string) {
  return (error: unknown) => (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function legacyCallLookup(
  storedId: string | null,
  tenantId = TENANT_ID
) {
  return {
    async get(requestedTenantId: string, requestedCallId: string) {
      if (storedId === null || requestedCallId !== storedId) return null;
      return {
        id: storedId,
        tenant_id: tenantId,
        requested_tenant_id: requestedTenantId
      };
    }
  };
}
