import { MediaControlError } from '../../media-control/agent.js';
import {
  mediaControlPayloadHash,
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

export type RustPbxMediaMutationInput =
  | RustPbxMediaCommitInput
  | RustPbxMediaDeleteInput;

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

interface PendingReconciliation {
  input: MediaControlReconcileInput;
  logical_offer_sdp?: string;
}

export class RustPbxMediaControlAdapter {
  readonly #client: RustPbxMediaControlClientPort;
  readonly #pending = new Map<string, PendingReconciliation>();

  constructor(client: RustPbxMediaControlClientPort) {
    this.#client = client;
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

  async #mutate(
    action: 'answer' | 'delete',
    input: RustPbxMediaCommitInput | RustPbxMediaDeleteInput
  ): Promise<RustPbxMediaControlOperationResult> {
    const payload = {
      ...structuredClone(input.payload ?? {}),
      from_tag: input.from_tag,
      ...(input.to_tag ? { to_tag: input.to_tag } : {}),
      ...(action === 'answer'
        ? { answer_sdp: (input as RustPbxMediaCommitInput).answer_sdp }
        : {})
    };
    return this.#execute({
      protocol_version: 'ivekit.media-control.v1',
      action,
      command_id: input.command_id,
      tenant_id: input.tenant_id,
      call_id: input.call_id,
      leg_id: input.leg_id,
      cell_id: input.cell_id,
      owner_node_id: input.owner_node_id,
      owner_epoch: input.owner_epoch,
      media_reservation_id: input.media_reservation_id,
      command_sequence: input.command_sequence,
      idempotency_key: input.idempotency_key,
      expires_at: input.expires_at,
      payload,
      payload_hash: mediaControlPayloadHash(payload)
    });
  }

  async #execute(
    command: MediaControlCommand,
    logicalOfferSdp?: string
  ): Promise<RustPbxMediaControlOperationResult> {
    const pending = this.#pending.get(command.media_reservation_id);
    if (pending && pending.input.command.command_id !== command.command_id) {
      throw new MediaControlError(
        'command_reconciliation_required',
        409,
        true
      );
    }
    const result = await this.#client.execute(command);
    if (result.result_class === 'unknown') {
      this.#pending.set(command.media_reservation_id, {
        input: {
          protocol_version: 'ivekit.media-control.v1',
          action: 'reconcile',
          command: structuredClone(command)
        },
        ...(logicalOfferSdp === undefined
          ? {}
          : { logical_offer_sdp: logicalOfferSdp })
      });
    } else {
      this.#pending.delete(command.media_reservation_id);
    }
    return project(result, logicalOfferSdp);
  }
}

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
