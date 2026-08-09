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

/**
 * This TypeScript model proves transition semantics. The live native Call/Leg
 * registry is owned by the Unified RustPBX process.
 */
export const CALL_LEG_FOUNDATION_ROLE =
  'conformance_reference_not_live_native_authority' as const;

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
  | 'awaiting_ack'
  | 'awaiting_ack_terminate'
  | 'confirmed'
  | 'held'
  | 'transferring'
  | 'terminating'
  | 'terminated'
  | 'failed';

export type CallLegEvent =
  | 'start_invite'
  | 'inbound_invite_observed'
  | 'provisional'
  | 'final_2xx'
  | 'final_non_2xx'
  | 'invite_2xx_ack_observed'
  | 'cancel_requested'
  | 'late_final_2xx'
  | 'remote_cancel_observed'
  | 'remote_bye_observed'
  | 'hold_committed'
  | 'resume_committed'
  | 'transfer_prepare'
  | 'transfer_abort'
  | 'bye_requested'
  | 'termination_observed'
  | 'protocol_failure';

export type CallLegRequiredEffect =
  | 'none'
  | 'ack_2xx'
  | 'ack_non_2xx'
  | 'cancel_if_invite_exists'
  | 'send_cancel'
  | 'ack_then_bye'
  | 'respond_cancel_2xx_and_invite_487'
  | 'respond_cancel_2xx'
  | 'respond_bye_2xx'
  | 'defer_bye_until_ack'
  | 'bye_old_selected_leg'
  | 'send_bye'
  | 'ack_then_bye_non_winner'
  | 'send_bye_non_winner_after_ack'
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
  generation: string;
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
  fork_attempt_id: string;
  sip_status: number;
  event_id: string;
  event_hash: string;
}

export interface RegisterForkBranchInput {
  leg_id: LegId;
  fork_attempt_id: string;
  event_id: string;
  event_hash: string;
}

export interface CommitTransferSelectionInput {
  old_leg_id: LegId;
  old_leg_generation: string;
  new_leg_id: LegId;
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
  readonly required_effect:
    | 'none'
    | 'ack_2xx'
    | 'ack_then_bye'
    | 'ack_then_bye_non_winner'
    | 'send_bye_non_winner_after_ack';
  readonly branch_effects: readonly Readonly<{
    leg_id: LegId;
    required_effect:
      | 'cancel_if_invite_exists'
      | 'send_cancel'
      | 'send_bye_non_winner_after_ack';
  }>[];
  readonly replayed: boolean;
}

export interface ForkBranchRegistrationReceipt {
  readonly event_id: string;
  readonly event_hash: string;
  readonly leg_id: LegId;
  readonly fork_attempt_id: string;
  readonly revision: string;
  readonly replayed: boolean;
}

export interface TransferSelectionReceipt {
  readonly event_id: string;
  readonly event_hash: string;
  readonly old_leg_id: LegId;
  readonly new_leg_id: LegId;
  readonly revision: string;
  readonly selected_leg_id: LegId;
  readonly required_effect: 'bye_old_selected_leg';
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
  'inbound_invite_observed',
  'provisional',
  'final_2xx',
  'final_non_2xx',
  'invite_2xx_ack_observed',
  'cancel_requested',
  'late_final_2xx',
  'remote_cancel_observed',
  'remote_bye_observed',
  'hold_committed',
  'resume_committed',
  'transfer_prepare',
  'transfer_abort',
  'bye_requested',
  'termination_observed',
  'protocol_failure'
]);

const TRANSITIONS = new Map<string, Readonly<{
  to: CallLegState;
  required_effect: CallLegRequiredEffect;
}>>([
  transition('outbound', 'planned', 'start_invite', 'inviting', 'none'),
  transition('outbound', 'inviting', 'provisional', 'early', 'none'),
  transition('outbound', 'inviting', 'final_2xx', 'confirmed', 'ack_2xx'),
  transition('outbound', 'early', 'final_2xx', 'confirmed', 'ack_2xx'),
  transition('outbound', 'inviting', 'final_non_2xx', 'failed', 'ack_non_2xx'),
  transition('outbound', 'early', 'final_non_2xx', 'failed', 'ack_non_2xx'),
  transition(
    'outbound',
    'planned',
    'cancel_requested',
    'terminating',
    'cancel_if_invite_exists'
  ),
  transition('outbound', 'inviting', 'cancel_requested', 'terminating', 'send_cancel'),
  transition('outbound', 'early', 'cancel_requested', 'terminating', 'send_cancel'),
  transition('outbound', 'terminating', 'late_final_2xx', 'terminating', 'ack_then_bye'),
  transition('inbound', 'planned', 'inbound_invite_observed', 'inviting', 'none'),
  transition('inbound', 'inviting', 'provisional', 'early', 'none'),
  transition('inbound', 'inviting', 'final_2xx', 'awaiting_ack', 'none'),
  transition('inbound', 'early', 'final_2xx', 'awaiting_ack', 'none'),
  transition('inbound', 'inviting', 'final_non_2xx', 'failed', 'none'),
  transition('inbound', 'early', 'final_non_2xx', 'failed', 'none'),
  transition(
    'inbound',
    'awaiting_ack',
    'invite_2xx_ack_observed',
    'confirmed',
    'none'
  ),
  transition(
    'inbound',
    'awaiting_ack_terminate',
    'invite_2xx_ack_observed',
    'terminating',
    'send_bye'
  ),
  transition(
    'inbound',
    'inviting',
    'remote_cancel_observed',
    'terminating',
    'respond_cancel_2xx_and_invite_487'
  ),
  transition(
    'inbound',
    'early',
    'remote_cancel_observed',
    'terminating',
    'respond_cancel_2xx_and_invite_487'
  ),
  transition(
    'inbound',
    'awaiting_ack',
    'remote_cancel_observed',
    'awaiting_ack',
    'respond_cancel_2xx'
  ),
  transition(
    'inbound',
    'awaiting_ack_terminate',
    'remote_cancel_observed',
    'awaiting_ack_terminate',
    'respond_cancel_2xx'
  ),
  transition(
    'inbound',
    'awaiting_ack',
    'bye_requested',
    'awaiting_ack_terminate',
    'defer_bye_until_ack'
  ),
  ...bothDirections('confirmed', 'hold_committed', 'held', 'none'),
  ...bothDirections('held', 'resume_committed', 'confirmed', 'none'),
  ...bothDirections('confirmed', 'transfer_prepare', 'transferring', 'none'),
  ...bothDirections('held', 'transfer_prepare', 'transferring', 'none'),
  ...bothDirections('transferring', 'transfer_abort', 'confirmed', 'none'),
  ...bothDirections('confirmed', 'bye_requested', 'terminating', 'send_bye'),
  ...bothDirections('held', 'bye_requested', 'terminating', 'send_bye'),
  ...bothDirections(
    'confirmed',
    'remote_bye_observed',
    'terminating',
    'respond_bye_2xx'
  ),
  ...bothDirections(
    'held',
    'remote_bye_observed',
    'terminating',
    'respond_bye_2xx'
  ),
  ...bothDirections('terminating', 'termination_observed', 'terminated', 'none'),
  ...([
    'planned',
    'inviting',
    'early',
    'awaiting_ack',
    'awaiting_ack_terminate',
    'confirmed',
    'held',
    'transferring',
    'terminating'
  ] as const).flatMap((state) =>
    bothDirections(state, 'protocol_failure', 'failed', 'none')
  )
]);

interface MutableLeg {
  readonly legId: LegId;
  readonly direction: 'inbound' | 'outbound';
  readonly generation: bigint;
  negotiationGeneration: bigint;
  state: CallLegState;
  transferReturnState: 'confirmed' | 'held' | null;
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
  readonly initialGeneration: bigint;
  revision: bigint;
  selectedLegId: LegId | null;
  readonly legs: Map<LegId, MutableLeg>;
  readonly forkBranchesByAttempt: Map<string, Set<LegId>>;
  readonly forkAttemptByLeg: Map<LegId, string>;
  readonly forkWinnerByAttempt: Map<string, LegId>;
  readonly dedupe: Map<string, DedupeEntry>;
  readonly mailbox: BoundedQueue<Readonly<CallWorkItem>>;
  readonly mailboxWorkIds: Set<string>;
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
      'owner_epoch',
      'generation'
    ]);
    const tenantId = identifier(checked.tenant_id);
    const callId = parseCallId(checked.call_id);
    const interactionId = parseInteractionId(checked.interaction_id);
    const ownerEpoch = uint64(checked.owner_epoch, true);
    const initialGeneration = uint64(checked.generation, true);
    const existing = this.#calls.get(callId);
    if (existing) {
      if (existing.tenantId !== tenantId ||
          existing.interactionId !== interactionId ||
          existing.ownerEpoch !== ownerEpoch ||
          existing.initialGeneration !== initialGeneration) {
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
      initialGeneration,
      revision: 0n,
      selectedLegId: null,
      legs: new Map(),
      forkBranchesByAttempt: new Map(),
      forkAttemptByLeg: new Map(),
      forkWinnerByAttempt: new Map(),
      dedupe: new Map(),
      mailbox: new BoundedQueue(this.#bounds.mailbox_per_call),
      mailboxWorkIds: new Set(),
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
      transferReturnState: null,
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
    const rule = TRANSITIONS.get(`${leg.direction}:${leg.state}:${event}`);
    if (!rule) throw failure('call_leg_transition_invalid');
    const nextState = event === 'transfer_abort'
      ? leg.transferReturnState
      : rule.to;
    if (nextState === null) throw failure('call_leg_transition_invalid');
    const revision = call.revision + 1n;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      leg_id: legId,
      revision: revision.toString(),
      state: nextState,
      required_effect: rule.required_effect,
      replayed: false
    }) satisfies CallLegMutationReceipt;
    if (event === 'transfer_prepare') {
      leg.transferReturnState = leg.state as 'confirmed' | 'held';
    } else if (event === 'transfer_abort' || event === 'protocol_failure') {
      leg.transferReturnState = null;
    }
    leg.state = nextState;
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
      'fork_attempt_id',
      'sip_status',
      'event_id',
      'event_hash'
    ]);
    const legId = parseLegId(checked.leg_id);
    const forkAttemptId = identifier(checked.fork_attempt_id);
    const sipStatus = boundedInteger(checked.sip_status, 699);
    if (sipStatus < 200 || sipStatus > 299) throw invalidInput();
    const eventId = identifier(checked.event_id);
    const eventHash = hash(checked.event_hash);
    const operation = `durable-fork-selection:${forkAttemptId}`;
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
    const forkBranches = call.forkBranchesByAttempt.get(forkAttemptId);
    if (!forkBranches?.has(legId) ||
        call.forkAttemptByLeg.get(legId) !== forkAttemptId) {
      throw failure('call_leg_transition_invalid');
    }
    if (leg.direction !== 'outbound') {
      throw failure('call_leg_transition_invalid');
    }
    if (leg.state !== 'inviting' &&
        leg.state !== 'early' &&
        leg.state !== 'confirmed' &&
        leg.state !== 'terminating') {
      throw failure('call_leg_transition_invalid');
    }
    const selectedLegId = call.forkWinnerByAttempt.get(forkAttemptId) ??
      call.selectedLegId ??
      legId;
    const alreadyAcknowledged = leg.state === 'confirmed';
    const terminationAlreadyRequested = leg.state === 'terminating';
    const isWinner = selectedLegId === legId;
    const requiredEffect = isWinner
      ? terminationAlreadyRequested
        ? 'ack_then_bye' as const
        : alreadyAcknowledged
          ? 'none' as const
          : 'ack_2xx' as const
      : alreadyAcknowledged
        ? 'send_bye_non_winner_after_ack' as const
        : 'ack_then_bye_non_winner' as const;
    const branchEffects: Array<Readonly<{
      leg_id: LegId;
      required_effect:
        | 'cancel_if_invite_exists'
        | 'send_cancel'
        | 'send_bye_non_winner_after_ack';
    }>> = [];
    if (!call.forkWinnerByAttempt.has(forkAttemptId) && isWinner) {
      for (const branchId of forkBranches) {
        if (branchId === legId) continue;
        const branch = call.legs.get(branchId);
        if (!branch) throw failure('call_leg_leg_not_found');
        if (branch.direction !== 'outbound') {
          throw failure('call_leg_transition_invalid');
        }
        const effect = forkCancellationEffect(branch.state);
        if (!effect) continue;
        branch.state = 'terminating';
        branchEffects.push(Object.freeze({
          leg_id: branchId,
          required_effect: effect
        }));
      }
      call.forkWinnerByAttempt.set(forkAttemptId, legId);
    }
    const revision = call.revision + 1n;
    call.selectedLegId = selectedLegId;
    leg.state = isWinner && !terminationAlreadyRequested
      ? 'confirmed'
      : 'terminating';
    call.revision = revision;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      leg_id: legId,
      revision: revision.toString(),
      selected_leg_id: selectedLegId,
      required_effect: requiredEffect,
      branch_effects: Object.freeze(branchEffects),
      replayed: false
    });
    this.#remember(call, eventId, eventHash, operation, legId, receipt);
    return receipt;
  }

  registerForkBranch(
    fence: CallMutationFence,
    input: RegisterForkBranchInput
  ): ForkBranchRegistrationReceipt {
    const checked = exactRecord(input, [
      'leg_id',
      'fork_attempt_id',
      'event_id',
      'event_hash'
    ]);
    const legId = parseLegId(checked.leg_id);
    const forkAttemptId = identifier(checked.fork_attempt_id);
    const eventId = identifier(checked.event_id);
    const eventHash = hash(checked.event_hash);
    const operation = `fork-branch-registration:${forkAttemptId}`;
    const replay = this.#findReplay<ForkBranchRegistrationReceipt>(
      fence,
      legId,
      eventId,
      eventHash,
      operation
    );
    if (replay) return replay;
    const { call, leg } = this.#resolveFence(fence, legId);
    this.#reserveDedupe(call);
    if (leg.direction !== 'outbound' || leg.state !== 'planned') {
      throw failure('call_leg_transition_invalid');
    }
    if (call.forkWinnerByAttempt.has(forkAttemptId) ||
        call.forkAttemptByLeg.has(legId)) {
      throw failure('call_leg_event_conflict');
    }
    const branches = call.forkBranchesByAttempt.get(forkAttemptId);
    if ((branches?.size ?? 0) >= this.#bounds.fork_branches_per_attempt) {
      throw capacity();
    }
    const revision = call.revision + 1n;
    if (branches) branches.add(legId);
    else call.forkBranchesByAttempt.set(forkAttemptId, new Set([legId]));
    call.forkAttemptByLeg.set(legId, forkAttemptId);
    call.revision = revision;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      leg_id: legId,
      fork_attempt_id: forkAttemptId,
      revision: revision.toString(),
      replayed: false
    });
    this.#remember(call, eventId, eventHash, operation, legId, receipt);
    return receipt;
  }

  commitTransferSelection(
    fence: CallMutationFence,
    input: CommitTransferSelectionInput
  ): TransferSelectionReceipt {
    const checked = exactRecord(input, [
      'old_leg_id',
      'old_leg_generation',
      'new_leg_id',
      'event_id',
      'event_hash'
    ]);
    const oldLegId = parseLegId(checked.old_leg_id);
    const newLegId = parseLegId(checked.new_leg_id);
    const oldLegGeneration = uint64(checked.old_leg_generation, true);
    const eventId = identifier(checked.event_id);
    const eventHash = hash(checked.event_hash);
    if (oldLegId === newLegId) throw invalidInput();
    const operation =
      `transfer-selection:${oldLegId}:${oldLegGeneration}:${newLegId}`;
    const replay = this.#findReplay<TransferSelectionReceipt>(
      fence,
      newLegId,
      eventId,
      eventHash,
      operation
    );
    if (replay) return replay;
    const { call, leg: newLeg } = this.#resolveFence(fence, newLegId);
    const oldLeg = call.legs.get(oldLegId);
    if (!oldLeg || oldLeg.generation !== oldLegGeneration) {
      throw failure(
        oldLeg ? 'call_leg_stale_generation' : 'call_leg_leg_not_found'
      );
    }
    this.#reserveDedupe(call);
    if (call.selectedLegId !== oldLegId ||
        oldLeg.state !== 'transferring' ||
        newLeg.state !== 'confirmed') {
      throw failure('call_leg_transition_invalid');
    }
    const revision = call.revision + 1n;
    oldLeg.state = 'terminating';
    oldLeg.transferReturnState = null;
    call.selectedLegId = newLegId;
    call.revision = revision;
    const receipt = Object.freeze({
      event_id: eventId,
      event_hash: eventHash,
      old_leg_id: oldLegId,
      new_leg_id: newLegId,
      revision: revision.toString(),
      selected_leg_id: newLegId,
      required_effect: 'bye_old_selected_leg' as const,
      replayed: false
    });
    this.#remember(call, eventId, eventHash, operation, newLegId, receipt);
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

  enqueueCallWork(fence: CallMutationFence, input: CallWorkItem): void {
    const { call } = this.#resolveFence(fence, null);
    const checked = exactRecord(input, ['work_id', 'kind']);
    const item = Object.freeze({
      work_id: identifier(checked.work_id),
      kind: identifier(checked.kind)
    });
    if (call.mailboxWorkIds.has(item.work_id)) {
      throw failure('call_leg_event_conflict');
    }
    if (!call.mailbox.enqueue(item)) throw capacity();
    call.mailboxWorkIds.add(item.work_id);
    call.revision += 1n;
  }

  dequeueCallWork(fence: CallMutationFence): Readonly<CallWorkItem> | null {
    const { call } = this.#resolveFence(fence, null);
    const item = call.mailbox.dequeue();
    if (!item) return null;
    call.mailboxWorkIds.delete(item.work_id);
    call.revision += 1n;
    return item;
  }

  registerTimer(fence: CallMutationFence, timerIdInput: string): void {
    const { call } = this.#resolveFence(fence, null);
    const timerId = identifier(timerIdInput);
    if (call.timers.has(timerId)) return;
    if (call.timers.size >= this.#bounds.timers_per_call) throw capacity();
    call.timers.add(timerId);
    call.revision += 1n;
  }

  releaseTimer(fence: CallMutationFence, timerIdInput: string): boolean {
    const { call } = this.#resolveFence(fence, null);
    const released = call.timers.delete(identifier(timerIdInput));
    if (released) call.revision += 1n;
    return released;
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
      if (context.call.initialGeneration !== context.generation) {
        throw failure('call_leg_stale_generation');
      }
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

function forkCancellationEffect(
  state: CallLegState
): 'cancel_if_invite_exists' | 'send_cancel' |
  'send_bye_non_winner_after_ack' | null {
  if (state === 'planned') return 'cancel_if_invite_exists';
  if (state === 'inviting' || state === 'early') return 'send_cancel';
  if (state === 'confirmed') return 'send_bye_non_winner_after_ack';
  return null;
}

function transition(
  direction: 'inbound' | 'outbound',
  from: CallLegState,
  event: CallLegEvent,
  to: CallLegState,
  required_effect: CallLegRequiredEffect
): readonly [string, Readonly<{
  to: CallLegState;
  required_effect: CallLegRequiredEffect;
}>] {
  return [
    `${direction}:${from}:${event}`,
    Object.freeze({ to, required_effect })
  ] as const;
}

function bothDirections(
  from: CallLegState,
  event: CallLegEvent,
  to: CallLegState,
  requiredEffect: CallLegRequiredEffect
): ReadonlyArray<ReturnType<typeof transition>> {
  return [
    transition('inbound', from, event, to, requiredEffect),
    transition('outbound', from, event, to, requiredEffect)
  ];
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
