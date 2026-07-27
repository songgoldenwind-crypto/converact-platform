import { MediaControlError } from '../../media-control/agent.js';
import {
  checkedMediaControlReconcileInput,
  compareMediaOwnerEpoch,
  MEDIA_CONTROL_ACTIONS,
  mediaControlPayloadHash,
  type MediaControlAction,
  type MediaControlCommand,
  type MediaControlReconcileInput,
  type MediaControlResult,
  type MediaSessionSnapshot
} from '../../media-control/protocol.js';

export interface RustPbxMediaControlClientPort {
  execute(command: MediaControlCommand): Promise<MediaControlResult>;
  reconcile(input: MediaControlReconcileInput): Promise<MediaControlResult>;
  session(reservationId: string): Promise<MediaSessionSnapshot>;
}

export interface RustPbxMediaControlIdentity {
  command_id: string;
  tenant_id: string;
  call_id: string;
  leg_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  admission_reservation_id: string;
  media_reservation_id: string;
  command_sequence: number;
  idempotency_key: string;
  expires_at: string;
}

export interface RustPbxMediaPrepareInput extends RustPbxMediaControlIdentity {
  logical_offer_sdp: string;
  media_profile_id: string;
  from_tag: string;
  transport_hints?: Record<string, unknown>;
}

export interface RustPbxMediaCommitInput extends RustPbxMediaControlIdentity {
  answer_sdp: string;
  from_tag: string;
  to_tag: string;
  payload?: Record<string, unknown>;
}

export interface RustPbxMediaDeleteInput extends RustPbxMediaControlIdentity {
  from_tag: string;
  to_tag?: string;
  payload?: Record<string, unknown>;
}

export interface RustPbxMediaUpdateInput extends RustPbxMediaControlIdentity {
  reason:
    | 'early_media'
    | 'reinvite'
    | 'update'
    | 'hold'
    | 'resume'
    | 'ice_restart';
  from_tag: string;
  to_tag?: string;
  offer_sdp?: string;
  answer_sdp?: string;
  payload?: Record<string, unknown>;
}

export interface RustPbxMediaDtmfInput extends RustPbxMediaControlIdentity {
  digit: string;
  duration_ms: number;
  gap_ms: number;
  volume: number;
  from_tag: string;
  to_tag?: string;
}

export interface RustPbxMediaTakeoverInput
  extends RustPbxMediaControlIdentity {
  previous_owner_epoch: string;
  negotiation_role: 'offer' | 'answer';
  sdp: string;
  from_tag: string;
  to_tag?: string;
}

export type RustPbxMediaMutationInput =
  | RustPbxMediaCommitInput
  | RustPbxMediaDeleteInput
  | RustPbxMediaUpdateInput;

export interface RustPbxMediaReconcileInput {
  media_reservation_id: string;
  call_id: string;
  owner_epoch: string;
  command_id?: string;
}

export interface RustPbxMediaControlOperationResult {
  result: MediaControlResult;
  logical_offer_sdp?: string;
  effective_sdp?: string;
}

export interface RustPbxPendingMediaReconciliation {
  input: MediaControlReconcileInput;
  logical_offer_sdp?: string;
}

export interface RustPbxMediaControlAdapterOptions {
  pending_reconciliations?: readonly RustPbxPendingMediaReconciliation[];
  max_pending_reconciliations?: number;
}

export interface RustPbxMediaCommandIdentityFacts {
  tenant_id: string;
  call_id: string;
  leg_id: string;
  owner_epoch: string;
  command_sequence: number;
  action: MediaControlAction;
  payload_hash: string;
}

export class RustPbxMediaControlAdapter {
  readonly #client: RustPbxMediaControlClientPort;
  readonly #pending =
    new Map<string, RustPbxPendingMediaReconciliation>();
  readonly #inflight = new Set<string>();
  readonly #maxPendingReconciliations: number;

  constructor(
    client: RustPbxMediaControlClientPort,
    options: RustPbxMediaControlAdapterOptions = {}
  ) {
    this.#client = client;
    this.#maxPendingReconciliations =
      options.max_pending_reconciliations ?? 100_000;
    if (!boundedInteger(
      this.#maxPendingReconciliations,
      1,
      1_000_000
    )) {
      throw new Error('media_control_pending_reconciliation_limit_invalid');
    }
    if ((options.pending_reconciliations?.length ?? 0) >
        this.#maxPendingReconciliations) {
      throw new Error('media_control_pending_reconciliation_capacity');
    }
    for (const pending of options.pending_reconciliations ?? []) {
      const checked = checkedPendingReconciliation(pending);
      const reservationId =
        checked.input.command.media_reservation_id;
      if (this.#pending.has(reservationId)) {
        throw new Error('media_control_pending_reconciliation_duplicate');
      }
      this.#pending.set(reservationId, checked);
    }
  }

  async prepare(
    input: RustPbxMediaPrepareInput
  ): Promise<RustPbxMediaControlOperationResult> {
    const payload = {
      offer_sdp: input.logical_offer_sdp,
      media_profile_id: input.media_profile_id,
      from_tag: input.from_tag,
      ...(input.transport_hints
        ? { transport_hints: structuredClone(input.transport_hints) }
        : {})
    };
    return this.#execute({
      protocol_version: 'ivekit.media-control.v1',
      action: 'offer',
      command_id: input.command_id,
      tenant_id: input.tenant_id,
      call_id: input.call_id,
      leg_id: input.leg_id,
      cell_id: input.cell_id,
      owner_node_id: input.owner_node_id,
      owner_epoch: input.owner_epoch,
      admission_reservation_id: input.admission_reservation_id,
      media_reservation_id: input.media_reservation_id,
      command_sequence: input.command_sequence,
      idempotency_key: input.idempotency_key,
      expires_at: input.expires_at,
      payload,
      payload_hash: mediaControlPayloadHash(payload)
    }, input.logical_offer_sdp);
  }

  async commit(
    input: RustPbxMediaCommitInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#mutate('answer', input);
  }

  async update(
    input: RustPbxMediaUpdateInput
  ): Promise<RustPbxMediaControlOperationResult> {
    const hasOffer = typeof input.offer_sdp === 'string';
    const hasAnswer = typeof input.answer_sdp === 'string';
    if (hasOffer === hasAnswer) {
      throw new Error('media_control_update_sdp_invalid');
    }
    checkedSdp(hasOffer ? input.offer_sdp! : input.answer_sdp!);
    return this.#mutate('update', input);
  }

  async cancel(
    input: RustPbxMediaDeleteInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#mutate('delete', input);
  }

  async close(
    input: RustPbxMediaDeleteInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#mutate('delete', input);
  }

  async expire(
    input: RustPbxMediaDeleteInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#mutate('delete', {
      ...input,
      payload: {
        ...structuredClone(input.payload ?? {}),
        reason: 'media_timeout'
      }
    });
  }

  async query(reservationId: string): Promise<MediaSessionSnapshot> {
    return structuredClone(await this.#client.session(reservationId));
  }

  async injectDtmf(
    input: RustPbxMediaDtmfInput
  ): Promise<RustPbxMediaControlOperationResult> {
    if (!/^[0-9*#A-D]$/.test(input.digit) ||
        !boundedInteger(input.duration_ms, 100, 5_000) ||
        !boundedInteger(input.gap_ms, 100, 5_000) ||
        !boundedInteger(input.volume, 0, 63)) {
      throw new Error('media_control_dtmf_invalid');
    }
    const payload = {
      digit: input.digit,
      duration: input.duration_ms,
      from_tag: input.from_tag,
      pause: input.gap_ms,
      ...(input.to_tag ? { to_tag: input.to_tag } : {}),
      volume: input.volume
    };
    return this.#execute(command(input, 'inject_dtmf', payload));
  }

  async takeover(
    input: RustPbxMediaTakeoverInput
  ): Promise<RustPbxMediaControlOperationResult> {
    if (input.command_sequence !== 1 ||
        compareMediaOwnerEpoch(
          input.previous_owner_epoch,
          input.owner_epoch
        ) >= 0) {
      throw new Error('media_control_takeover_invalid');
    }
    checkedSdp(input.sdp);
    const payload = {
      from_tag: input.from_tag,
      negotiation_role: input.negotiation_role,
      owner_takeover: true,
      previous_owner_epoch: input.previous_owner_epoch,
      sdp: input.sdp,
      ...(input.to_tag ? { to_tag: input.to_tag } : {})
    };
    return this.#execute(command(input, 'update', payload));
  }

  async reconcile(
    input: RustPbxMediaReconcileInput
  ): Promise<RustPbxMediaControlOperationResult> {
    const pending = this.#pending.get(input.media_reservation_id);
    if (!pending ||
        pending.input.command.call_id !== input.call_id ||
        pending.input.command.owner_epoch !== input.owner_epoch ||
        (input.command_id &&
          pending.input.command.command_id !== input.command_id)) {
      throw new MediaControlError(
        'media_command_reconciliation_not_found',
        404,
        false
      );
    }
    const result = await this.#client.reconcile(pending.input);
    if (result.result_class !== 'unknown') {
      this.#pending.delete(input.media_reservation_id);
    }
    return project(result, pending.logical_offer_sdp);
  }

  pendingReconciliation(
    reservationId: string
  ): MediaControlReconcileInput | undefined {
    const pending = this.#pending.get(reservationId)?.input;
    return pending ? structuredClone(pending) : undefined;
  }

  exportPendingReconciliations(): RustPbxPendingMediaReconciliation[] {
    return [...this.#pending.values()]
      .map((pending) => structuredClone(pending))
      .sort((left, right) =>
        left.input.command.media_reservation_id.localeCompare(
          right.input.command.media_reservation_id
        ));
  }

  async #mutate(
    action: 'answer' | 'update' | 'delete',
    input: RustPbxMediaMutationInput
  ): Promise<RustPbxMediaControlOperationResult> {
    const payload: Record<string, unknown> = {
      ...structuredClone(input.payload ?? {}),
      from_tag: input.from_tag,
      ...(input.to_tag ? { to_tag: input.to_tag } : {}),
      ...(action === 'answer'
        ? { answer_sdp: (input as RustPbxMediaCommitInput).answer_sdp }
        : action === 'update'
          ? updatePayload(input as RustPbxMediaUpdateInput)
        : {})
    };
    return this.#execute(command(input, action, payload));
  }

  async #execute(
    command: MediaControlCommand,
    logicalOfferSdp?: string
  ): Promise<RustPbxMediaControlOperationResult> {
    const reservationId = command.media_reservation_id;
    const pending = this.#pending.get(reservationId);
    if (pending) {
      throw new MediaControlError(
        'command_reconciliation_required',
        409,
        true
      );
    }
    if (this.#inflight.has(reservationId)) {
      throw new MediaControlError(
        'media_command_in_flight',
        409,
        true
      );
    }
    if (this.#pending.size + this.#inflight.size >=
        this.#maxPendingReconciliations) {
      throw new MediaControlError(
        'media_reconciliation_capacity_exhausted',
        503,
        true
      );
    }
    this.#inflight.add(reservationId);
    try {
      const result = await this.#client.execute(command);
      if (result.result_class === 'unknown') {
        this.#pending.set(reservationId, {
          input: {
            protocol_version: 'ivekit.media-control.v1',
            action: 'reconcile',
            command: structuredClone(command)
          },
          ...(logicalOfferSdp === undefined
            ? {}
            : { logical_offer_sdp: logicalOfferSdp })
        });
      }
      return project(result, logicalOfferSdp);
    } finally {
      this.#inflight.delete(reservationId);
    }
  }
}

export function rustPbxMediaCommandId(
  input: RustPbxMediaCommandIdentityFacts
): string {
  for (const value of [input.tenant_id, input.call_id, input.leg_id]) {
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new Error('media_control_command_identity_invalid');
    }
  }
  compareMediaOwnerEpoch(input.owner_epoch, '0');
  if (!boundedInteger(input.command_sequence, 1, 0xffff_ffff) ||
      !MEDIA_CONTROL_ACTIONS.includes(input.action) ||
      !/^[a-f0-9]{64}$/.test(input.payload_hash)) {
    throw new Error('media_control_command_identity_invalid');
  }
  return `cmd-${mediaControlPayloadHash({
    action: input.action,
    call_id: input.call_id,
    command_sequence: input.command_sequence,
    leg_id: input.leg_id,
    owner_epoch: input.owner_epoch,
    payload_hash: input.payload_hash,
    tenant_id: input.tenant_id
  })}`;
}

function command(
  input: RustPbxMediaControlIdentity,
  action: MediaControlAction,
  payload: Record<string, unknown>
): MediaControlCommand {
  return {
    protocol_version: 'ivekit.media-control.v1',
    action,
    command_id: input.command_id,
    tenant_id: input.tenant_id,
    call_id: input.call_id,
    leg_id: input.leg_id,
    cell_id: input.cell_id,
    owner_node_id: input.owner_node_id,
    owner_epoch: input.owner_epoch,
    admission_reservation_id: input.admission_reservation_id,
    media_reservation_id: input.media_reservation_id,
    command_sequence: input.command_sequence,
    idempotency_key: input.idempotency_key,
    expires_at: input.expires_at,
    payload,
    payload_hash: mediaControlPayloadHash(payload)
  };
}

function updatePayload(
  input: RustPbxMediaUpdateInput
): Record<string, unknown> {
  const role = input.offer_sdp === undefined ? 'answer' : 'offer';
  return {
    negotiation_role: role,
    reason: input.reason,
    sdp: role === 'offer' ? input.offer_sdp! : input.answer_sdp!
  };
}

function checkedPendingReconciliation(
  pending: RustPbxPendingMediaReconciliation
): RustPbxPendingMediaReconciliation {
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    throw new Error('media_control_pending_reconciliation_invalid');
  }
  const input = checkedMediaControlReconcileInput(pending.input);
  if (pending.logical_offer_sdp !== undefined &&
      (typeof pending.logical_offer_sdp !== 'string' ||
        Buffer.byteLength(pending.logical_offer_sdp, 'utf8') > 16 * 1024)) {
    throw new Error('media_control_pending_reconciliation_invalid');
  }
  return {
    input,
    ...(pending.logical_offer_sdp === undefined
      ? {}
      : { logical_offer_sdp: pending.logical_offer_sdp })
  };
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number
): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function checkedSdp(value: string): void {
  if (typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') < 1 ||
      Buffer.byteLength(value, 'utf8') > 16 * 1024) {
    throw new Error('media_control_update_sdp_invalid');
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/;

function project(
  result: MediaControlResult,
  logicalOfferSdp?: string
): RustPbxMediaControlOperationResult {
  return {
    result: structuredClone(result),
    ...(logicalOfferSdp === undefined
      ? {}
      : { logical_offer_sdp: logicalOfferSdp }),
    ...(result.session
      ? { effective_sdp: result.session.effective_sdp }
      : {})
  };
}
