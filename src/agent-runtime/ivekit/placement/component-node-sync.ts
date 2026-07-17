import type {
  CellAdmissionReservationCheckpoint
} from './admission.js';
import {
  HttpComponentNodeAdmissionClient
} from './component-node-admission-http.js';
import type {
  ComponentNodeComponent,
  ComponentNodeLeaseHeartbeat
} from './component-node-admission.js';
import type { AdmissionState } from './types.js';

export interface ComponentNodeSyncTarget {
  component: ComponentNodeComponent;
  node_id: string;
  control_endpoint: string;
  state: AdmissionState;
}

export interface ComponentNodeAdmissionClientPort {
  applyLease(
    heartbeat: ComponentNodeLeaseHeartbeat
  ): Promise<Record<string, unknown>>;
  applyReservation(
    checkpoint: CellAdmissionReservationCheckpoint
  ): Promise<CellAdmissionReservationCheckpoint>;
}

export interface ComponentNodeSyncResult {
  succeeded: string[];
  failed: Array<{
    node_id: string;
    error_code: string;
    error: string;
    recovery_safe_after: string;
  }>;
}

export class ComponentNodeSynchronizer {
  readonly #identity: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    cell_lease_epoch: number;
    lease_ttl_ms: number;
  };
  readonly #targets: Map<string, {
    target: ComponentNodeSyncTarget;
    client: ComponentNodeAdmissionClientPort;
  }>;
  readonly #checkpoints = new Map<
    string,
    Map<string, CellAdmissionReservationCheckpoint>
  >();
  readonly #leaseExpiresAt = new Map<string, string>();

  constructor(input: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    cell_lease_epoch: number;
    service_token: string;
    lease_ttl_ms: number;
    timeout_ms?: number;
    targets: ComponentNodeSyncTarget[];
    client_factory?: (
      target: ComponentNodeSyncTarget
    ) => ComponentNodeAdmissionClientPort;
  }) {
    for (const value of [input.region_id, input.zone_id, input.cell_id]) {
      safeId(value);
    }
    if (!Number.isInteger(input.cell_lease_epoch) ||
        input.cell_lease_epoch < 1 || input.cell_lease_epoch > 0xffff_ffff) {
      throw new Error('invalid component node sync Cell lease epoch');
    }
    const leaseTtlMs = boundedInteger(
      input.lease_ttl_ms,
      1_000,
      300_000,
      'component node sync lease TTL'
    );
    const timeoutMs = boundedInteger(
      input.timeout_ms ?? 2_000,
      100,
      Math.min(30_000, leaseTtlMs),
      'component node sync timeout'
    );
    const targetIds = new Set<string>();
    const factory = input.client_factory || ((target) =>
      new HttpComponentNodeAdmissionClient({
        endpoint: target.control_endpoint,
        service_token: input.service_token,
        timeout_ms: timeoutMs
      }));
    this.#targets = new Map(input.targets.map((target) => {
      const checked = checkedTarget(target);
      if (targetIds.has(checked.node_id)) {
        throw new Error('duplicate component node sync target');
      }
      targetIds.add(checked.node_id);
      return [
        checked.node_id,
        {
          target: checked,
          client: factory(checked)
        }
      ];
    }));
    if (this.#targets.size === 0) {
      throw new Error('component node sync targets are required');
    }
    this.#identity = {
      region_id: input.region_id,
      zone_id: input.zone_id,
      cell_id: input.cell_id,
      cell_lease_epoch: input.cell_lease_epoch,
      lease_ttl_ms: leaseTtlMs
    };
  }

  async recover(input: {
    checkpoints: CellAdmissionReservationCheckpoint[];
    targets: ComponentNodeSyncTarget[];
    cell_state: AdmissionState;
    now: Date;
  }): Promise<void> {
    const draining = await this.syncLeases({
      targets: input.targets,
      cell_state: 'draining',
      now: input.now,
      recovery_complete: false
    });
    requireAllNodes(draining, 'component_node_recovery_lease_failed');
    for (const checkpoint of [...input.checkpoints].sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.reservation_id.localeCompare(right.reservation_id)
    )) {
      await this.applyCheckpoint(checkpoint, input.now);
    }
    const ready = await this.syncLeases({
      targets: input.targets,
      cell_state: input.cell_state,
      now: input.now
    });
    requireAllNodes(ready, 'component_node_recovery_ready_failed');
  }

  async applyCheckpoint(
    checkpoint: CellAdmissionReservationCheckpoint,
    _now: Date
  ): Promise<CellAdmissionReservationCheckpoint> {
    const target = this.#targets.get(checkpoint.owner_node_id);
    if (!target) {
      throw new ComponentNodeSyncError(
        'component_node_target_missing',
        checkpoint.owner_node_id
      );
    }
    if (target.target.component !== componentForKind(checkpoint.interaction_kind)) {
      throw new ComponentNodeSyncError(
        'component_node_target_mismatch',
        checkpoint.owner_node_id
      );
    }
    this.#rememberCheckpoint(checkpoint);
    try {
      return await target.client.applyReservation(checkpoint);
    } catch (error) {
      throw new ComponentNodeSyncError(
        'component_node_checkpoint_failed',
        checkpoint.owner_node_id,
        error
      );
    }
  }

  async syncLeases(input: {
    targets: ComponentNodeSyncTarget[];
    cell_state: AdmissionState;
    now: Date;
    recovery_complete?: boolean;
  }): Promise<ComponentNodeSyncResult> {
    validDate(input.now);
    const expiresAt = new Date(
      input.now.getTime() + this.#identity.lease_ttl_ms
    ).toISOString();
    const settled = await Promise.all(input.targets.map(async (candidate) => {
      const target = checkedTarget(candidate);
      const configured = this.#targets.get(target.node_id);
      if (!configured ||
          configured.target.component !== target.component ||
          configured.target.control_endpoint !== target.control_endpoint) {
        throw new ComponentNodeSyncError(
          'component_node_target_mismatch',
          target.node_id
        );
      }
      const heartbeat: ComponentNodeLeaseHeartbeat = {
        component: target.component,
        region_id: this.#identity.region_id,
        zone_id: this.#identity.zone_id,
        cell_id: this.#identity.cell_id,
        node_id: target.node_id,
        cell_lease_epoch: this.#identity.cell_lease_epoch,
        state: desiredNodeState(input.cell_state, target.state),
        recovery_complete: input.recovery_complete !== false,
        observed_at: input.now.toISOString(),
        expires_at: expiresAt
      };
      try {
        await configured.client.applyLease(heartbeat);
        this.#leaseExpiresAt.set(target.node_id, expiresAt);
        return {
          node_id: target.node_id,
          error_code: '',
          error: '',
          recovery_safe_after: ''
        };
      } catch (error) {
        if (heartbeat.recovery_complete &&
            errorCode(error) === 'component_node_recovery_required') {
          try {
            await this.#recoverTarget(
              configured.client,
              heartbeat,
              target.node_id
            );
            this.#leaseExpiresAt.set(target.node_id, expiresAt);
            return {
              node_id: target.node_id,
              error_code: '',
              error: '',
              recovery_safe_after: ''
            };
          } catch (recoveryError) {
            return {
              node_id: target.node_id,
              error_code: errorCode(recoveryError),
              error: errorMessage(recoveryError),
              recovery_safe_after: this.#leaseExpiresAt.get(target.node_id) ||
                expiresAt
            };
          }
        }
        return {
          node_id: target.node_id,
          error_code: errorCode(error),
          error: errorMessage(error),
          recovery_safe_after: this.#leaseExpiresAt.get(target.node_id) ||
            expiresAt
        };
      }
    }));
    return {
      succeeded: settled.filter((item) => !item.error)
        .map((item) => item.node_id),
      failed: settled.filter((item) => item.error)
        .map((item) => ({
          node_id: item.node_id,
          error_code: item.error_code,
          error: item.error,
          recovery_safe_after: item.recovery_safe_after
        }))
    };
  }

  async #recoverTarget(
    client: ComponentNodeAdmissionClientPort,
    desired: ComponentNodeLeaseHeartbeat,
    nodeId: string
  ): Promise<void> {
    await client.applyLease({
      ...desired,
      state: 'draining',
      recovery_complete: false
    });
    const checkpoints = [...(this.#checkpoints.get(nodeId)?.values() || [])]
      .sort((left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.reservation_id.localeCompare(right.reservation_id)
      );
    for (const checkpoint of checkpoints) {
      await client.applyReservation(checkpoint);
    }
    await client.applyLease(desired);
  }

  #rememberCheckpoint(checkpoint: CellAdmissionReservationCheckpoint): void {
    const node = this.#checkpoints.get(checkpoint.owner_node_id) || new Map();
    if (checkpoint.state === 'reserved' || checkpoint.state === 'active') {
      node.set(checkpoint.reservation_id, structuredClone(checkpoint));
      this.#checkpoints.set(checkpoint.owner_node_id, node);
    } else {
      node.delete(checkpoint.reservation_id);
      if (node.size === 0) this.#checkpoints.delete(checkpoint.owner_node_id);
    }
  }
}

export class ComponentNodeSyncError extends Error {
  readonly code: string;
  readonly node_id: string;
  readonly status = 503;
  readonly retryable = true;

  constructor(code: string, nodeId: string, cause?: unknown) {
    super(cause ? `${code}: ${errorMessage(cause)}` : code);
    this.name = 'ComponentNodeSyncError';
    this.code = code;
    this.node_id = nodeId;
  }
}

function requireAllNodes(
  result: ComponentNodeSyncResult,
  code: string
): void {
  if (result.failed.length === 0) return;
  throw new ComponentNodeSyncError(
    code,
    result.failed.map((item) => item.node_id).sort().join(',')
  );
}

function desiredNodeState(
  cellState: AdmissionState,
  nodeState: AdmissionState
): 'accepting' | 'degraded' | 'draining' {
  if (cellState === 'draining' || cellState === 'offline' ||
      nodeState === 'draining' || nodeState === 'offline') {
    return 'draining';
  }
  return cellState === 'degraded' || nodeState === 'degraded'
    ? 'degraded'
    : 'accepting';
}

function checkedTarget(target: ComponentNodeSyncTarget): ComponentNodeSyncTarget {
  safeId(target.node_id);
  if (!['rustpbx', 'livekit', 'tinode', 'rustdesk'].includes(target.component)) {
    throw new Error('invalid component node sync component');
  }
  const endpoint = new URL(target.control_endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password) {
    throw new Error('invalid component node sync endpoint');
  }
  if (!['accepting', 'degraded', 'draining', 'offline'].includes(target.state)) {
    throw new Error('invalid component node sync state');
  }
  return {
    ...target,
    control_endpoint: endpoint.toString().replace(/\/$/, '')
  };
}

function componentForKind(
  kind: CellAdmissionReservationCheckpoint['interaction_kind']
): ComponentNodeComponent {
  const mapping: Record<
    CellAdmissionReservationCheckpoint['interaction_kind'],
    ComponentNodeComponent
  > = {
    tinode_im: 'tinode',
    sip_voice: 'rustpbx',
    livekit_av: 'livekit',
    livekit_screen: 'livekit',
    rustdesk_remote: 'rustdesk'
  };
  return mapping[kind];
}

function safeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(String(value || ''))) {
    throw new Error('invalid component node sync identifier');
  }
}

function validDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('invalid component node sync time');
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 512);
}

function errorCode(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || '');
  return /^[a-z][a-z0-9_]{1,127}$/.test(code)
    ? code
    : 'component_node_unavailable';
}
