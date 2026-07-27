import type {
  MediaControlOrphanProbe,
  MediaControlOrphanProof
} from './agent.js';
import {
  ComponentNodeAdmissionError,
  type ComponentNodeAuthorization,
  type ComponentNodeAuthorizationInput,
  type ComponentNodeStateSnapshot
} from '../placement/component-node-admission.js';

interface ComponentNodeOrphanAuthority {
  readState(): Promise<ComponentNodeStateSnapshot>;
  authorize(
    input: ComponentNodeAuthorizationInput
  ): Promise<ComponentNodeAuthorization>;
}

export function mediaControlAdmissionReady(
  state: ComponentNodeStateSnapshot
): boolean {
  return state.lease_fresh && !state.recovery_pending;
}

export class ComponentNodeMediaOrphanProbe
implements MediaControlOrphanProbe {
  readonly #authority: ComponentNodeOrphanAuthority;

  constructor(authority: ComponentNodeOrphanAuthority) {
    this.#authority = authority;
  }

  async inspect(
    input: Parameters<MediaControlOrphanProbe['inspect']>[0],
    now: Date
  ): Promise<MediaControlOrphanProof> {
    const timestamp = checkedInput(input, now);
    const [state, sessionExists] = await Promise.all([
      this.#authority.readState(),
      this.#sessionExists(input)
    ]);
    if (state.component !== 'rustpbx' || state.cell_id !== input.cell_id) {
      throw new Error('media_orphan_authority_identity_mismatch');
    }
    const leaseExpiresAt = Date.parse(state.lease_expires_at);
    const ownerExists =
      state.node_id === input.owner_node_id &&
      state.lease_fresh &&
      Number.isFinite(leaseExpiresAt) &&
      leaseExpiresAt > timestamp;
    return {
      owner_exists: ownerExists,
      session_exists: sessionExists
    };
  }

  async #sessionExists(
    input: Parameters<MediaControlOrphanProbe['inspect']>[0]
  ): Promise<boolean> {
    try {
      const authorization = await this.#authority.authorize({
        reservation_id: input.media_reservation_id,
        interaction_id: input.call_id,
        owner_epoch: input.owner_epoch,
        operation: 'close'
      });
      if (authorization.owner_epoch !== input.owner_epoch ||
          authorization.reservation_expires_at !==
            input.reservation_expires_at) {
        throw new Error('media_orphan_reservation_identity_mismatch');
      }
      return true;
    } catch (error) {
      if (error instanceof ComponentNodeAdmissionError &&
          error.status === 404 &&
          error.code === 'component_reservation_not_found') {
        return false;
      }
      throw error;
    }
  }
}

function checkedInput(
  input: Parameters<MediaControlOrphanProbe['inspect']>[0],
  now: Date
): number {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error('media_orphan_time_invalid');
  for (const value of [
    input.tenant_id,
    input.call_id,
    input.cell_id,
    input.owner_node_id,
    input.media_reservation_id
  ]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)) {
      throw new Error('media_orphan_identity_invalid');
    }
  }
  if (!/^[1-9][0-9]{0,19}$/.test(input.owner_epoch) ||
      !Number.isFinite(Date.parse(input.reservation_expires_at))) {
    throw new Error('media_orphan_identity_invalid');
  }
  return timestamp;
}
