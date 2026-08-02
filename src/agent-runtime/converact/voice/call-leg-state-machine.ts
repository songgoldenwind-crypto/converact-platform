import { types as utilTypes } from 'node:util';

import {
  type CallId,
  type InteractionId,
  type LegId,
  type ProtocolDialogId,
  parseCallId,
  parseInteractionId,
  parseLegId,
  parseProtocolDialogId
} from './foundation-identifiers.js';

export type CallLegFoundationErrorCode =
  | 'call_leg_input_invalid'
  | 'call_leg_call_not_found'
  | 'call_leg_call_conflict'
  | 'call_leg_leg_not_found'
  | 'call_leg_leg_conflict'
  | 'call_leg_dialog_conflict'
  | 'call_leg_stale_owner'
  | 'call_leg_stale_generation'
  | 'call_leg_revision_conflict'
  | 'call_leg_event_conflict'
  | 'call_leg_transition_invalid'
  | 'call_leg_capacity_exhausted';

export class CallLegFoundationError extends Error {
  readonly code: CallLegFoundationErrorCode;

  constructor(code: CallLegFoundationErrorCode) {
    super(code);
    this.name = 'CallLegFoundationError';
    this.code = code;
  }
}

export type CallLegState =
  | 'planned'
  | 'inviting'
  | 'early'
  | 'confirmed'
  | 'held'
  | 'transferring'
  | 'terminating'
  | 'terminated'
  | 'failed';

export type CallLegEvent =
  | 'start_invite'
  | 'provisional'
  | 'final_2xx'
  | 'cancel_requested'
  | 'late_final_2xx'
  | 'hold_committed'
  | 'resume_committed'
  | 'transfer_prepare'
  | 'transfer_abort'
  | 'transfer_commit'
  | 'bye_requested'
  | 'termination_observed'
  | 'protocol_failure';

export type CallLegRequiredEffect =
  | 'none'
  | 'ack_2xx'
  | 'cancel_if_invite_exists'
  | 'send_cancel'
  | 'ack_then_bye'
  | 'bye_old_selected_leg'
  | 'send_bye'
  | 'ack_then_bye_non_winner'
  | '491_bounded_retry';

export interface CallLegRegistryBounds {
  active_calls: number;
  legs_per_call: number;
  fork_branches_per_attempt: number;
  protocol_dialog_history_per_leg: number;
  mailbox_per_call: number;
  dedupe_receipts_per_call: number;
  timers_per_call: number;
}

export interface OpenCallProjectionInput {
  tenant_id: string;
  call_id: CallId;
  interaction_id: InteractionId;
  owner_epoch: string;
}

export interface CallMutationFence {
  tenant_id: string;
  call_id: CallId;
  owner_epoch: string;
  generation: string;
  expected_revision: string;
}

export interface CallReleaseFence {
  tenant_id: string;
  call_id: CallId;
  owner_epoch: string;
  expected_revision: string;
}

export interface AddCallLegInput {
  leg_id: LegId;
  direction: 'inbound' | 'outbound';
}

export interface ApplyCallLegEventInput {
  leg_id: LegId;
  event_id: string;
  event_hash: string;
  event: CallLegEvent;
}

export interface BindProtocolDialogInput {
  leg_id: LegId;
  protocol_dialog_id: ProtocolDialogId;
  event_id: string;
  event_hash: string;
}

export interface ObserveForkWinnerInput {
  leg_id: LegId;
  event_id: string;
  event_hash: string;
}

export interface AdvanceNegotiationInput {
  leg_id: LegId;
  event_id: string;
  event_hash: string;
  glare: boolean;
}

export interface CallWorkItem {
  work_id: string;
  kind: string;
}

export type CallWorkResult = Readonly<{
  status: 'empty';
}> | Readonly<{
  status: 'completed' | 'failed';
  item: Readonly<CallWorkItem>;
  failure_code: 'none' | 'handler_failed';
}>;

export interface CallLegSnapshot {
  readonly leg_id: LegId;
  readonly direction: 'inbound' | 'outbound';
  readonly generation: string;
  readonly negotiation_generation: string;
  readonly state: CallLegState;
  readonly active_protocol_dialog_id: ProtocolDialogId | null;
  readonly protocol_dialog_history: readonly ProtocolDialogId[];
}

export interface CallProjectionSnapshot {
  readonly tenant_id: string;
  readonly call_id: CallId;
  readonly interaction_id: InteractionId;
  readonly owner_epoch: string;
  readonly revision: string;
  readonly selected_leg_id: LegId | null;
  readonly legs: readonly CallLegSnapshot[];
  readonly mailbox_depth: number;
  readonly timer_count: number;
}

export interface CallLegMutationReceipt {
  readonly event_id: string;
  readonly event_hash: string;
  readonly leg_id: LegId;
  readonly revision: string;
  readonly state: CallLegState;
  readonly required_effect: CallLegRequiredEffect;
  readonly replayed: boolean;
}

export interface ForkSelectionReceipt {
  readonly event_id: string;
  readonly event_hash: string;
  readonly leg_id: LegId;
  readonly revision: string;
  readonly selected_leg_id: LegId;
  readonly required_effect: 'none' | 'ack_then_bye_non_winner';
  readonly replayed: boolean;
}

export interface NegotiationReceipt {
  readonly event_id: string;
  readonly event_hash: string;
  readonly leg_id: LegId;
  readonly revision: string;
  readonly negotiation_generation: string;
  readonly required_effect: 'none' | '491_bounded_retry';
  readonly replayed: boolean;
}

const MAX_BOUNDS = Object.freeze({
  active_calls: 1_000_000,
  legs_per_call: 256,
  fork_branches_per_attempt: 32,
  protocol_dialog_history_per_leg: 16,
  mailbox_per_call: 1_024,
  dedupe_receipts_per_call: 2_048,
  timers_per_call: 128
});
const UINT64_MAX = 18_446_744_073_709_551_615n;
const UINT64_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const POSITIVE_UINT64_PATTERN = /^[1-9][0-9]{0,19}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CALL_LEG_EVENTS = new Set<CallLegEvent>([
  'start_invite',
  'provisional',
  'final_2xx',
  'cancel_requested',
  'late_final_2xx',
  'hold_committed',
  'resume_committed',
  'transfer_prepare',
  'transfer_abort',
  'transfer_commit',
  'bye_requested',
  'termination_observed',
  'protocol_failure'
]);

const TRANSITIONS = new Map<string, Readonly<{
  to: CallLegState;
  required_effect: CallLegRequiredEffect;
}>>([
  transition('planned', 'start_invite', 'inviting', 'none'),
  transition('inviting', 'provisional', 'early', 'none'),
  transition('inviting', 'final_2xx', 'confirmed', 'ack_2xx'),
  transition('early', 'final_2xx', 'confirmed', 'ack_2xx'),
  transition('planned', 'cancel_requested', 'terminating', 'cancel_if_invite_exists'),
  transition('inviting', 'cancel_requested', 'terminating', 'send_cancel'),
  transition('early', 'cancel_requested', 'terminating', 'send_cancel'),
  transition('terminating', 'late_final_2xx', 'terminating', 'ack_then_bye'),
  transition('confirmed', 'hold_committed', 'held', 'none'),
  transition('held', 'resume_committed', 'confirmed', 'none'),
  transition('confirmed', 'transfer_prepare', 'transferring', 'none'),
  transition('held', 'transfer_prepare', 'transferring', 'none'),
  transition('transferring', 'transfer_abort', 'confirmed', 'none'),
  transition('transferring', 'transfer_commit', 'terminating', 'bye_old_selected_leg'),
  transition('confirmed', 'bye_requested', 'terminating', 'send_bye'),
  transition('held', 'bye_requested', 'terminating', 'send_bye'),
  transition('terminating', 'termination_observed', 'terminated', 'none'),
  ...([
    'planned',
    'inviting',
    'early',
    'confirmed',
    'held',
    'transferring',
    'terminating'
  ] as const).map((state) => transition(state, 'protocol_failure', 'failed', 'none'))
]);

interface MutableLeg {
  readonly legId: LegId;
  readonly direction: 'inbound' | 'outbound';
  readonly generation: bigint;
  negotiationGeneration: bigint;
  state: CallLegState;
  activeProtocolDialogId: ProtocolDialogId | null;
  readonly protocolDialogHistory: ProtocolDialogId[];
}

interface DedupeEntry {
  readonly eventHash: string;
  readonly operation: string;
  readonly legId: LegId;
  readonly receipt: Readonly<object>;
}

interface MutableCall {
  readonly tenantId: string;
  readonly callId: CallId;
  readonly interactionId: InteractionId;
  readonly ownerEpoch: bigint;
  revision: bigint;
  selectedLegId: LegId | null;
  readonly legs: Map<LegId, MutableLeg>;
  readonly forkBranches: Set<LegId>;
  readonly dedupe: Map<string, DedupeEntry>;
  readonly mailbox: BoundedQueue<Readonly<CallWorkItem>>;
  readonly timers: Set<string>;
}

/**
 * Bounded in-memory execution projection. VoiceCall remains the sole durable
 * business authority; this registry neither persists Calls nor writes CDRs.
 */
export class CallLegRegistry {
  readonly #bounds: Readonly<CallLegRegistryBounds>;
  readonly #calls = new Map<CallId, MutableCall>();
  readonly #legs = new Map<LegId, Readonly<{ call: MutableCall; leg: MutableLeg }>>();
  readonly #dialogs = new Map<
    ProtocolDialogId,
    Readonly<{ call: MutableCall; leg: MutableLeg }>
  >();

  constructor(input: CallLegRegistryBounds) {
    this.#bounds = validateBounds(input);
    Object.freeze(this);
  }

  get active_call_count(): number {
    return this.#calls.size;
  }

  openCall(input: OpenCallProjectionInput): CallProjectionSnapshot {
    const checked = exactRecord(input, [
      'tenant_id',
      'call_id',
      'interaction_id',
      'owner_epoch'
    ]);
    const tenantId = identifier(checked.tenant_id);
    const callId = parseCallId(checked.call_id);
    const interactionId = parseInteractionId(checked.interaction_id);
    const ownerEpoch = uint64(checked.owner_epoch, true);
    const existing = this.#calls.get(callId);
    if (existing) {
      if (existing.tenantId !== tenantId ||
          existing.interactionId !== interactionId ||
          existing.ownerEpoch !== ownerEpoch) {
        throw failure('call_leg_call_conflict');
      }
      return snapshotCall(existing);
    }
    if (this.#calls.size >= this.#bounds.active_calls) throw capacity();
    const call: MutableCall = {
      tenantId,
      callId,
      interactionId,
      ownerEpoch,
      revision: 0n,
      selectedLegId: null,
      legs: new Map(),
      forkBranches: new Set(),
      dedupe: new Map(),
      mailbox: new BoundedQueue(this.#bounds.mailbox_per_call),
      timers: new Set()
    };
    this.#calls.set(callId, call);
    return snapshotCall(call);
  }

  addLeg(
    fence: CallMutationFence,
    input: AddCallLegInput
  ): CallLegSnapshot {
    const checked = exactRecord(input, ['leg_id', 'direction']);
    const legId = parseLegId(checked.leg_id);
    if (checked.direction !== 'inbound' && checked.direction !== 'outbound') {
      throw invalidInput();
    }
    const context = this.#resolveFence(fence, null);
    if (this.#legs.has(legId)) throw failure('call_leg_leg_conflict');
    if (context.call.legs.size >= this.#bounds.legs_per_call) throw capacity();
    const leg: MutableLeg = {
      legId,
      direction: checked.direction,
      generation: context.generation,
      negotiationGeneration: 1n,
      state: 'planned',
      activeProtocolDialogId: null,
      protocolDialogHistory: []
    };
    context.call.legs.set(legId, leg);
    this.#legs.set(legId, Object.freeze({ call: context.call, leg }));
    context.call.revision += 1n;
    return snapshotLeg(leg);
  }

  applyLegEvent(
    fence: CallMutationFence,
    input: ApplyCallLegEventInput
  ): CallLegMutationReceipt {
    const checked = exactRecord(input, [
      'leg_id',
      'event_id',
      'event_hash',
      'event'
    ]);
    const legId = parseLegId(checked.leg_id);
    const eventId = identifier(checked.event_id);
    const eventHash = hash(checked.event_hash);
    const event = callLegEvent(checked.event);
    const operation = `leg-event:${event}`;
    const replay = this.#findReplay<CallLegMutationReceipt>(
      fence,
      legId,
      eventId,
      eventHash,
      operation
    );
    if (replay) return replay;
    const { call, leg } = this.#resolveFence(fence, legId);
    this.#reserveDedupe(call);
    const rule = TRANSITIONS.get(`${leg.state}:${event}`);
    if (!rule) throw failure('call_leg_transition_invalid');
    const revision = call.revision + 1n;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      leg_id: legId,
      revision: revision.toString(),
      state: rule.to,
      required_effect: rule.required_effect,
      replayed: false
    }) satisfies CallLegMutationReceipt;
    leg.state = rule.to;
    call.revision = revision;
    this.#remember(call, eventId, eventHash, operation, legId, receipt);
    return receipt;
  }

  bindProtocolDialog(
    fence: CallMutationFence,
    input: BindProtocolDialogInput
  ): CallLegMutationReceipt {
    const checked = exactRecord(input, [
      'leg_id',
      'protocol_dialog_id',
      'event_id',
      'event_hash'
    ]);
    const legId = parseLegId(checked.leg_id);
    const protocolDialogId = parseProtocolDialogId(checked.protocol_dialog_id);
    const eventId = identifier(checked.event_id);
    const eventHash = hash(checked.event_hash);
    const operation = `bind-dialog:${protocolDialogId}`;
    const replay = this.#findReplay<CallLegMutationReceipt>(
      fence,
      legId,
      eventId,
      eventHash,
      operation
    );
    if (replay) return replay;
    const { call, leg } = this.#resolveFence(fence, legId);
    this.#reserveDedupe(call);
    const bound = this.#dialogs.get(protocolDialogId);
    if (bound && bound.leg !== leg) throw failure('call_leg_dialog_conflict');
    const alreadyBound = leg.protocolDialogHistory.includes(protocolDialogId);
    if (!alreadyBound &&
        leg.protocolDialogHistory.length >=
          this.#bounds.protocol_dialog_history_per_leg) {
      throw capacity();
    }
    const revision = call.revision + 1n;
    if (!alreadyBound) {
      leg.protocolDialogHistory.push(protocolDialogId);
      this.#dialogs.set(
        protocolDialogId,
        Object.freeze({ call, leg })
      );
    }
    leg.activeProtocolDialogId = protocolDialogId;
    call.revision = revision;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      leg_id: legId,
      revision: revision.toString(),
      state: leg.state,
      required_effect: 'none' as const,
      replayed: false
    });
    this.#remember(call, eventId, eventHash, operation, legId, receipt);
    return receipt;
  }

  observeDurableForkWinner(
    fence: CallMutationFence,
    input: ObserveForkWinnerInput
  ): ForkSelectionReceipt {
    const checked = exactRecord(input, [
      'leg_id',
      'event_id',
      'event_hash'
    ]);
    const legId = parseLegId(checked.leg_id);
    const eventId = identifier(checked.event_id);
    const eventHash = hash(checked.event_hash);
    const operation = 'durable-fork-selection';
    const replay = this.#findReplay<ForkSelectionReceipt>(
      fence,
      legId,
      eventId,
      eventHash,
      operation
    );
    if (replay) return replay;
    const { call, leg } = this.#resolveFence(fence, legId);
    this.#reserveDedupe(call);
    if (!call.forkBranches.has(legId) &&
        call.forkBranches.size >= this.#bounds.fork_branches_per_attempt) {
      throw capacity();
    }
    if (call.selectedLegId === null && leg.state !== 'confirmed') {
      throw failure('call_leg_transition_invalid');
    }
    const selectedLegId = call.selectedLegId ?? legId;
    const requiredEffect = selectedLegId === legId
      ? 'none' as const
      : 'ack_then_bye_non_winner' as const;
    const revision = call.revision + 1n;
    call.forkBranches.add(legId);
    call.selectedLegId = selectedLegId;
    call.revision = revision;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      leg_id: legId,
      revision: revision.toString(),
      selected_leg_id: selectedLegId,
      required_effect: requiredEffect,
      replayed: false
    });
    this.#remember(call, eventId, eventHash, operation, legId, receipt);
    return receipt;
  }

  advanceNegotiation(
    fence: CallMutationFence,
    input: AdvanceNegotiationInput
  ): NegotiationReceipt {
    const checked = exactRecord(input, [
      'leg_id',
      'event_id',
      'event_hash',
      'glare'
    ]);
    const legId = parseLegId(checked.leg_id);
    const eventId = identifier(checked.event_id);
    const eventHash = hash(checked.event_hash);
    if (typeof checked.glare !== 'boolean') throw invalidInput();
    const operation = `advance-negotiation:${checked.glare ? 'glare' : 'accepted'}`;
    const replay = this.#findReplay<NegotiationReceipt>(
      fence,
      legId,
      eventId,
      eventHash,
      operation
    );
    if (replay) return replay;
    const { call, leg } = this.#resolveFence(fence, legId);
    this.#reserveDedupe(call);
    if (leg.state !== 'confirmed' && leg.state !== 'held') {
      throw failure('call_leg_transition_invalid');
    }
    if (!checked.glare) leg.negotiationGeneration += 1n;
    const revision = call.revision + 1n;
    call.revision = revision;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      leg_id: legId,
      revision: revision.toString(),
      negotiation_generation: leg.negotiationGeneration.toString(),
      required_effect: checked.glare
        ? '491_bounded_retry' as const
        : 'none' as const,
      replayed: false
    });
    this.#remember(call, eventId, eventHash, operation, legId, receipt);
    return receipt;
  }

  enqueueCallWork(callIdInput: CallId, input: CallWorkItem): void {
    const call = this.#requireCall(parseCallId(callIdInput));
    const checked = exactRecord(input, ['work_id', 'kind']);
    const item = Object.freeze({
      work_id: identifier(checked.work_id),
      kind: identifier(checked.kind)
    });
    if (!call.mailbox.enqueue(item)) throw capacity();
  }

  dequeueCallWork(callIdInput: CallId): Readonly<CallWorkItem> | null {
    return this.#requireCall(parseCallId(callIdInput)).mailbox.dequeue();
  }

  processNextCallWork(
    callIdInput: CallId,
    handler: (item: Readonly<CallWorkItem>) => void
  ): CallWorkResult {
    if (typeof handler !== 'function') throw invalidInput();
    const item = this.dequeueCallWork(callIdInput);
    if (!item) return Object.freeze({ status: 'empty' });
    try {
      handler(item);
      return Object.freeze({
        status: 'completed',
        item,
        failure_code: 'none'
      });
    } catch {
      return Object.freeze({
        status: 'failed',
        item,
        failure_code: 'handler_failed'
      });
    }
  }

  registerTimer(callIdInput: CallId, timerIdInput: string): void {
    const call = this.#requireCall(parseCallId(callIdInput));
    const timerId = identifier(timerIdInput);
    if (call.timers.has(timerId)) return;
    if (call.timers.size >= this.#bounds.timers_per_call) throw capacity();
    call.timers.add(timerId);
  }

  releaseTimer(callIdInput: CallId, timerIdInput: string): boolean {
    const call = this.#requireCall(parseCallId(callIdInput));
    return call.timers.delete(identifier(timerIdInput));
  }

  getCall(callIdInput: CallId): CallProjectionSnapshot {
    return snapshotCall(this.#requireCall(parseCallId(callIdInput)));
  }

  getLeg(legIdInput: LegId): CallLegSnapshot {
    const indexed = this.#legs.get(parseLegId(legIdInput));
    if (!indexed) throw failure('call_leg_leg_not_found');
    return snapshotLeg(indexed.leg);
  }

  getLegByProtocolDialog(
    protocolDialogIdInput: ProtocolDialogId
  ): CallLegSnapshot {
    const indexed = this.#dialogs.get(
      parseProtocolDialogId(protocolDialogIdInput)
    );
    if (!indexed) throw failure('call_leg_leg_not_found');
    return snapshotLeg(indexed.leg);
  }

  /** Explicit bounded teardown; never runs as part of a packet/event lookup. */
  releaseCall(input: CallReleaseFence): void {
    const checked = exactRecord(input, [
      'tenant_id',
      'call_id',
      'owner_epoch',
      'expected_revision'
    ]);
    const call = this.#requireCall(parseCallId(checked.call_id));
    if (call.tenantId !== identifier(checked.tenant_id)) {
      throw failure('call_leg_call_not_found');
    }
    if (call.ownerEpoch !== uint64(checked.owner_epoch, true)) {
      throw failure('call_leg_stale_owner');
    }
    if (call.revision !== uint64(checked.expected_revision, false)) {
      throw failure('call_leg_revision_conflict');
    }
    if (call.mailbox.size !== 0 || call.timers.size !== 0) {
      throw failure('call_leg_transition_invalid');
    }
    for (const leg of call.legs.values()) {
      if (leg.state !== 'terminated' && leg.state !== 'failed') {
        throw failure('call_leg_transition_invalid');
      }
    }
    for (const leg of call.legs.values()) {
      for (const dialogId of leg.protocolDialogHistory) {
        this.#dialogs.delete(dialogId);
      }
      this.#legs.delete(leg.legId);
    }
    this.#calls.delete(call.callId);
  }

  #findReplay<Receipt>(
    fence: CallMutationFence,
    legId: LegId,
    eventId: string,
    eventHash: string,
    operation: string
  ): Receipt | null {
    const context = this.#resolveAuthority(fence);
    const leg = context.call.legs.get(legId);
    if (!leg) throw failure('call_leg_leg_not_found');
    if (leg.generation !== context.generation) {
      throw failure('call_leg_stale_generation');
    }
    const call = context.call;
    const stored = call.dedupe.get(eventId);
    if (!stored) return null;
    if (stored.eventHash !== eventHash ||
        stored.operation !== operation ||
        stored.legId !== legId) {
      throw failure('call_leg_event_conflict');
    }
    return Object.freeze({
      ...stored.receipt,
      replayed: true
    }) as unknown as Receipt;
  }

  #resolveAuthority(fenceInput: CallMutationFence): {
    call: MutableCall;
    generation: bigint;
    expectedRevision: bigint;
  } {
    const fence = exactRecord(fenceInput, [
      'tenant_id',
      'call_id',
      'owner_epoch',
      'generation',
      'expected_revision'
    ]);
    const call = this.#requireCall(parseCallId(fence.call_id));
    if (call.tenantId !== identifier(fence.tenant_id)) {
      throw failure('call_leg_call_not_found');
    }
    if (call.ownerEpoch !== uint64(fence.owner_epoch, true)) {
      throw failure('call_leg_stale_owner');
    }
    return {
      call,
      generation: uint64(fence.generation, true),
      expectedRevision: uint64(fence.expected_revision, false)
    };
  }

  #resolveFence(
    fence: CallMutationFence,
    legId: LegId | null
  ): {
    call: MutableCall;
    leg: MutableLeg;
    generation: bigint;
  } | {
    call: MutableCall;
    leg: null;
    generation: bigint;
  } {
    const context = this.#resolveAuthority(fence);
    if (context.call.revision !== context.expectedRevision) {
      throw failure('call_leg_revision_conflict');
    }
    if (legId === null) {
      return { call: context.call, leg: null, generation: context.generation };
    }
    const leg = context.call.legs.get(legId);
    if (!leg) throw failure('call_leg_leg_not_found');
    if (leg.generation !== context.generation) {
      throw failure('call_leg_stale_generation');
    }
    return { call: context.call, leg, generation: context.generation };
  }

  #reserveDedupe(call: MutableCall): void {
    if (call.dedupe.size >= this.#bounds.dedupe_receipts_per_call) {
      throw capacity();
    }
  }

  #remember(
    call: MutableCall,
    eventId: string,
    eventHash: string,
    operation: string,
    legId: LegId,
    receipt: Readonly<object>
  ): void {
    call.dedupe.set(eventId, Object.freeze({
      eventHash,
      operation,
      legId,
      receipt
    }));
  }

  #requireCall(callId: CallId): MutableCall {
    const call = this.#calls.get(callId);
    if (!call) throw failure('call_leg_call_not_found');
    return call;
  }
}

Object.freeze(CallLegRegistry.prototype);

class BoundedQueue<Value> {
  readonly #items: Array<Value | undefined>;
  #head = 0;
  #tail = 0;
  #size = 0;

  constructor(readonly capacity: number) {
    this.#items = new Array<Value | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  enqueue(value: Value): boolean {
    if (this.#size === this.capacity) return false;
    this.#items[this.#tail] = value;
    this.#tail = (this.#tail + 1) % this.capacity;
    this.#size += 1;
    return true;
  }

  dequeue(): Value | null {
    if (this.#size === 0) return null;
    const value = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.capacity;
    this.#size -= 1;
    return value ?? null;
  }
}

function transition(
  from: CallLegState,
  event: CallLegEvent,
  to: CallLegState,
  required_effect: CallLegRequiredEffect
): readonly [string, Readonly<{
  to: CallLegState;
  required_effect: CallLegRequiredEffect;
}>] {
  return [
    `${from}:${event}`,
    Object.freeze({ to, required_effect })
  ] as const;
}

function validateBounds(input: CallLegRegistryBounds): Readonly<CallLegRegistryBounds> {
  const value = exactRecord(input, Object.keys(MAX_BOUNDS));
  const checked = Object.fromEntries(
    Object.entries(MAX_BOUNDS).map(([key, maximum]) => [
      key,
      boundedInteger(value[key], maximum)
    ])
  ) as unknown as CallLegRegistryBounds;
  return Object.freeze(checked);
}

function snapshotCall(call: MutableCall): CallProjectionSnapshot {
  return Object.freeze({
    tenant_id: call.tenantId,
    call_id: call.callId,
    interaction_id: call.interactionId,
    owner_epoch: call.ownerEpoch.toString(),
    revision: call.revision.toString(),
    selected_leg_id: call.selectedLegId,
    legs: Object.freeze([...call.legs.values()].map(snapshotLeg)),
    mailbox_depth: call.mailbox.size,
    timer_count: call.timers.size
  });
}

function snapshotLeg(leg: MutableLeg): CallLegSnapshot {
  return Object.freeze({
    leg_id: leg.legId,
    direction: leg.direction,
    generation: leg.generation.toString(),
    negotiation_generation: leg.negotiationGeneration.toString(),
    state: leg.state,
    active_protocol_dialog_id: leg.activeProtocolDialogId,
    protocol_dialog_history: Object.freeze([...leg.protocolDialogHistory])
  });
}

function exactRecord(
  input: unknown,
  keys: readonly string[]
): Record<string, any> {
  if (typeof input !== 'object' || input === null ||
      utilTypes.isProxy(input) || Array.isArray(input)) {
    throw invalidInput();
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string') ||
      Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor ||
          !descriptor.enumerable ||
          !('value' in descriptor);
      })) {
    throw invalidInput();
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function boundedInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > maximum) {
    throw invalidInput();
  }
  return value as number;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw invalidInput();
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw invalidInput();
  }
  return value;
}

function uint64(value: unknown, positive: boolean): bigint {
  const pattern = positive ? POSITIVE_UINT64_PATTERN : UINT64_PATTERN;
  if (typeof value !== 'string' || !pattern.test(value)) throw invalidInput();
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw invalidInput();
  return parsed;
}

function callLegEvent(value: unknown): CallLegEvent {
  if (typeof value !== 'string' || !CALL_LEG_EVENTS.has(value as CallLegEvent)) {
    throw invalidInput();
  }
  return value as CallLegEvent;
}

function invalidInput(): CallLegFoundationError {
  return failure('call_leg_input_invalid');
}

function capacity(): CallLegFoundationError {
  return failure('call_leg_capacity_exhausted');
}

function failure(code: CallLegFoundationErrorCode): CallLegFoundationError {
  return new CallLegFoundationError(code);
}
