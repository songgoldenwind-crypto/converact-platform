import { resolveConveractEnv, resolveFabricEnv } from './config/converact-env.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { KamailioConfig } from './agent-runtime/converact/voice/kamailio-config.js';

export interface KamailioComposeTopology {
  pools: Array<{
    pool_id: number;
    profile_id: string;
    capacity_dimension: string;
    nodes: Array<{
      node_id: string;
      component_endpoint: string;
      service_token_file: string;
      sip_uri: string;
      pin_set_id: number;
      priority: number;
      safe_capacity_fallback: number;
    }>;
  }>;
}

export interface KamailioComposeRuntime {
  config: KamailioConfig;
  topology: KamailioComposeTopology;
}

const CONFIG_OUTPUT = '/etc/ivekit-kamailio/kamailio-runtime.json';
const TOPOLOGY_OUTPUT = '/etc/ivekit-kamailio/kamailio-topology.json';

export function buildKamailioComposeRuntime(
  env: NodeJS.ProcessEnv = process.env
): KamailioComposeRuntime {
  const regionId = identifier(required(env, 'CONVERACT_FABRIC_KAMAILIO_REGION_ID'));
  const zoneId = identifier(required(env, 'CONVERACT_FABRIC_KAMAILIO_ZONE_ID'));
  const cellId = identifier(required(env, 'CONVERACT_FABRIC_KAMAILIO_CELL_ID'));
  const profileId = identifier(required(env, 'CONVERACT_FABRIC_KAMAILIO_PROFILE_ID'));
  const sipHost = networkHost(required(env, 'CONVERACT_FABRIC_KAMAILIO_ADVERTISE_SIP_HOST'));
  const wssHost = networkHost(
    resolveFabricEnv(env, 'KAMAILIO_ADVERTISE_WSS_HOST') || sipHost
  );
  const sipPort = integer(resolveFabricEnv(env, 'KAMAILIO_SIP_PORT'), 5_060, 1, 65_535);
  const tlsPort = integer(resolveFabricEnv(env, 'KAMAILIO_TLS_PORT'), 5_061, 1, 65_535);
  const wssPort = integer(resolveFabricEnv(env, 'KAMAILIO_WSS_PORT'), 7_443, 1, 65_535);
  const rpcPort = integer(resolveFabricEnv(env, 'KAMAILIO_RPC_PORT'), 5_065, 1, 65_535);
  if (new Set([sipPort, tlsPort, wssPort, rpcPort]).size !== 4) {
    throw new Error('Kamailio Compose listener ports must be distinct');
  }
  const poolId = integer(resolveFabricEnv(env, 'KAMAILIO_POOL_ID'), 100, 1, 999_999_999);
  const pinSetBase = integer(
    resolveFabricEnv(env, 'KAMAILIO_PIN_SET_BASE'),
    10_000,
    1,
    999_999_998
  );
  const safeCapacity = integer(
    resolveFabricEnv(env, 'KAMAILIO_SAFE_CAPACITY_FALLBACK'),
    2_500,
    1,
    1_000_000_000
  );
  const priority = integer(resolveFabricEnv(env, 'KAMAILIO_POOL_PRIORITY'), 10, 0, 65_535);
  const perSourceCps = integer(
    resolveFabricEnv(env, 'KAMAILIO_PER_SOURCE_INVITE_CPS'),
    20,
    1,
    100_000
  );
  const globalCps = integer(
    resolveFabricEnv(env, 'KAMAILIO_CELL_INVITE_CPS'),
    500,
    perSourceCps,
    1_000_000
  );
  const sipTraceEnabled = booleanValue(
    resolveFabricEnv(env, 'KAMAILIO_SIP_TRACE_ENABLED'),
    false,
    'CONVERACT_FABRIC_KAMAILIO_SIP_TRACE_ENABLED'
  );
  const hepHighWaterEnabled = booleanValue(
    resolveFabricEnv(env, 'KAMAILIO_HEP_HIGH_WATER_ENABLED'),
    false,
    'CONVERACT_FABRIC_KAMAILIO_HEP_HIGH_WATER_ENABLED'
  );
  if (sipTraceEnabled !== hepHighWaterEnabled) {
    throw new Error(
      'Kamailio SIP trace and HEP high-water protection must be enabled together'
    );
  }
  const nodeIds = [
    identifier(required(env, 'RUSTPBX_OWNER_NODE_ID')),
    identifier(required(env, 'RUSTPBX_OWNER_NODE_ID_B'))
  ];
  if (nodeIds[0] === nodeIds[1]) throw new Error('RustPBX Compose node IDs must be distinct');

  const config: KamailioConfig = {
    schema_version: '1.0.0',
    region_id: regionId,
    zone_id: zoneId,
    cell_id: cellId,
    cell_lease_epoch: integer(
      resolveFabricEnv(env, 'KAMAILIO_CELL_LEASE_EPOCH'),
      1,
      1,
      0xffff_ffff
    ),
    default_pool_id: poolId,
    dispatcher_file: '/var/lib/kamailio/dispatcher.list',
    tls_config_file: '/etc/kamailio/tls.cfg',
    udp_listener: listener(sipPort, sipHost, sipPort),
    tcp_listener: listener(sipPort, sipHost, sipPort),
    tls_listener: listener(tlsPort, sipHost, tlsPort),
    wss_listener: listener(wssPort, wssHost, wssPort),
    rpc_listener: { host: '127.0.0.1', port: rpcPort },
    trusted_source_cidrs: cidrs(required(
      env,
      'CONVERACT_FABRIC_KAMAILIO_TRUSTED_SOURCE_CIDRS'
    )),
    rustpbx_source_cidrs: cidrs(required(
      env,
      'CONVERACT_FABRIC_KAMAILIO_RUSTPBX_SOURCE_CIDRS'
    )),
    dmq_source_cidrs: cidrs(
      resolveFabricEnv(env, 'KAMAILIO_DMQ_SOURCE_CIDRS') || '127.0.0.1/32'
    ),
    allow_public_wss: booleanValue(
      resolveFabricEnv(env, 'KAMAILIO_ALLOW_PUBLIC_WSS'),
      true,
      'CONVERACT_FABRIC_KAMAILIO_ALLOW_PUBLIC_WSS'
    ),
    webphone_auth: {
      jwt_issuer: safeClaim(required(env, 'CONVERACT_FABRIC_WEBPHONE_JWT_ISSUER')),
      jwt_audience: safeClaim(required(env, 'CONVERACT_FABRIC_WEBPHONE_JWT_AUDIENCE')),
      jwt_secret_file: '/run/secrets/kamailio-webphone-jwt-secret',
      allowed_origins: webOrigins(required(
        env,
        'CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ALLOWED_ORIGINS'
      )),
      max_token_bytes: 4_096,
      max_registration_expires_seconds: integer(
        resolveFabricEnv(env, 'WEBPHONE_REGISTER_EXPIRES_SECONDS'),
        240,
        30,
        300
      )
    },
    dmq: {
      enabled: false,
      server_host: 'kamailio',
      server_port: sipPort,
      notification_addresses: [`sip:kamailio:${sipPort}`],
      num_workers: 2,
      ping_interval_seconds: 30,
      sync_batch_size: 4_000,
      sync_batch_usleep: 1_000,
      sync_message_contacts: 50
    },
    sip_trace: {
      enabled: sipTraceEnabled,
      collector_host: networkHost(
        resolveFabricEnv(env, 'KAMAILIO_HEP_COLLECTOR_HOST') || '127.0.0.1'
      ),
      collector_port: integer(
        resolveFabricEnv(env, 'KAMAILIO_HEP_COLLECTOR_PORT'),
        9_060,
        1,
        65_535
      ),
      capture_id: integer(
        resolveFabricEnv(env, 'KAMAILIO_HEP_CAPTURE_ID'),
        101,
        1,
        0xffff_ffff
      ),
      include_options: booleanValue(
        resolveFabricEnv(env, 'KAMAILIO_HEP_INCLUDE_OPTIONS'),
        false,
        'CONVERACT_FABRIC_KAMAILIO_HEP_INCLUDE_OPTIONS'
      ),
      initial_mode: sipTraceEnabled && hepHighWaterEnabled ? 'off' : 'full'
    },
    max_message_bytes: integer(
      resolveFabricEnv(env, 'KAMAILIO_MAX_MESSAGE_BYTES'),
      65_536,
      4_096,
      1_048_576
    ),
    per_source_invite_cps: perSourceCps,
    global_invite_cps: globalCps,
    pike_sampling_seconds: integer(
      resolveFabricEnv(env, 'KAMAILIO_PIKE_SAMPLING_SECONDS'),
      2,
      1,
      60
    ),
    pike_request_density: integer(
      resolveFabricEnv(env, 'KAMAILIO_PIKE_REQUEST_DENSITY'),
      100,
      1,
      1_000_000
    ),
    max_failovers: integer(resolveFabricEnv(env, 'KAMAILIO_MAX_FAILOVERS'), 2, 1, 32),
    retry_after_seconds: integer(
      resolveFabricEnv(env, 'KAMAILIO_RETRY_AFTER_SECONDS'),
      1,
      1,
      300
    ),
    tls: {
      private_key_file: '/run/secrets/kamailio-tls-key',
      certificate_file: '/run/secrets/kamailio-tls-cert',
      ca_file: '/run/secrets/kamailio-tls-ca',
      require_client_certificate: booleanValue(
        resolveFabricEnv(env, 'KAMAILIO_REQUIRE_CLIENT_CERTIFICATE'),
        false,
        'CONVERACT_FABRIC_KAMAILIO_REQUIRE_CLIENT_CERTIFICATE'
      )
    }
  };
  const topology: KamailioComposeTopology = {
    pools: [{
      pool_id: poolId,
      profile_id: profileId,
      capacity_dimension: 'voice.weighted_calls',
      nodes: [
        composeNode(nodeIds[0]!, 'rustpbx', pinSetBase, priority, safeCapacity),
        composeNode(nodeIds[1]!, 'rustpbx-b', pinSetBase + 1, priority, safeCapacity)
      ]
    }]
  };
  return { config, topology };
}

export async function writeKamailioComposeRuntime(
  runtime: KamailioComposeRuntime,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const configOutput = absoluteOutput(
    resolveFabricEnv(env, 'KAMAILIO_COMPOSE_CONFIG_OUTPUT') || CONFIG_OUTPUT
  );
  const topologyOutput = absoluteOutput(
    resolveFabricEnv(env, 'KAMAILIO_COMPOSE_TOPOLOGY_OUTPUT') || TOPOLOGY_OUTPUT
  );
  if (configOutput === topologyOutput) throw new Error('Kamailio Compose outputs must be distinct');
  await Promise.all([
    atomicJsonWrite(configOutput, runtime.config),
    atomicJsonWrite(topologyOutput, runtime.topology)
  ]);
}

function composeNode(
  nodeId: string,
  service: string,
  pinSetId: number,
  priority: number,
  safeCapacityFallback: number
): KamailioComposeTopology['pools'][number]['nodes'][number] {
  return {
    node_id: nodeId,
    component_endpoint: `http://${service}:3210`,
    service_token_file: '/run/secrets/component-node-token',
    sip_uri: `sip:${service}:5060;transport=udp`,
    pin_set_id: pinSetId,
    priority,
    safe_capacity_fallback: safeCapacityFallback
  };
}

function listener(port: number, advertiseHost: string, advertisePort: number) {
  return {
    host: '0.0.0.0',
    port,
    advertise: { host: advertiseHost, port: advertisePort }
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(resolveConveractEnv(env, name) || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Kamailio Compose identifier is invalid');
  }
  return value;
}

function networkHost(value: string): string {
  if (value.length > 253 || value === '0.0.0.0' || value === '::' ||
      !value.split('.').every((part) => /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(part))) {
    throw new Error('Kamailio Compose advertised host is invalid');
  }
  return value;
}

function safeClaim(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,199}$/.test(value)) {
    throw new Error('Kamailio WebPhone JWT claim is invalid');
  }
  return value;
}

function webOrigins(value: string): string[] {
  const origins = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!origins.length || origins.length > 64) {
    throw new Error('Kamailio WebPhone allowed origins are invalid');
  }
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search ||
        parsed.hash || parsed.pathname !== '/' || parsed.origin !== origin) {
      throw new Error('Kamailio WebPhone allowed origins must be exact HTTPS origins');
    }
  }
  return origins;
}

function cidrs(value: string): string[] {
  const result = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (result.length < 1 || result.length > 256 || new Set(result).size !== result.length) {
    throw new Error('Kamailio Compose trusted source CIDRs are invalid');
  }
  return result;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Kamailio Compose numeric configuration is invalid');
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value == null || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function absoluteOutput(value: string): string {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error('Kamailio Compose output path must be absolute');
  }
  return value;
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o640);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o640);
}

async function main(): Promise<void> {
  await writeKamailioComposeRuntime(buildKamailioComposeRuntime());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      '[ivekit-kamailio-compose-config] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
