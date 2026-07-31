import type {
  CellAdmissionReservationCheckpoint
} from './admission.js';
import {
  HttpComponentNodeAdmissionClient
} from './component-node-admission-http.js';
import type {
  ComponentNodeComponent,
  ComponentNodeLeaseHeartbeat,
  ComponentNodeStateSnapshot
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
  ): Promise<ComponentNodeStateSnapshot>;
  applyReservation(
    checkpoint: CellAdmissionReservationCheckpoint
  ): Promise<CellAdmissionReservationCheckpoint>;
  applyRecoveryReservation(
    checkpoint: CellAdmissionReservationCheckpoint,
    cellLeaseEpoch: number
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

interface NodeSyncGate {
  active_checkpoints: number;
  writer_active: boolean;
  waiting_writers: Array<() => void>;
  waiting_checkpoints: Array<() => void>;
}

type ComponentNodeHeartbeatFactory = (
  recoveryComplete: boolean,
  state?: 'accepting' | 'degraded' | 'draining',
  recoveryReset?: boolean
) => ComponentNodeLeaseHeartbeat;

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
  readonly #pendingCheckpoints = new Map<
    string,
    Map<string, CellAdmissionReservationCheckpoint>
  >();
  readonly #leaseExpiresAt = new Map<string, string>();
  readonly #nodeGates = new Map<string, NodeSyncGate>();
  readonly #dirtyNodes = new Set<string>();
  readonly #maxConcurrentCheckpointSyncs: number;
  readonly #maxQueuedCheckpointSyncs: number;
  readonly #monotonicClockMs: () => number;

  constructor(input: {
    region_id: string;
    zone_id: string;
    cell_id: string;
    cell_lease_epoch: number;
    service_token: string;
    lease_ttl_ms: number;
    timeout_ms?: number;
    max_concurrent_checkpoint_syncs?: number;
    max_queued_checkpoint_syncs?: number;
    monotonic_clock_ms?: () => number;
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
    this.#maxConcurrentCheckpointSyncs = boundedInteger(
      input.max_concurrent_checkpoint_syncs ?? 64,
      1,
      1_024,
      'component node concurrent checkpoint syncs'
    );
    this.#maxQueuedCheckpointSyncs = boundedInteger(
      input.max_queued_checkpoint_syncs ?? 4_096,
      0,
      1_000_000,
      'component node queued checkpoint syncs'
    );
    this.#monotonicClockMs = input.monotonic_clock_ms || Date.now;
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
    for (const nodeId of this.#targets.keys()) {
      this.#nodeGates.set(nodeId, {
        active_checkpoints: 0,
        writer_active: false,
        waiting_writers: [],
        waiting_checkpoints: []
      });
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
    for (const checkpoint of [...input.checkpoints].sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.reservation_id.localeCompare(right.reservation_id)
    )) {
      const target = this.#targets.get(checkpoint.owner_node_id);
      if (!target ||
          target.target.component !== componentForKind(checkpoint.interaction_kind)) {
        throw new ComponentNodeSyncError(
          'component_node_target_mismatch',
          checkpoint.owner_node_id
        );
      }
      this.#rememberCheckpoint(checkpoint);
    }
    for (const target of input.targets) {
      this.#dirtyNodes.add(target.node_id);
    }
    const recovered = await this.syncLeases({
      targets: input.targets,
      cell_state: input.cell_state,
      now: input.now
    });
    requireAllNodes(recovered, 'component_node_recovery_failed');
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
    let release: () => void;
    try {
      release = await this.#acquireCheckpointPermit(checkpoint.owner_node_id);
    } catch (error) {
      this.#rememberPendingCheckpoint(checkpoint);
      this.#dirtyNodes.add(checkpoint.owner_node_id);
      throw error;
    }
    try {
      this.#rememberCheckpoint(checkpoint);
      try {
        const applied = await target.client.applyReservation(checkpoint);
        this.#forgetPendingCheckpoint(checkpoint);
        this.#forgetAppliedTerminalCheckpoint(checkpoint);
        return applied;
      } catch (error) {
        this.#dirtyNodes.add(checkpoint.owner_node_id);
        const rejection = componentRejection(error);
        throw new ComponentNodeSyncError(
          rejection?.code ?? 'component_node_checkpoint_failed',
          checkpoint.owner_node_id,
          error,
          rejection
        );
      }
    } finally {
      release();
    }
  }

  async syncLeases(input: {
    targets: ComponentNodeSyncTarget[];
    cell_state: AdmissionState;
    now: Date;
    recovery_complete?: boolean;
  }): Promise<ComponentNodeSyncResult> {
    validDate(input.now);
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
      const queuedAt = validMonotonicTime(this.#monotonicClockMs());
      const release = await this.#acquireWriterPermit(target.node_id);
      try {
        const desiredState = desiredNodeState(input.cell_state, target.state);
        const createHeartbeat: ComponentNodeHeartbeatFactory = (
          recoveryComplete,
          state = desiredState,
          recoveryReset = false
        ) => {
          const heartbeatAt = new Date(
            input.now.getTime() + Math.max(
              0,
              validMonotonicTime(this.#monotonicClockMs()) - queuedAt
            )
          );
          return {
            component: target.component,
            region_id: this.#identity.region_id,
            zone_id: this.#identity.zone_id,
            cell_id: this.#identity.cell_id,
            node_id: target.node_id,
            cell_lease_epoch: this.#identity.cell_lease_epoch,
            state,
            recovery_complete: recoveryComplete,
            recovery_reset: recoveryReset,
            observed_at: heartbeatAt.toISOString(),
            expires_at: new Date(
              heartbeatAt.getTime() + this.#identity.lease_ttl_ms
            ).toISOString()
          };
        };
        const heartbeat = createHeartbeat(
          input.recovery_complete !== false,
          undefined,
          input.recovery_complete === false
        );
        try {
          if (heartbeat.recovery_complete &&
              this.#dirtyNodes.has(target.node_id)) {
            const recoveredLease = await this.#recoverTarget(
              configured.client,
              createHeartbeat,
              target.node_id
            );
            this.#leaseExpiresAt.set(
              target.node_id,
              recoveredLease.expires_at
            );
            return {
              node_id: target.node_id,
              error_code: '',
              error: '',
              recovery_safe_after: ''
            };
          }
          const acknowledgement = await configured.client.applyLease(heartbeat);
          assertLeaseAcknowledgement(acknowledgement, heartbeat);
          this.#leaseExpiresAt.set(target.node_id, heartbeat.expires_at);
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
              const recoveredLease = await this.#recoverTarget(
                configured.client,
                createHeartbeat,
                target.node_id
              );
              this.#leaseExpiresAt.set(
                target.node_id,
                recoveredLease.expires_at
              );
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
                  heartbeat.expires_at
              };
            }
          }
          return {
            node_id: target.node_id,
            error_code: errorCode(error),
            error: errorMessage(error),
            recovery_safe_after: this.#leaseExpiresAt.get(target.node_id) ||
              heartbeat.expires_at
          };
        }
      } finally {
        release();
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
    createHeartbeat: ComponentNodeHeartbeatFactory,
    nodeId: string
  ): Promise<ComponentNodeLeaseHeartbeat> {
    let recoveryHeartbeat = createHeartbeat(false, 'draining', true);
    assertLeaseAcknowledgement(
      await client.applyLease(recoveryHeartbeat),
      recoveryHeartbeat
    );
    const pendingSnapshot = new Map(
      this.#pendingCheckpoints.get(nodeId) || []
    );
    const checkpointsById = new Map(
      this.#checkpoints.get(nodeId) || []
    );
    for (const [reservationId, checkpoint] of pendingSnapshot) {
      checkpointsById.set(reservationId, checkpoint);
    }
    const checkpoints = [...checkpointsById.values()]
      .sort((left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.reservation_id.localeCompare(right.reservation_id)
      );
    for (const checkpoint of checkpoints) {
      const renewed = createHeartbeat(false, 'draining');
      if (Date.parse(renewed.observed_at) -
          Date.parse(recoveryHeartbeat.observed_at) >=
          this.#identity.lease_ttl_ms / 2) {
        assertLeaseAcknowledgement(
          await client.applyLease(renewed),
          renewed
        );
        recoveryHeartbeat = renewed;
      }
      await this.#applyRecoveryCheckpoint(checkpoint);
    }
    if (!this.#completeReconciliation(nodeId, pendingSnapshot)) {
      recoveryHeartbeat = createHeartbeat(false, 'draining', true);
      assertLeaseAcknowledgement(
        await client.applyLease(recoveryHeartbeat),
        recoveryHeartbeat
      );
      throw new ComponentNodeSyncError(
        'component_node_reconciliation_pending',
        nodeId
      );
    }
    const desired = createHeartbeat(true);
    assertLeaseAcknowledgement(
      await client.applyLease(desired),
      desired
    );
    if (this.#dirtyNodes.has(nodeId)) {
      recoveryHeartbeat = createHeartbeat(false, 'draining', true);
      assertLeaseAcknowledgement(
        await client.applyLease(recoveryHeartbeat),
        recoveryHeartbeat
      );
      throw new ComponentNodeSyncError(
        'component_node_reconciliation_pending',
        nodeId
      );
    }
    return desired;
  }

  async #applyRecoveryCheckpoint(
    checkpoint: CellAdmissionReservationCheckpoint
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
      return await target.client.applyRecoveryReservation(
        checkpoint,
        this.#identity.cell_lease_epoch
      );
    } catch (error) {
      this.#dirtyNodes.add(checkpoint.owner_node_id);
      throw new ComponentNodeSyncError(
        'component_node_checkpoint_failed',
        checkpoint.owner_node_id,
        error
      );
    }
  }

  async #acquireCheckpointPermit(nodeId: string): Promise<() => void> {
    const gate = this.#requiredNodeGate(nodeId);
    if (!gate.writer_active &&
        gate.waiting_writers.length === 0 &&
        gate.active_checkpoints < this.#maxConcurrentCheckpointSyncs) {
      gate.active_checkpoints += 1;
      return this.#checkpointRelease(nodeId);
    }
    if (gate.waiting_checkpoints.length >= this.#maxQueuedCheckpointSyncs) {
      throw new ComponentNodeSyncError(
        'component_node_sync_backpressure',
        nodeId
      );
    }
    await new Promise<void>((resolve) => {
      gate.waiting_checkpoints.push(resolve);
    });
    return this.#checkpointRelease(nodeId);
  }

  async #acquireWriterPermit(nodeId: string): Promise<() => void> {
    const gate = this.#requiredNodeGate(nodeId);
    if (!gate.writer_active && gate.active_checkpoints === 0) {
      gate.writer_active = true;
      return this.#writerRelease(nodeId);
    }
    await new Promise<void>((resolve) => {
      gate.waiting_writers.push(resolve);
    });
    return this.#writerRelease(nodeId);
  }

  #checkpointRelease(nodeId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const gate = this.#requiredNodeGate(nodeId);
      gate.active_checkpoints -= 1;
      this.#drainNodeGate(gate);
    };
  }

  #writerRelease(nodeId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const gate = this.#requiredNodeGate(nodeId);
      gate.writer_active = false;
      this.#drainNodeGate(gate);
    };
  }

  #drainNodeGate(gate: NodeSyncGate): void {
    if (gate.writer_active) return;
    if (gate.waiting_writers.length > 0) {
      if (gate.active_checkpoints === 0) {
        gate.writer_active = true;
        gate.waiting_writers.shift()!();
      }
      return;
    }
    while (gate.active_checkpoints < this.#maxConcurrentCheckpointSyncs &&
        gate.waiting_checkpoints.length > 0) {
      gate.active_checkpoints += 1;
      gate.waiting_checkpoints.shift()!();
    }
  }

  #requiredNodeGate(nodeId: string): NodeSyncGate {
    const gate = this.#nodeGates.get(nodeId);
    if (!gate) {
      throw new ComponentNodeSyncError(
        'component_node_target_missing',
        nodeId
      );
    }
    return gate;
  }

  #rememberCheckpoint(checkpoint: CellAdmissionReservationCheckpoint): void {
    const node = this.#checkpoints.get(checkpoint.owner_node_id) || new Map();
    node.set(checkpoint.reservation_id, structuredClone(checkpoint));
    this.#checkpoints.set(checkpoint.owner_node_id, node);
  }

  #rememberPendingCheckpoint(
    checkpoint: CellAdmissionReservationCheckpoint
  ): void {
    const node = this.#pendingCheckpoints.get(checkpoint.owner_node_id) ||
      new Map();
    node.set(checkpoint.reservation_id, structuredClone(checkpoint));
    this.#pendingCheckpoints.set(checkpoint.owner_node_id, node);
  }

  #forgetPendingCheckpoint(
    checkpoint: CellAdmissionReservationCheckpoint
  ): void {
    const node = this.#pendingCheckpoints.get(checkpoint.owner_node_id);
    const remembered = node?.get(checkpoint.reservation_id);
    if (!node || !remembered ||
        !sameCheckpointRevision(remembered, checkpoint)) {
      return;
    }
    node.delete(checkpoint.reservation_id);
    if (node.size === 0) {
      this.#pendingCheckpoints.delete(checkpoint.owner_node_id);
    }
  }

  #forgetAppliedTerminalCheckpoint(
    checkpoint: CellAdmissionReservationCheckpoint
  ): void {
    if (checkpoint.state === 'reserved' || checkpoint.state === 'active') return;
    const node = this.#checkpoints.get(checkpoint.owner_node_id);
    const remembered = node?.get(checkpoint.reservation_id);
    if (!node || !remembered ||
        !sameCheckpointRevision(remembered, checkpoint)) {
      return;
    }
    node.delete(checkpoint.reservation_id);
    if (node.size === 0) this.#checkpoints.delete(checkpoint.owner_node_id);
  }

  #completeReconciliation(
    nodeId: string,
    pendingSnapshot: Map<string, CellAdmissionReservationCheckpoint>
  ): boolean {
    const node = this.#checkpoints.get(nodeId);
    if (node) {
      for (const checkpoint of [...node.values()]) {
        this.#forgetAppliedTerminalCheckpoint(checkpoint);
      }
    }
    for (const checkpoint of pendingSnapshot.values()) {
      this.#forgetPendingCheckpoint(checkpoint);
    }
    if ((this.#pendingCheckpoints.get(nodeId)?.size || 0) === 0) {
      this.#dirtyNodes.delete(nodeId);
      return true;
    } else {
      this.#dirtyNodes.add(nodeId);
      return false;
    }
  }
}

export class ComponentNodeSyncError extends Error {
  readonly code: string;
  readonly node_id: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    nodeId: string,
    cause?: unknown,
    projection?: { status: number; retryable: boolean }
  ) {
    super(cause ? `${code}: ${errorMessage(cause)}` : code);
    this.name = 'ComponentNodeSyncError';
    this.code = code;
    this.node_id = nodeId;
    this.status = projection?.status ?? 503;
    this.retryable = projection?.retryable ?? true;
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

function assertLeaseAcknowledgement(
  acknowledgement: ComponentNodeStateSnapshot,
  heartbeat: ComponentNodeLeaseHeartbeat
): void {
  if (acknowledgement.component !== heartbeat.component ||
      acknowledgement.region_id !== heartbeat.region_id ||
      acknowledgement.zone_id !== heartbeat.zone_id ||
      acknowledgement.cell_id !== heartbeat.cell_id ||
      acknowledgement.node_id !== heartbeat.node_id ||
      acknowledgement.cell_lease_epoch !== heartbeat.cell_lease_epoch ||
      acknowledgement.state !== heartbeat.state ||
      acknowledgement.recovery_pending === heartbeat.recovery_complete ||
      acknowledgement.lease_observed_at !== heartbeat.observed_at ||
      acknowledgement.lease_expires_at !== heartbeat.expires_at ||
      acknowledgement.lease_fresh !== true) {
    throw new ComponentNodeSyncError(
      'component_node_state_mismatch',
      heartbeat.node_id
    );
  }
}

function sameCheckpointRevision(
  left: CellAdmissionReservationCheckpoint,
  right: CellAdmissionReservationCheckpoint
): boolean {
  return left.reservation_id === right.reservation_id &&
    left.owner_epoch === right.owner_epoch &&
    left.state === right.state &&
    left.updated_at === right.updated_at &&
    left.payload_hash === right.payload_hash;
}

function validMonotonicTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('invalid component node monotonic clock');
  }
  return value;
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

function componentRejection(error: unknown): {
  code: string;
  status: number;
  retryable: boolean;
} | undefined {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    retryable?: unknown;
  };
  const code = String(candidate?.code || '');
  const status = Number(candidate?.status);
  if (!/^[a-z][a-z0-9_]{1,127}$/.test(code) ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599 ||
      typeof candidate?.retryable !== 'boolean') {
    return undefined;
  }
  return { code, status, retryable: candidate.retryable };
}
