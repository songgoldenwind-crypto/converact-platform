import { resolveConveractEnv, resolveFabricEnv } from './config/converact-env.js';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';

import {
  ComponentNodeAdmissionController,
  type ComponentNodeComponent
} from './agent-runtime/converact/placement/component-node-admission.js';
import {
  createComponentNodeAdmissionHttpServer,
  type ComponentNodeAdmissionTlsOptions
} from './agent-runtime/converact/placement/component-node-admission-http.js';
import type {
  FlatCapacityState,
  InteractionKind
} from './agent-runtime/converact/placement/types.js';
import {
  RustPbxRecordingSpoolCapacityGate
} from './agent-runtime/converact/recordings/rustpbx-recording-spool-capacity.js';
import {
  RustPbxMediaReadinessProbe,
  type RustPbxMediaReadinessProbeConfig,
  type RustPbxMediaReadinessProfile
} from './agent-runtime/converact/voice/rustpbx-media-readiness.js';

export interface ComponentNodeAdmissionRuntimeConfig {
  host: string;
  port: number;
  service_token: string;
  production: boolean;
  tls?: ComponentNodeAdmissionTlsOptions;
  component: ComponentNodeComponent;
  region_id: string;
  zone_id: string;
  cell_id: string;
  node_id: string;
  profile_ids: string[];
  interaction_kinds: InteractionKind[];
  terminal_retention_ms: number;
  sweep_interval_ms: number;
  dimensions: FlatCapacityState;
  max_body_bytes: number;
  recording_spool_metrics_file: string;
  recording_spool_refresh_ms: number;
  recording_spool_stale_ms: number;
  media_readiness: RustPbxMediaReadinessProbeConfig | null;
}

export function componentNodeAdmissionRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): ComponentNodeAdmissionRuntimeConfig {
  const token = required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_TOKEN');
  if (token.length < 24 || token.length > 512 ||
      /change[_-]?me|replace|placeholder|example/i.test(token)) {
    throw new Error('CONVERACT_FABRIC_COMPONENT_NODE_TOKEN is invalid');
  }
  const production = boolean(
    resolveFabricEnv(env, 'COMPONENT_NODE_PRODUCTION'),
    false,
    'CONVERACT_FABRIC_COMPONENT_NODE_PRODUCTION'
  );
  const requireMtls = boolean(
    resolveFabricEnv(env, 'COMPONENT_NODE_REQUIRE_MTLS'),
    production,
    'CONVERACT_FABRIC_COMPONENT_NODE_REQUIRE_MTLS'
  );
  if (production && !requireMtls) {
    throw new Error('component node production mTLS cannot be disabled');
  }
  const tls = requireMtls ? {
    key: readRequiredFile(env, 'CONVERACT_FABRIC_COMPONENT_NODE_TLS_KEY_FILE'),
    cert: readRequiredFile(env, 'CONVERACT_FABRIC_COMPONENT_NODE_TLS_CERT_FILE'),
    ca: readRequiredFile(env, 'CONVERACT_FABRIC_COMPONENT_NODE_TLS_CA_FILE')
  } : undefined;
  const component = componentValue(
    required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_COMPONENT')
  );
  const interactionKinds = csv(
    required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_INTERACTION_KINDS')
  ) as InteractionKind[];
  validateKinds(component, interactionKinds);
  const dimensions = jsonObject<FlatCapacityState>(
    required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_DIMENSIONS_JSON'),
    'CONVERACT_FABRIC_COMPONENT_NODE_DIMENSIONS_JSON'
  );
  if (Object.keys(dimensions).length === 0) {
    throw new Error('component node capacity dimensions are required');
  }
  const profileIds = csv(
    required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_PROFILE_IDS')
  );
  const mediaReadinessEnabled = boolean(
    resolveFabricEnv(env, 'COMPONENT_NODE_MEDIA_READINESS_ENABLED'),
    false,
    'CONVERACT_FABRIC_COMPONENT_NODE_MEDIA_READINESS_ENABLED'
  );
  let mediaReadiness: RustPbxMediaReadinessProbeConfig | null = null;
  if (mediaReadinessEnabled) {
    if (component !== 'rustpbx') {
      throw new Error('media readiness is supported only for RustPBX');
    }
    const requirements = jsonObject<Record<string, Record<string, number>>>(
      required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_PROFILE_REQUIREMENTS_JSON'),
      'CONVERACT_FABRIC_COMPONENT_NODE_PROFILE_REQUIREMENTS_JSON'
    );
    const readinessProfiles = new Set(csv(required(
      env,
      'CONVERACT_FABRIC_COMPONENT_NODE_READINESS_PROFILE_IDS'
    )));
    if (Object.keys(requirements).length !== profileIds.length ||
        profileIds.some((profileId) => !requirements[profileId]) ||
        [...readinessProfiles].some((profileId) => !profileIds.includes(profileId))) {
      throw new Error('RustPBX media readiness profiles do not match component profiles');
    }
    const profiles: RustPbxMediaReadinessProfile[] = profileIds.map(
      (profileId) => ({
        id: profileId,
        required_capacity: requirements[profileId],
        required_for_pod_readiness: readinessProfiles.has(profileId)
      })
    );
    mediaReadiness = {
      route_snapshot_file: required(
        env,
        'CONVERACT_FABRIC_COMPONENT_NODE_ROUTE_SNAPSHOT_FILE'
      ),
      route_snapshot_signing_key: readRequiredTextFile(
        env,
        'CONVERACT_FABRIC_COMPONENT_NODE_ROUTE_SNAPSHOT_HMAC_KEY_FILE'
      ),
      route_tenant_id: identifier(required(
        env,
        'CONVERACT_FABRIC_COMPONENT_NODE_ROUTE_TENANT_ID'
      )),
      route_profile_id: identifier(required(
        env,
        'CONVERACT_FABRIC_COMPONENT_NODE_ROUTE_PROFILE_ID'
      )),
      media_control_endpoint: required(
        env,
        'CONVERACT_FABRIC_COMPONENT_NODE_MEDIA_CONTROL_ENDPOINT'
      ),
      media_control_identity: readRequiredFile(
        env,
        'CONVERACT_FABRIC_COMPONENT_NODE_MEDIA_CONTROL_TLS_IDENTITY_FILE'
      ),
      media_control_ca: readRequiredFile(
        env,
        'CONVERACT_FABRIC_COMPONENT_NODE_MEDIA_CONTROL_TLS_CA_FILE'
      ),
      media_control_timeout_ms: integer(
        resolveFabricEnv(env, 'COMPONENT_NODE_MEDIA_CONTROL_TIMEOUT_MS'),
        500,
        50,
        5_000
      ),
      refresh_interval_ms: integer(
        resolveFabricEnv(env, 'COMPONENT_NODE_MEDIA_READINESS_REFRESH_MS'),
        1_000,
        100,
        30_000
      ),
      profiles
    };
  }
  const recordingSpoolMetricsFile = String(
    resolveFabricEnv(env, 'COMPONENT_NODE_RECORDING_SPOOL_METRICS_FILE') || ''
  ).trim();
  if (recordingSpoolMetricsFile) {
    if (component !== 'rustpbx') {
      throw new Error('recording spool metrics are supported only for RustPBX');
    }
    if (!isAbsolute(recordingSpoolMetricsFile)) {
      throw new Error('recording spool metrics file must be absolute');
    }
    const dimension = dimensions['data.local_spool_bytes'];
    if (!dimension || dimension.unit !== 'bytes') {
      throw new Error('RustPBX recording spool requires data.local_spool_bytes capacity');
    }
  }
  return {
    host: host(resolveFabricEnv(env, 'COMPONENT_NODE_HOST') || '0.0.0.0'),
    port: integer(resolveFabricEnv(env, 'COMPONENT_NODE_PORT'), 3210, 1, 65_535),
    service_token: token,
    production,
    ...(tls ? { tls } : {}),
    component,
    region_id: identifier(required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_REGION_ID')),
    zone_id: identifier(required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_ZONE_ID')),
    cell_id: identifier(required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_CELL_ID')),
    node_id: identifier(required(env, 'CONVERACT_FABRIC_COMPONENT_NODE_ID')),
    profile_ids: profileIds,
    interaction_kinds: interactionKinds,
    terminal_retention_ms: integer(
      resolveFabricEnv(env, 'COMPONENT_NODE_TERMINAL_RETENTION_MS'),
      300_000,
      1_000,
      86_400_000
    ),
    sweep_interval_ms: integer(
      resolveFabricEnv(env, 'COMPONENT_NODE_SWEEP_INTERVAL_MS'),
      1_000,
      100,
      60_000
    ),
    dimensions,
    max_body_bytes: integer(
      resolveFabricEnv(env, 'COMPONENT_NODE_MAX_BODY_BYTES'),
      65_536,
      128,
      1_048_576
    ),
    recording_spool_metrics_file: recordingSpoolMetricsFile,
    recording_spool_refresh_ms: integer(
      resolveFabricEnv(env, 'COMPONENT_NODE_RECORDING_SPOOL_REFRESH_MS'),
      1_000,
      100,
      60_000
    ),
    recording_spool_stale_ms: integer(
      resolveFabricEnv(env, 'COMPONENT_NODE_RECORDING_SPOOL_STALE_MS'),
      5_000,
      1_000,
      300_000
    ),
    media_readiness: mediaReadiness
  };
}

export function createConfiguredComponentNodeAdmissionController(
  config: ComponentNodeAdmissionRuntimeConfig
): ComponentNodeAdmissionController {
  return new ComponentNodeAdmissionController({
    component: config.component,
    region_id: config.region_id,
    zone_id: config.zone_id,
    cell_id: config.cell_id,
    node_id: config.node_id,
    profile_ids: config.profile_ids,
    interaction_kinds: config.interaction_kinds,
    terminal_retention_ms: config.terminal_retention_ms,
    dimensions: config.dimensions
  });
}

export function createConfiguredRustPbxRecordingSpoolCapacityGate(
  config: ComponentNodeAdmissionRuntimeConfig
): RustPbxRecordingSpoolCapacityGate | null {
  if (!config.recording_spool_metrics_file) return null;
  return new RustPbxRecordingSpoolCapacityGate({
    metrics_file: config.recording_spool_metrics_file,
    stale_after_ms: config.recording_spool_stale_ms
  });
}

export async function runComponentNodeAdmission(
  config: ComponentNodeAdmissionRuntimeConfig
): Promise<void> {
  const controller = createConfiguredComponentNodeAdmissionController(config);
  const recordingSpoolGate = createConfiguredRustPbxRecordingSpoolCapacityGate(config);
  const mediaReadiness = config.media_readiness
    ? new RustPbxMediaReadinessProbe(config.media_readiness)
    : null;
  await recordingSpoolGate?.refresh();
  const server = createComponentNodeAdmissionHttpServer({
    controller,
    service_token: config.service_token,
    production: config.production,
    tls: config.tls,
    max_body_bytes: config.max_body_bytes,
    before_new_reservation: recordingSpoolGate
      ? (checkpoint, now) => recordingSpoolGate.assertReservation(
          checkpoint.required_capacity,
          now
        )
      : undefined,
    readiness: mediaReadiness
      ? (state, now) => mediaReadiness.evaluate(state, now)
      : undefined,
    additional_metrics: recordingSpoolGate || mediaReadiness
      ? (now) => [
          recordingSpoolGate?.prometheusMetrics(now) || '',
          mediaReadiness?.prometheusMetrics() || ''
        ].filter(Boolean).join('')
      : undefined
  });
  const sweepTimer = setInterval(() => {
    controller.expireReservations(new Date());
  }, config.sweep_interval_ms);
  sweepTimer.unref?.();
  const recordingSpoolTimer = recordingSpoolGate
    ? setInterval(() => void recordingSpoolGate.refresh(), config.recording_spool_refresh_ms)
    : null;
  recordingSpoolTimer?.unref?.();
  let stopping: Promise<void> | null = null;
  const stop = () => {
    if (stopping) return;
    controller.startDrain(new Date());
    clearInterval(sweepTimer);
    if (recordingSpoolTimer) clearInterval(recordingSpoolTimer);
    stopping = closeServer(server).catch((error) => {
      console.error(
        '[ivekit-component-node-admission] failed to close HTTP server:',
        error instanceof Error ? error.message : String(error)
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    clearInterval(sweepTimer);
    if (recordingSpoolTimer) clearInterval(recordingSpoolTimer);
    throw error;
  }
  console.log(
    `[ivekit-component-node-admission] listening on ${config.host}:${config.port} ` +
    `for ${config.component} ${config.region_id}/${config.zone_id}/${config.cell_id}/` +
    `${config.node_id} state=draining`
  );
}

function componentValue(value: string): ComponentNodeComponent {
  if (!['rustpbx', 'livekit', 'tinode', 'rustdesk'].includes(value)) {
    throw new Error('CONVERACT_FABRIC_COMPONENT_NODE_COMPONENT is invalid');
  }
  return value as ComponentNodeComponent;
}

function validateKinds(
  component: ComponentNodeComponent,
  kinds: InteractionKind[]
): void {
  const expected: Record<InteractionKind, ComponentNodeComponent> = {
    tinode_im: 'tinode',
    sip_voice: 'rustpbx',
    livekit_av: 'livekit',
    livekit_screen: 'livekit',
    rustdesk_remote: 'rustdesk'
  };
  if (kinds.some((kind) => expected[kind] !== component)) {
    throw new Error('component node interaction kind does not match component');
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(resolveConveractEnv(env, key) || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function csv(value: string): string[] {
  const result = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (result.length === 0 || new Set(result).size !== result.length) {
    throw new Error('component node CSV configuration is invalid');
  }
  return result.sort();
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/.test(value)) {
    throw new Error('component node identifier is invalid');
  }
  return value;
}

function host(value: string): string {
  if (!/^[A-Za-z0-9:.-]+$/.test(value)) {
    throw new Error('component node host is invalid');
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
    throw new Error('component node numeric configuration is invalid');
  }
  return parsed;
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

function closeServer(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function boolean(
  raw: string | undefined,
  fallback: boolean,
  field: string
): boolean {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${field} must be true or false`);
}

function readRequiredFile(
  env: NodeJS.ProcessEnv,
  field: string
): Buffer {
  const value = readFileSync(required(env, field));
  if (value.length < 1) throw new Error(`${field} is empty`);
  return value;
}

function readRequiredTextFile(
  env: NodeJS.ProcessEnv,
  field: string
): string {
  const value = readRequiredFile(env, field).toString('utf8').trim();
  if (!value) throw new Error(`${field} is empty`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runComponentNodeAdmission(componentNodeAdmissionRuntimeConfig()).catch((error) => {
    console.error(
      '[ivekit-component-node-admission] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
