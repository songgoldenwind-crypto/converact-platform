import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  CellAdmissionController,
  type CellAdmissionReservationCheckpoint
} from '../src/agent-runtime/converact/placement/admission.js';
import {
  createCellAdmissionHttpServer,
  createCellAdmissionStandbyHttpServer
} from '../src/agent-runtime/converact/placement/admission-http.js';
import {
  CellAdmissionLedgerError,
  PostgresCellAdmissionLedger
} from '../src/agent-runtime/converact/placement/admission-ledger.js';
import {
  CellLeaseError,
  PostgresCellLeaseRepository,
  startCellLeaseMaintainer
} from '../src/agent-runtime/converact/placement/cell-lease.js';
import {
  ComponentNodeSynchronizer
} from '../src/agent-runtime/converact/placement/component-node-sync.js';
import {
  compileAdmissionNodePools,
  cellAdmissionTopologySha256,
  validateAdmissionNodeCapacity,
  type AdmissionNodeConfig,
  type AdmissionNodePoolConfig
} from '../src/agent-runtime/converact/placement/component-node-topology.js';
import type {
  AdmissionState,
  FlatCapacityState,
  InteractionKind
} from '../src/agent-runtime/converact/placement/types.js';

export interface CellAdmissionRuntimeConfig {
  host: string;
  port: number;
  service_token: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  database_url: string;
  owner_instance_id: string;
  topology_sha256: string;
  lease_ttl_ms: number;
  lease_renewal_interval_ms: number;
  lease_claim_retry_interval_ms: number;
  profile_ids: string[];
  interaction_kinds: InteractionKind[];
  reservation_ttl_ms: number;
  terminal_retention_ms: number;
  sweep_interval_ms: number;
  initial_state: AdmissionState;
  dimensions: FlatCapacityState;
  nodes: AdmissionNodeConfig[];
  max_body_bytes: number;
  component_node_sync:
    | { enabled: false }
    | {
        enabled: true;
        service_token: string;
        lease_ttl_ms: number;
        heartbeat_interval_ms: number;
        timeout_ms: number;
      };
}

export function cellAdmissionRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): CellAdmissionRuntimeConfig {
  const serviceToken = required(env, 'OPC_IVEKIT_CELL_ADMISSION_TOKEN');
  if (serviceToken.length < 24 || serviceToken.length > 512 ||
      /change[_-]?me|replace|placeholder|example/i.test(serviceToken)) {
    throw new Error('OPC_IVEKIT_CELL_ADMISSION_TOKEN is invalid');
  }
  const interactionKinds = csv(
    required(env, 'OPC_IVEKIT_CELL_INTERACTION_KINDS')
  ) as InteractionKind[];
  const allowedKinds = new Set<InteractionKind>([
    'tinode_im',
    'sip_voice',
    'livekit_av',
    'livekit_screen',
    'rustdesk_remote'
  ]);
  if (interactionKinds.some((kind) => !allowedKinds.has(kind))) {
    throw new Error('OPC_IVEKIT_CELL_INTERACTION_KINDS is invalid');
  }
  const dimensions = jsonObject<FlatCapacityState>(
    required(env, 'OPC_IVEKIT_CELL_DIMENSIONS_JSON'),
    'OPC_IVEKIT_CELL_DIMENSIONS_JSON'
  );
  if (Object.keys(dimensions).length === 0) {
    throw new Error('Cell capacity dimensions are required');
  }
  const explicitNodes = String(env.OPC_IVEKIT_CELL_NODES_JSON || '').trim();
  const nodePools = String(env.OPC_IVEKIT_CELL_NODE_POOLS_JSON || '').trim();
  if (Boolean(explicitNodes) === Boolean(nodePools)) {
    throw new Error('exactly one Cell node topology authority is required');
  }
  const nodes = nodePools
    ? compileAndValidateNodePools(jsonArray<AdmissionNodePoolConfig>(
        nodePools,
        'OPC_IVEKIT_CELL_NODE_POOLS_JSON'
      ), dimensions)
    : jsonArray<AdmissionNodeConfig>(
        explicitNodes,
        'OPC_IVEKIT_CELL_NODES_JSON'
      );
  if (nodes.length === 0) throw new Error('Cell admission requires at least one node');
  const leaseTtlMs = integer(
    env.OPC_IVEKIT_CELL_LEASE_TTL_MS,
    30_000,
    3_000,
    300_000
  );
  const reservationTtlMs = integer(
    env.OPC_IVEKIT_CELL_RESERVATION_TTL_MS,
    10_000,
    1_000,
    300_000
  );
  const terminalRetentionMs = integer(
    env.OPC_IVEKIT_CELL_TERMINAL_RETENTION_MS,
    300_000,
    1_000,
    86_400_000
  );
  const profileIds = csv(required(env, 'OPC_IVEKIT_CELL_PROFILE_IDS'));
  validateNodeCapabilities(nodes, profileIds, interactionKinds);
  const componentNodeSync = componentNodeSyncConfig(env, nodes);
  const topologySha256 = cellAdmissionTopologySha256({
    profile_ids: profileIds,
    interaction_kinds: interactionKinds,
    dimensions,
    nodes
  });
  return {
    host: host(env.OPC_IVEKIT_CELL_ADMISSION_HOST || '0.0.0.0'),
    port: integer(env.OPC_IVEKIT_CELL_ADMISSION_PORT, 3200, 1, 65_535),
    service_token: serviceToken,
    region_id: identifier(required(env, 'OPC_IVEKIT_CELL_REGION_ID')),
    zone_id: identifier(required(env, 'OPC_IVEKIT_CELL_ZONE_ID')),
    cell_id: identifier(required(env, 'OPC_IVEKIT_CELL_ID')),
    database_url: requiredDatabaseUrl(
      env.OPC_DATABASE_URL || env.DATABASE_URL
    ),
    owner_instance_id: identifier(
      required(env, 'OPC_IVEKIT_CELL_INSTANCE_ID')
    ),
    topology_sha256: topologySha256,
    lease_ttl_ms: leaseTtlMs,
    lease_renewal_interval_ms: integer(
      env.OPC_IVEKIT_CELL_LEASE_RENEWAL_INTERVAL_MS,
      Math.max(100, Math.floor(leaseTtlMs / 3)),
      100,
      Math.floor(leaseTtlMs / 2)
    ),
    lease_claim_retry_interval_ms: integer(
      env.OPC_IVEKIT_CELL_LEASE_CLAIM_RETRY_MS,
      1_000,
      100,
      60_000
    ),
    profile_ids: profileIds,
    interaction_kinds: interactionKinds,
    reservation_ttl_ms: reservationTtlMs,
    terminal_retention_ms: terminalRetentionMs,
    sweep_interval_ms: integer(
      env.OPC_IVEKIT_CELL_SWEEP_INTERVAL_MS,
      1_000,
      100,
      Math.min(60_000, reservationTtlMs, terminalRetentionMs)
    ),
    initial_state: admissionState(env.OPC_IVEKIT_CELL_INITIAL_STATE || 'draining'),
    dimensions,
    nodes,
    component_node_sync: componentNodeSync,
    max_body_bytes: integer(
      env.OPC_IVEKIT_CELL_ADMISSION_MAX_BODY_BYTES,
      65_536,
      128,
      1_048_576
    )
  };
}

export function createConfiguredCellAdmissionController(
  config: CellAdmissionRuntimeConfig,
  cellLeaseEpoch: number,
  recoveredReservations: CellAdmissionReservationCheckpoint[] = []
): CellAdmissionController {
  return new CellAdmissionController({
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    cell_lease_epoch: cellLeaseEpoch,
    profile_ids: config.profile_ids,
    interaction_kinds: config.interaction_kinds,
    reservation_ttl_ms: config.reservation_ttl_ms,
    terminal_retention_ms: config.terminal_retention_ms,
    dimensions: config.dimensions,
    nodes: config.nodes,
    state: config.initial_state,
    recovered_reservations: recoveredReservations
  });
}

export async function runCellAdmission(
  config: CellAdmissionRuntimeConfig
): Promise<void> {
  const pool = new Pool({
    connectionString: config.database_url,
    max: 2,
    application_name: config.owner_instance_id
  });
  const leaseRepository = new PostgresCellLeaseRepository(pool);
  const reservationLedger = new PostgresCellAdmissionLedger(pool);
  let controller: CellAdmissionController | null = null;
  let nodeSynchronizer: ComponentNodeSynchronizer | null = null;
  let leaseHealthy = true;
  let stopAfterLeaseLoss: (() => void) | null = null;
  let stopAfterSignal: (() => void) | null = null;
  const shutdown = new AbortController();
  const handleSignal = () => {
    shutdown.abort();
    stopAfterSignal?.();
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  const removeSignalHandlers = () => {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  };
  const standbyServer = createCellAdmissionStandbyHttpServer({
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    owner_instance_id: config.owner_instance_id
  });
  try {
    await listenServer(standbyServer, config.port, config.host);
  } catch (error) {
    removeSignalHandlers();
    await pool.end();
    throw error;
  }
  console.log(
    `[ivekit-cell-admission] standby on ${config.host}:${config.port} ` +
    `for ${config.region_id}/${config.zone_id}/${config.cell_id} ` +
    `owner=${config.owner_instance_id}`
  );
  let waitingAttempts = 0;
  let leaseMaintainer: Awaited<ReturnType<typeof startCellLeaseMaintainer>>;
  try {
    leaseMaintainer = await startCellLeaseMaintainer({
      repository: leaseRepository,
      region_id: config.region_id,
      zone_id: config.zone_id,
      cell_id: config.cell_id,
      owner_instance_id: config.owner_instance_id,
      topology_sha256: config.topology_sha256,
      lease_ttl_ms: config.lease_ttl_ms,
      renewal_interval_ms: config.lease_renewal_interval_ms,
      claim_retry_interval_ms: config.lease_claim_retry_interval_ms,
      signal: shutdown.signal,
      on_waiting(error) {
        waitingAttempts += 1;
        if (waitingAttempts === 1 || waitingAttempts % 30 === 0) {
          console.log(
            '[ivekit-cell-admission] waiting for active Cell lease:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
      on_lost(error) {
        leaseHealthy = false;
        controller?.startDrain(new Date());
        console.error(
          '[ivekit-cell-admission] cell lease lost; admission is draining:',
          error instanceof Error ? error.message : String(error)
        );
        stopAfterLeaseLoss?.();
      }
    });
  } catch (error) {
    await closeServer(standbyServer);
    removeSignalHandlers();
    await pool.end();
    if (shutdown.signal.aborted &&
        error instanceof CellLeaseError &&
        error.code === 'cell_lease_acquire_aborted') {
      return;
    }
    throw error;
  }
  const standbyCloseError = await closeServer(standbyServer);
  if (standbyCloseError || shutdown.signal.aborted) {
    await leaseMaintainer.stop().catch(() => undefined);
    removeSignalHandlers();
    await pool.end();
    if (standbyCloseError) throw standbyCloseError;
    return;
  }
  const leader = {
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    owner_instance_id: config.owner_instance_id,
    cell_lease_epoch: leaseMaintainer.lease.lease_epoch
  };
  let server!: ReturnType<typeof createCellAdmissionHttpServer>;
  try {
    const recoveryTime = new Date();
    await reservationLedger.expireDue({
      leader,
      now: recoveryTime.toISOString()
    });
    const recoveredReservations = await reservationLedger.load({
      leader,
      terminal_retention_ms: config.terminal_retention_ms,
      now: recoveryTime.toISOString()
    });
    controller = createConfiguredCellAdmissionController(
      config,
      leaseMaintainer.lease.lease_epoch,
      recoveredReservations
    );
    controller.expireReservations(recoveryTime);
    if (config.component_node_sync.enabled) {
      const targets = controller.componentNodeTargets();
      nodeSynchronizer = new ComponentNodeSynchronizer({
        region_id: config.region_id,
        zone_id: config.zone_id,
        cell_id: config.cell_id,
        cell_lease_epoch: leaseMaintainer.lease.lease_epoch,
        service_token: config.component_node_sync.service_token,
        lease_ttl_ms: config.component_node_sync.lease_ttl_ms,
        timeout_ms: config.component_node_sync.timeout_ms,
        targets
      });
      await nodeSynchronizer.recover({
        checkpoints: recoveredReservations,
        targets,
        cell_state: controller.snapshot().state,
        now: new Date()
      });
    }
    server = createCellAdmissionHttpServer({
      controller,
      service_token: config.service_token,
      region_id: config.region_id,
      zone_id: config.zone_id,
      cell_id: config.cell_id,
      cell_lease_epoch: leaseMaintainer.lease.lease_epoch,
      max_body_bytes: config.max_body_bytes,
      can_accept: () => leaseHealthy,
      persistence: {
        async persist(checkpoint, now) {
          const stored = await reservationLedger.persist({
            checkpoint,
            leader,
            now: now.toISOString()
          });
          if (stored.state !== checkpoint.state) {
            throw new CellAdmissionLedgerError(
              'admission_state_regression',
              409
            );
          }
        }
      },
      ...(nodeSynchronizer
        ? {
            node_sync: {
              async applyCheckpoint(checkpoint, now) {
                await nodeSynchronizer!.applyCheckpoint(checkpoint, now);
              }
            }
          }
        : {})
    });
  } catch (error) {
    await leaseMaintainer.stop().catch(() => undefined);
    removeSignalHandlers();
    await pool.end();
    throw error;
  }
  let sweepInFlight: Promise<void> | null = null;
  const sweepTimer = setInterval(() => {
    if (sweepInFlight) return;
    const now = new Date();
    controller?.expireReservations(now);
    sweepInFlight = reservationLedger.expireDue({
      leader,
      now: now.toISOString()
    }).then(() => undefined).catch((error) => {
      controller?.startDrain(new Date());
      console.error(
        '[ivekit-cell-admission] reservation ledger sweep failed; admission is draining:',
        error instanceof Error ? error.message : String(error)
      );
    }).finally(() => {
      sweepInFlight = null;
    });
  }, config.sweep_interval_ms);
  sweepTimer.unref?.();
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeatTimer = nodeSynchronizer && config.component_node_sync.enabled
    ? setInterval(() => {
        if (heartbeatInFlight || !controller || !nodeSynchronizer) return;
        const targets = controller.componentNodeTargets();
        const availabilityGenerations = new Map(
          targets.map((target) => [
            target.node_id,
            target.availability_generation
          ])
        );
        const desiredStateRevisions = new Map(
          targets.map((target) => [
            target.node_id,
            target.desired_state_revision
          ])
        );
        heartbeatInFlight = nodeSynchronizer.syncLeases({
          targets,
          cell_state: controller.snapshot().state,
          now: new Date()
        }).then((result) => {
          for (const nodeId of result.succeeded) {
            const generation = availabilityGenerations.get(nodeId);
            const desiredStateRevision = desiredStateRevisions.get(nodeId);
            if (generation !== undefined &&
                desiredStateRevision !== undefined) {
              controller?.restoreNodeAvailability(
                nodeId,
                generation,
                desiredStateRevision
              );
            }
          }
          for (const failure of result.failed) {
            const generation = availabilityGenerations.get(failure.node_id);
            if (generation !== undefined) {
              controller?.markNodeUnavailable(
                failure.node_id,
                failure.recovery_safe_after,
                generation
              );
            }
            console.error(
              `[ivekit-cell-admission] component node heartbeat failed for ` +
              `${failure.node_id}: ${failure.error}`
            );
          }
        }).finally(() => {
          heartbeatInFlight = null;
        });
      }, config.component_node_sync.heartbeat_interval_ms)
    : null;
  heartbeatTimer?.unref?.();
  let stopping: Promise<void> | null = null;
  const stop = (reason: 'signal' | 'lease_lost') => {
    if (stopping) return;
    controller.startDrain(new Date());
    clearInterval(sweepTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reason === 'lease_lost') process.exitCode = 1;
    stopping = (async () => {
      await heartbeatInFlight;
      if (nodeSynchronizer) {
        const result = await nodeSynchronizer.syncLeases({
          targets: controller.componentNodeTargets(),
          cell_state: 'draining',
          now: new Date()
        });
        if (result.failed.length > 0) {
          console.error(
            '[ivekit-cell-admission] component node drain heartbeat failed:',
            result.failed.map((item) => item.node_id).join(',')
          );
        }
      }
      const closeError = await closeServer(server);
      await sweepInFlight;
      try {
        await leaseMaintainer.stop();
      } catch (error) {
        console.error(
          '[ivekit-cell-admission] failed to release cell lease:',
          error instanceof Error ? error.message : String(error)
        );
        process.exitCode = 1;
      } finally {
        removeSignalHandlers();
        await pool.end();
      }
      if (closeError) {
        console.error(
          '[ivekit-cell-admission] failed to close HTTP server:',
          closeError.message
        );
        process.exitCode = 1;
      }
    })();
  };
  try {
    await listenServer(server, config.port, config.host);
  } catch (error) {
    clearInterval(sweepTimer);
    await leaseMaintainer.stop().catch(() => undefined);
    removeSignalHandlers();
    await pool.end();
    throw error;
  }
  stopAfterLeaseLoss = () => stop('lease_lost');
  stopAfterSignal = () => stop('signal');
  if (!leaseHealthy) stopAfterLeaseLoss();
  else if (shutdown.signal.aborted) stopAfterSignal();
  console.log(
    `[ivekit-cell-admission] listening on ${config.host}:${config.port} ` +
    `for ${config.region_id}/${config.zone_id}/${config.cell_id} ` +
    `lease=${leaseMaintainer.lease.lease_epoch} ` +
    `owner=${config.owner_instance_id}`
  );
}

async function closeServer(
  server: ReturnType<typeof createCellAdmissionHttpServer>
): Promise<Error | null> {
  return new Promise((resolve) => {
    server.close((error) => resolve(error || null));
  });
}

async function listenServer(
  server: ReturnType<typeof createCellAdmissionHttpServer>,
  port: number,
  host: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function csv(value: string): string[] {
  const result = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (result.length === 0 || new Set(result).size !== result.length) {
    throw new Error('Cell admission CSV configuration is invalid');
  }
  return result.sort();
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value)) {
    throw new Error('Cell admission identifier is invalid');
  }
  return value;
}

function requiredDatabaseUrl(value: string | undefined): string {
  const databaseUrl = String(value || '').trim();
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('OPC_DATABASE_URL must be a PostgreSQL URL');
  }
  return databaseUrl;
}

function host(value: string): string {
  if (!/^[A-Za-z0-9:.-]+$/.test(value)) {
    throw new Error('Cell admission host is invalid');
  }
  return value;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Cell admission numeric configuration is invalid');
  }
  return parsed;
}

function admissionState(value: string): AdmissionState {
  if (!['accepting', 'degraded', 'draining', 'offline'].includes(value)) {
    throw new Error('Cell admission state is invalid');
  }
  return value as AdmissionState;
}

function jsonObject<T extends object>(value: string, field: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} is invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return structuredClone(parsed) as T;
}

function jsonArray<T>(value: string, field: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} is invalid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array`);
  return structuredClone(parsed) as T[];
}

function compileAndValidateNodePools(
  pools: AdmissionNodePoolConfig[],
  dimensions: FlatCapacityState
): AdmissionNodeConfig[] {
  const nodes = compileAdmissionNodePools(pools);
  validateAdmissionNodeCapacity(nodes, dimensions);
  return nodes;
}

function validateNodeCapabilities(
  nodes: AdmissionNodeConfig[],
  profileIds: string[],
  interactionKinds: InteractionKind[]
): void {
  const profiles = new Set(profileIds);
  const kinds = new Set(interactionKinds);
  for (const node of nodes) {
    if (!Array.isArray(node.profile_ids) || node.profile_ids.length === 0 ||
        new Set(node.profile_ids).size !== node.profile_ids.length ||
        node.profile_ids.some((profile) => !profiles.has(profile))) {
      throw new Error('Cell admission node profile_ids are invalid');
    }
    if (!Array.isArray(node.interaction_kinds) ||
        node.interaction_kinds.length === 0 ||
        new Set(node.interaction_kinds).size !== node.interaction_kinds.length ||
        node.interaction_kinds.some((kind) => !kinds.has(kind))) {
      throw new Error('Cell admission node interaction_kinds are invalid');
    }
  }
}

function componentNodeSyncConfig(
  env: NodeJS.ProcessEnv,
  nodes: AdmissionNodeConfig[]
): CellAdmissionRuntimeConfig['component_node_sync'] {
  const controlled = nodes.filter((node) => Boolean(node.control_endpoint));
  if (controlled.length === 0) return { enabled: false };
  if (controlled.length !== nodes.length) {
    throw new Error(
      'component node sync requires control_endpoint on every admission node'
    );
  }
  for (const node of controlled) {
    const endpoint = new URL(String(node.control_endpoint));
    if (!['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username || endpoint.password) {
      throw new Error('component node control_endpoint is invalid');
    }
  }
  const token = required(env, 'OPC_IVEKIT_COMPONENT_NODE_TOKEN');
  if (token.length < 24 || token.length > 512 ||
      /change[_-]?me|replace|placeholder|example/i.test(token)) {
    throw new Error('OPC_IVEKIT_COMPONENT_NODE_TOKEN is invalid');
  }
  const leaseTtlMs = integer(
    env.OPC_IVEKIT_COMPONENT_NODE_LEASE_TTL_MS,
    10_000,
    1_000,
    300_000
  );
  const heartbeatIntervalMs = integer(
    env.OPC_IVEKIT_COMPONENT_NODE_HEARTBEAT_INTERVAL_MS,
    Math.max(100, Math.floor(leaseTtlMs / 3)),
    100,
    Math.floor(leaseTtlMs / 2)
  );
  return {
    enabled: true,
    service_token: token,
    lease_ttl_ms: leaseTtlMs,
    heartbeat_interval_ms: heartbeatIntervalMs,
    timeout_ms: integer(
      env.OPC_IVEKIT_COMPONENT_NODE_TIMEOUT_MS,
      2_000,
      100,
      Math.min(30_000, leaseTtlMs)
    )
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCellAdmission(cellAdmissionRuntimeConfig()).catch((error) => {
    console.error(
      '[ivekit-cell-admission] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
