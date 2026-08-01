import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ComponentNodeMediaOrphanProbe,
  mediaControlAdmissionReady
} from '../src/agent-runtime/converact/media-control/orphan-probe.js';
import {
  ComponentNodeAdmissionError,
  type ComponentNodeAuthorizationInput,
  type ComponentNodeStateSnapshot
} from '../src/agent-runtime/converact/placement/component-node-admission.js';

const NOW = new Date('2026-07-26T00:01:01.000Z');

function state(leaseFresh: boolean): ComponentNodeStateSnapshot {
  return {
    component: 'rustpbx',
    region_id: 'region-1',
    zone_id: 'zone-1',
    cell_id: 'cell-1',
    node_id: 'rustpbx-1',
    state: 'accepting',
    state_sequence: 1,
    drain_started_at: '',
    cell_lease_epoch: 9,
    lease_observed_at: leaseFresh
      ? '2026-07-26T00:01:00.000Z'
      : '2026-07-26T00:00:00.000Z',
    lease_expires_at: leaseFresh
      ? '2026-07-26T00:02:00.000Z'
      : '2026-07-26T00:00:30.000Z',
    lease_fresh: leaseFresh,
    recovery_pending: false,
    dimensions: {
      voice_calls: {
        unit: 'call',
        safe_capacity: 10_000,
        used: 0,
        reserved: 0
      }
    },
    reservations: {
      reserved: 0,
      active: 0,
      expired: 0,
      closed: 0
    }
  };
}

const INPUT = {
  tenant_id: 'tenant-handle-1',
  call_id: 'call-1',
  cell_id: 'cell-1',
  owner_node_id: 'rustpbx-1',
  owner_epoch: ((9n << 32n) | 7n).toString(),
  media_reservation_id: 'reservation-1',
  reservation_expires_at: '2026-07-26T00:01:00.000Z'
};

describe('component-node media orphan proof', () => {
  it('keeps media readiness independent from the component drain state', () => {
    for (const componentState of ['accepting', 'degraded', 'draining'] as const) {
      assert.equal(
        mediaControlAdmissionReady({
          ...state(true),
          state: componentState
        }),
        true
      );
    }
    assert.equal(mediaControlAdmissionReady(state(false)), false);
    assert.equal(
      mediaControlAdmissionReady({
        ...state(true),
        recovery_pending: true
      }),
      false
    );
  });

  it('reports live owner and reservation without weakening close authority', async () => {
    let authorization: ComponentNodeAuthorizationInput | undefined;
    const probe = new ComponentNodeMediaOrphanProbe({
      async readState() {
        return state(true);
      },
      async authorize(input) {
        authorization = input;
        return {
          allowed: true as const,
          component: 'rustpbx' as const,
          node_id: 'rustpbx-1',
          cell_lease_epoch: 9,
          owner_epoch: INPUT.owner_epoch,
          state_sequence: 1,
          lease_expires_at: '2026-07-26T00:00:30.000Z',
          reservation_expires_at: INPUT.reservation_expires_at
        };
      }
    });

    assert.deepEqual(await probe.inspect(INPUT, NOW), {
      owner_exists: true,
      session_exists: true
    });
    assert.deepEqual(authorization, {
      reservation_id: 'reservation-1',
      interaction_id: 'call-1',
      owner_epoch: INPUT.owner_epoch,
      operation: 'close'
    });
  });

  it('does not confuse the media cleanup lease with the admission reservation TTL', async () => {
    const probe = new ComponentNodeMediaOrphanProbe({
      async readState() {
        return state(false);
      },
      async authorize() {
        return {
          allowed: true as const,
          component: 'rustpbx' as const,
          node_id: 'rustpbx-1',
          cell_lease_epoch: 9,
          owner_epoch: INPUT.owner_epoch,
          state_sequence: 1,
          lease_expires_at: '2026-07-26T00:00:30.000Z',
          reservation_expires_at: '2026-07-26T00:00:10.000Z'
        };
      }
    });

    assert.deepEqual(await probe.inspect(INPUT, NOW), {
      owner_exists: false,
      session_exists: true
    });
  });

  it('requires both an expired owner lease and an absent reservation', async () => {
    const probe = new ComponentNodeMediaOrphanProbe({
      async readState() {
        return state(false);
      },
      async authorize() {
        throw new ComponentNodeAdmissionError(
          'component_reservation_not_found',
          404
        );
      }
    });

    assert.deepEqual(await probe.inspect(INPUT, NOW), {
      owner_exists: false,
      session_exists: false
    });
  });

  it('fails closed on stale epochs and authority outages', async () => {
    for (const error of [
      new ComponentNodeAdmissionError('stale_owner_epoch', 409),
      new ComponentNodeAdmissionError(
        'component_node_unavailable',
        503,
        true
      )
    ]) {
      const probe = new ComponentNodeMediaOrphanProbe({
        async readState() {
          return state(false);
        },
        async authorize() {
          throw error;
        }
      });
      await assert.rejects(
        probe.inspect(INPUT, NOW),
        (actual: unknown) => actual === error
      );
    }
  });

  it('is wired into the production agent with bounded sweep controls', () => {
    const runtime = readFileSync(
      'scripts/converact-media-control-agent.ts',
      'utf8'
    );
    const compose = readFileSync(
      'infra/converact/docker-compose.voice.yml',
      'utf8'
    );
    const values = readFileSync(
      'infra/converact/helm/rtpengine/values.yaml',
      'utf8'
    );
    const daemonset = readFileSync(
      'infra/converact/helm/rtpengine/templates/daemonset.yaml',
      'utf8'
    );

    assert.match(runtime, /new ComponentNodeMediaOrphanProbe\(admission\)/);
    assert.match(runtime, /orphan_probe:/);
    assert.match(runtime, /agent\.sweepOrphans/);
    assert.match(runtime, /orphanSweepRunning/);
    assert.match(runtime, /finally\(\(\) => \{\s*orphanSweepRunning = false;/);
    assert.match(runtime, /clearInterval\(orphanSweepTimer\)/);
    for (const name of [
      'CONVERACT_FABRIC_MEDIA_CONTROL_ORPHAN_BATCH_SIZE',
      'CONVERACT_FABRIC_MEDIA_CONTROL_ORPHAN_SWEEP_INTERVAL_MS'
    ]) {
      assert.match(runtime, new RegExp(name));
      assert.match(compose, new RegExp(name));
      assert.match(daemonset, new RegExp(name));
    }
    assert.match(values, /orphanBatchSize: 256/);
    assert.match(values, /orphanSweepIntervalMs: 30000/);
  });
});
