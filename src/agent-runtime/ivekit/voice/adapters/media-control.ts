import { MediaControlError } from '../../media-control/agent.js';
import type {
  MediaControlCommand,
  MediaControlReconcileInput,
  MediaControlResult,
  MediaSessionSnapshot
} from '../../media-control/protocol.js';

export interface RustPbxMediaControlClientPort {
  execute(command: MediaControlCommand): Promise<MediaControlResult>;
  reconcile(input: MediaControlReconcileInput): Promise<MediaControlResult>;
  session(reservationId: string): Promise<MediaSessionSnapshot>;
}

export interface RustPbxMediaControlIdentity {
  command_id: string;
  reservation_id: string;
  interaction_id: string;
  owner_epoch: string;
  sequence: number;
  lease_expires_at: string;
}

export interface RustPbxMediaPrepareInput extends RustPbxMediaControlIdentity {
  logical_offer_sdp: string;
  media_profile_id: string;
  transport_hints?: Record<string, unknown>;
}

export interface RustPbxMediaMutationInput extends RustPbxMediaControlIdentity {
  payload?: Record<string, unknown>;
}

export interface RustPbxMediaReconcileInput {
  reservation_id: string;
  interaction_id: string;
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
    return this.#execute({
      protocol_version: 'ivekit.media-control.v1',
      action: 'prepare',
      command_id: input.command_id,
      reservation_id: input.reservation_id,
      interaction_id: input.interaction_id,
      owner_epoch: input.owner_epoch,
      sequence: input.sequence,
      lease_expires_at: input.lease_expires_at,
      payload: {
        offer_sdp: input.logical_offer_sdp,
        media_profile_id: input.media_profile_id,
        ...(input.transport_hints
          ? { transport_hints: structuredClone(input.transport_hints) }
          : {})
      }
    }, input.logical_offer_sdp);
  }

  async commit(
    input: RustPbxMediaMutationInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#mutate('commit', input);
  }

  async cancel(
    input: RustPbxMediaMutationInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#mutate('cancel', input);
  }

  async close(
    input: RustPbxMediaMutationInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#mutate('close', input);
  }

  async reconcile(
    input: RustPbxMediaReconcileInput
  ): Promise<RustPbxMediaControlOperationResult> {
    const pending = this.#pending.get(input.reservation_id);
    if (!pending ||
        pending.input.interaction_id !== input.interaction_id ||
        pending.input.owner_epoch !== input.owner_epoch ||
        (input.command_id && pending.input.command_id !== input.command_id)) {
      throw new MediaControlError(
        'media_command_reconciliation_not_found',
        404,
        false
      );
    }
    const result = await this.#client.reconcile(pending.input);
    if (result.state !== 'unknown') {
      this.#pending.delete(input.reservation_id);
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
    action: 'commit' | 'cancel' | 'close',
    input: RustPbxMediaMutationInput
  ): Promise<RustPbxMediaControlOperationResult> {
    return this.#execute({
      protocol_version: 'ivekit.media-control.v1',
      action,
      command_id: input.command_id,
      reservation_id: input.reservation_id,
      interaction_id: input.interaction_id,
      owner_epoch: input.owner_epoch,
      sequence: input.sequence,
      lease_expires_at: input.lease_expires_at,
      payload: structuredClone(input.payload ?? {})
    });
  }

  async #execute(
    command: MediaControlCommand,
    logicalOfferSdp?: string
  ): Promise<RustPbxMediaControlOperationResult> {
    const pending = this.#pending.get(command.reservation_id);
    if (pending && pending.input.command_id !== command.command_id) {
      throw new MediaControlError(
        'command_reconciliation_required',
        409,
        true
      );
    }
    const result = await this.#client.execute(command);
    if (result.state === 'unknown') {
      this.#pending.set(command.reservation_id, {
        input: {
          protocol_version: 'ivekit.media-control.v1',
          action: 'reconcile',
          reservation_id: command.reservation_id,
          interaction_id: command.interaction_id,
          owner_epoch: command.owner_epoch,
          command_id: command.command_id
        },
        ...(logicalOfferSdp === undefined
          ? {}
          : { logical_offer_sdp: logicalOfferSdp })
      });
    } else {
      this.#pending.delete(command.reservation_id);
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
