import type {
  MediaControlAction,
  MediaSessionState
} from './protocol.js';

export interface MediaTransportCommand {
  action: MediaControlAction;
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
  payload_hash: string;
  command_hash: string;
  transport_session_id?: string;
  payload: Record<string, unknown>;
}

export type MediaTransportOutcome =
  | {
      state: 'succeeded';
      command_id: string;
      transport_session_id: string;
      effective_sdp: string;
      session_state: MediaSessionState;
      applied_at: string;
    }
  | {
      state: 'failed';
      command_id: string;
      error_code: string;
      retryable: boolean;
    }
  | {
      state: 'unknown';
      command_id: string;
      error_code: string;
      retryable: true;
    };

export type MediaTransportQuery =
  | {
      found: true;
      outcome: Exclude<MediaTransportOutcome, { state: 'unknown' }>;
    }
  | {
      found: false;
    };

export interface MediaTransportCommandIdentity {
  command_id: string;
  media_reservation_id: string;
  owner_epoch: string;
  command_hash: string;
}

export interface MediaTransportSessionSnapshot {
  media_reservation_id: string;
  call_id: string;
  owner_epoch: string;
  last_sequence: number;
  state: MediaSessionState;
  transport_session_id: string;
  effective_sdp: string;
  updated_at: string;
}

export interface MediaTransportPort {
  execute(command: MediaTransportCommand): Promise<MediaTransportOutcome>;
  queryCommand(
    identity: MediaTransportCommandIdentity
  ): Promise<MediaTransportQuery>;
  querySession(input: {
    media_reservation_id: string;
    call_id: string;
  }): Promise<MediaTransportSessionSnapshot | undefined>;
  releaseSession(transportSessionId: string, reason: string): Promise<void>;
}
