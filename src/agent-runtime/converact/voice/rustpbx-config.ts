import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';

export interface RustPbxConfigSummary {
  database: 'postgresql';
  image_immutable: true;
  sip_port: number;
  rtp_start_port: number;
  rtp_end_port: number;
  sip_max_active_transactions: number;
  sip_max_finished_transactions: number;
  sip_incoming_transaction_queue_capacity: number;
  sip_max_transport_connections: number;
  media_session_cleanup_concurrency: number;
  media_session_cleanup_timeout_ms: number;
  media_recording_channel_capacity: number;
  media_recording_worker_threads: number;
  media_recording_worker_queue_capacity: number;
  realtime_audio_tap_enabled: boolean;
  realtime_audio_tap_channel_capacity: number;
  realtime_audio_tap_send_timeout_ms: number;
  call_record_max_concurrent: number;
  call_record_channel_capacity: number;
  call_record_worker_threads: number;
  management_exposure: 'internal';
  rwi_exposure: 'internal';
}

export interface RustPbxRenderedConfig {
  config: string;
  summary: RustPbxConfigSummary;
}

interface RustPbxRenderInput {
  database_url: string;
  image: string;
  ami_allows: string[];
  management_token: string;
  rwi_token: string;
  webhook_token: string;
  router_url: string;
  external_ip: string;
  sip_port: number;
  rtp_start_port: number;
  rtp_end_port: number;
  sip_max_active_transactions: number;
  sip_max_finished_transactions: number;
  sip_incoming_transaction_queue_capacity: number;
  sip_max_transport_connections: number;
  media_session_cleanup_concurrency: number;
  media_session_cleanup_timeout_ms: number;
  media_recording_channel_capacity: number;
  media_recording_worker_threads: number;
  media_recording_worker_queue_capacity: number;
  realtime_audio_tap_socket_path: string;
  realtime_audio_tap_channel_capacity: number;
  realtime_audio_tap_send_timeout_ms: number;
  call_record_max_concurrent: number;
  call_record_channel_capacity: number;
  call_record_worker_threads: number;
  webphone: {
    jwt_secret: string;
    jwt_issuer: string;
    jwt_audience: string;
  } | null;
}

const HTTP_PORT = 8080;
const MIN_RTP_PORTS = 100;
const MAX_SIP_CAPACITY_VALUE = 10_000_000;

export function renderRustPbxConfig(env: NodeJS.ProcessEnv): RustPbxRenderedConfig {
  const input = inputFromEnv(env);
  return {
    config: renderConfig(input),
    summary: {
      database: 'postgresql',
      image_immutable: true,
      sip_port: input.sip_port,
      rtp_start_port: input.rtp_start_port,
      rtp_end_port: input.rtp_end_port,
      sip_max_active_transactions: input.sip_max_active_transactions,
      sip_max_finished_transactions: input.sip_max_finished_transactions,
      sip_incoming_transaction_queue_capacity: input.sip_incoming_transaction_queue_capacity,
      sip_max_transport_connections: input.sip_max_transport_connections,
      media_session_cleanup_concurrency: input.media_session_cleanup_concurrency,
      media_session_cleanup_timeout_ms: input.media_session_cleanup_timeout_ms,
      media_recording_channel_capacity: input.media_recording_channel_capacity,
      media_recording_worker_threads: input.media_recording_worker_threads,
      media_recording_worker_queue_capacity: input.media_recording_worker_queue_capacity,
      realtime_audio_tap_enabled: true,
      realtime_audio_tap_channel_capacity: input.realtime_audio_tap_channel_capacity,
      realtime_audio_tap_send_timeout_ms: input.realtime_audio_tap_send_timeout_ms,
      call_record_max_concurrent: input.call_record_max_concurrent,
      call_record_channel_capacity: input.call_record_channel_capacity,
      call_record_worker_threads: input.call_record_worker_threads,
      management_exposure: 'internal',
      rwi_exposure: 'internal'
    }
  };
}

export function writeRustPbxConfig(
  env: NodeJS.ProcessEnv,
  outputPath = env.RUSTPBX_CONFIG_OUTPUT || '/app/config/rustpbx.toml'
): { path: string; summary: RustPbxConfigSummary } {
  const rendered = renderRustPbxConfig(env);
  const path = resolve(outputPath);
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporary, rendered.config, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return { path, summary: rendered.summary };
}

function inputFromEnv(env: NodeJS.ProcessEnv): RustPbxRenderInput {
  const databaseUrl = postgresDatabaseUrl(
    required(env, 'RUSTPBX_DATABASE_URL'),
    String(env.RUSTPBX_DB_PASSWORD || '')
  );
  const image = immutableImage(required(env, 'RUSTPBX_IMAGE'));
  const sipPort = port(env.RUSTPBX_SIP_PORT, 'RUSTPBX_SIP_PORT', 5060);
  const rtpStartPort = port(env.RUSTPBX_RTP_START_PORT, 'RUSTPBX_RTP_START_PORT', 20_000);
  const rtpEndPort = port(env.RUSTPBX_RTP_END_PORT, 'RUSTPBX_RTP_END_PORT', 20_100);
  validateRtpRange(rtpStartPort, rtpEndPort, [sipPort, HTTP_PORT]);
  const managementToken = runtimeSecret(env, 'RUSTPBX_MANAGEMENT_TOKEN');
  const rwiToken = runtimeSecret(env, 'RUSTPBX_RWI_TOKEN');
  if (managementToken === rwiToken) {
    throw new Error('RUSTPBX_MANAGEMENT_TOKEN and RUSTPBX_RWI_TOKEN must be distinct');
  }
  const webhookToken = runtimeSecret(env, 'RUSTPBX_WEBHOOK_TOKEN');
  const webphone = webphoneAuth(env, [managementToken, rwiToken, webhookToken]);
  return {
    database_url: databaseUrl,
    image,
    ami_allows: amiAllows(required(env, 'RUSTPBX_AMI_ALLOWS')),
    management_token: managementToken,
    rwi_token: rwiToken,
    webhook_token: webhookToken,
    router_url: internalHttpUrl(required(env, 'RUSTPBX_ROUTER_URL'), 'RUSTPBX_ROUTER_URL'),
    external_ip: optionalIp(env.RUSTPBX_EXTERNAL_IP),
    sip_port: sipPort,
    rtp_start_port: rtpStartPort,
    rtp_end_port: rtpEndPort,
    sip_max_active_transactions: positiveCapacity(
      env.RUSTPBX_SIP_MAX_ACTIVE_TRANSACTIONS,
      'RUSTPBX_SIP_MAX_ACTIVE_TRANSACTIONS',
      65_536
    ),
    sip_max_finished_transactions: positiveCapacity(
      env.RUSTPBX_SIP_MAX_FINISHED_TRANSACTIONS,
      'RUSTPBX_SIP_MAX_FINISHED_TRANSACTIONS',
      65_536
    ),
    sip_incoming_transaction_queue_capacity: positiveCapacity(
      env.RUSTPBX_SIP_INCOMING_TRANSACTION_QUEUE_CAPACITY,
      'RUSTPBX_SIP_INCOMING_TRANSACTION_QUEUE_CAPACITY',
      8_192
    ),
    sip_max_transport_connections: positiveCapacity(
      env.RUSTPBX_SIP_MAX_TRANSPORT_CONNECTIONS,
      'RUSTPBX_SIP_MAX_TRANSPORT_CONNECTIONS',
      32_768
    ),
    media_session_cleanup_concurrency: positiveCapacity(
      env.RUSTPBX_MEDIA_SESSION_CLEANUP_CONCURRENCY,
      'RUSTPBX_MEDIA_SESSION_CLEANUP_CONCURRENCY',
      64,
      4_096
    ),
    media_session_cleanup_timeout_ms: positiveCapacity(
      env.RUSTPBX_MEDIA_SESSION_CLEANUP_TIMEOUT_MS,
      'RUSTPBX_MEDIA_SESSION_CLEANUP_TIMEOUT_MS',
      2_000,
      60_000
    ),
    media_recording_channel_capacity: positiveCapacity(
      env.RUSTPBX_MEDIA_RECORDING_CHANNEL_CAPACITY,
      'RUSTPBX_MEDIA_RECORDING_CHANNEL_CAPACITY',
      256,
      65_536
    ),
    media_recording_worker_threads: positiveCapacity(
      env.RUSTPBX_MEDIA_RECORDING_WORKER_THREADS,
      'RUSTPBX_MEDIA_RECORDING_WORKER_THREADS',
      4,
      64
    ),
    media_recording_worker_queue_capacity: positiveCapacity(
      env.RUSTPBX_MEDIA_RECORDING_WORKER_QUEUE_CAPACITY,
      'RUSTPBX_MEDIA_RECORDING_WORKER_QUEUE_CAPACITY',
      4_096,
      65_536
    ),
    realtime_audio_tap_socket_path: unixSocketPath(
      env.RUSTPBX_REALTIME_AUDIO_TAP_SOCKET_PATH
        || '/run/ivekit/realtime-audio-tap.sock',
      'RUSTPBX_REALTIME_AUDIO_TAP_SOCKET_PATH'
    ),
    realtime_audio_tap_channel_capacity: positiveCapacity(
      env.RUSTPBX_REALTIME_AUDIO_TAP_CHANNEL_CAPACITY,
      'RUSTPBX_REALTIME_AUDIO_TAP_CHANNEL_CAPACITY',
      256,
      65_536
    ),
    realtime_audio_tap_send_timeout_ms: positiveCapacity(
      env.RUSTPBX_REALTIME_AUDIO_TAP_SEND_TIMEOUT_MS,
      'RUSTPBX_REALTIME_AUDIO_TAP_SEND_TIMEOUT_MS',
      10,
      1_000
    ),
    call_record_max_concurrent: positiveCapacity(
      env.RUSTPBX_CALL_RECORD_MAX_CONCURRENT,
      'RUSTPBX_CALL_RECORD_MAX_CONCURRENT',
      64,
      4_096
    ),
    call_record_channel_capacity: positiveCapacity(
      env.RUSTPBX_CALL_RECORD_CHANNEL_CAPACITY,
      'RUSTPBX_CALL_RECORD_CHANNEL_CAPACITY',
      65_536,
      262_144
    ),
    call_record_worker_threads: positiveCapacity(
      env.RUSTPBX_CALL_RECORD_WORKER_THREADS,
      'RUSTPBX_CALL_RECORD_WORKER_THREADS',
      1,
      16
    ),
    webphone
  };
}

function renderConfig(input: RustPbxRenderInput): string {
  return [
    '# Generated by the iveKit RustPBX config renderer. Do not edit or commit.',
    'http_addr = "0.0.0.0:8080"',
    'log_level = "info"',
    `database_url = ${tomlString(input.database_url)}`,
    `rtp_start_port = ${input.rtp_start_port}`,
    `rtp_end_port = ${input.rtp_end_port}`,
    ...(input.external_ip ? [`external_ip = ${tomlString(input.external_ip)}`] : []),
    'storage_dir = "/app/storage"',
    '',
    '[console]',
    'base_path = "/console"',
    'api_prefix = "/api"',
    'allow_registration = false',
    'secure_cookie = false',
    '',
    '[[console.api_tokens]]',
    `token = ${tomlString(input.management_token)}`,
    'scopes = ["extensions.write", "trunks.write", "routing.write"]',
    'description = "iveKit management adapter"',
    '',
    '[ami]',
    `allows = [${input.ami_allows.map(tomlString).join(', ')}]`,
    '',
    '[proxy]',
    'addr = "0.0.0.0"',
    'generated_dir = "/app/generated"',
    `udp_port = ${input.sip_port}`,
    `tcp_port = ${input.sip_port}`,
    'modules = ["acl", "auth", "presence", "registrar", "call"]',
    'media_proxy = "auto"',
    'ensure_user = true',
    ...(input.webphone ? ['ws_handler = "/ws"'] : []),
    'acl_rules = ["allow all", "deny all"]',
    `sip_max_active_transactions = ${input.sip_max_active_transactions}`,
    `sip_max_finished_transactions = ${input.sip_max_finished_transactions}`,
    `sip_incoming_transaction_queue_capacity = ${input.sip_incoming_transaction_queue_capacity}`,
    `sip_max_transport_connections = ${input.sip_max_transport_connections}`,
    `media_session_cleanup_concurrency = ${input.media_session_cleanup_concurrency}`,
    `media_session_cleanup_timeout_ms = ${input.media_session_cleanup_timeout_ms}`,
    `media_recording_channel_capacity = ${input.media_recording_channel_capacity}`,
    `media_recording_worker_threads = ${input.media_recording_worker_threads}`,
    `media_recording_worker_queue_capacity = ${input.media_recording_worker_queue_capacity}`,
    `realtime_audio_tap_socket_path = ${tomlString(input.realtime_audio_tap_socket_path)}`,
    `realtime_audio_tap_channel_capacity = ${input.realtime_audio_tap_channel_capacity}`,
    `realtime_audio_tap_send_timeout_ms = ${input.realtime_audio_tap_send_timeout_ms}`,
    '',
    '[proxy.locator]',
    'type = "database"',
    `url = ${tomlString(input.database_url)}`,
    '',
    ...(input.webphone ? [
      '[proxy.jwt_auth]',
      'enabled = true',
      `secret = ${tomlString(input.webphone.jwt_secret)}`,
      'user_id_claim = "sub"',
      `issuer = ${tomlString(input.webphone.jwt_issuer)}`,
      `audience = ${tomlString(input.webphone.jwt_audience)}`,
      'sip_header_name = "X-Auth-Token"',
      'check_local_user = true',
      'ws_token_param = "token"',
      'dev_mint_enabled = false',
      ''
    ] : []),
    '[[proxy.user_backends]]',
    'type = "extension"',
    'ttl = 30',
    '',
    '[proxy.http_router]',
    `url = ${tomlString(input.router_url)}`,
    'timeout_ms = 3000',
    'fallback_to_static = false',
    'fallback_action = "reject"',
    '',
    '[proxy.http_router.headers]',
    `X-PBX-Key = ${tomlString(input.webhook_token)}`,
    '',
    '[rwi]',
    'enabled = true',
    'max_connections = 2000',
    'max_calls_per_connection = 200',
    'orphan_hold_secs = 30',
    'originate_rate_limit = 10',
    '',
    '[[rwi.tokens]]',
    `token = ${tomlString(input.rwi_token)}`,
    'scopes = ["call.control", "queue.control", "record.control", "supervisor.control", "media.stream"]',
    '',
    '[callrecord]',
    'type = "noop"',
    `max_concurrent = ${input.call_record_max_concurrent}`,
    `channel_capacity = ${input.call_record_channel_capacity}`,
    `worker_threads = ${input.call_record_worker_threads}`,
    'persist_to_database = false',
    ''
  ].join('\n');
}

function postgresDatabaseUrl(value: string, password: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('RUSTPBX_DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.username !== 'rustpbx_app'
    || parsed.pathname !== '/rustpbx') {
    throw new Error('RUSTPBX_DATABASE_URL must use PostgreSQL database rustpbx as rustpbx_app');
  }
  if (!parsed.password) parsed.password = runtimeSecret(
    { RUSTPBX_DB_PASSWORD: password },
    'RUSTPBX_DB_PASSWORD'
  );
  return parsed.toString();
}

function immutableImage(value: string): string {
  const image = value.trim();
  if (/(?:^|\/)restsend\/rustpbx(?::|@|$)/i.test(image)) {
    throw new Error('RUSTPBX_IMAGE must reference the iveKit-patched RustPBX image, not upstream');
  }
  const digest = /@sha256:[a-f0-9]{64}$/i.test(image);
  const slash = image.lastIndexOf('/');
  const tag = image.slice(slash + 1).match(/:([^:]+)$/)?.[1] || '';
  const exactVersion = /^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag);
  if (!digest && !exactVersion) {
    throw new Error('RUSTPBX_IMAGE must be an immutable digest or exact semantic version tag');
  }
  return image;
}

function validateRtpRange(start: number, end: number, reserved: number[]): void {
  if (end < start || end - start + 1 < MIN_RTP_PORTS || end - start > 10_000) {
    throw new Error(`RTP range must contain ${MIN_RTP_PORTS} to 10001 ascending ports`);
  }
  if (reserved.some((value) => value >= start && value <= end)) {
    throw new Error('RTP range must not overlap SIP or Management ports');
  }
}

function internalHttpUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an HTTP URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.pathname.startsWith('/')) {
    throw new Error(`${field} must be a credential-free HTTP URL without query or fragment`);
  }
  return value;
}

function unixSocketPath(value: string, field: string): string {
  const path = String(value || '').trim();
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\n') ||
      Buffer.byteLength(path, 'utf8') > 100 || !path.endsWith('.sock')) {
    throw new Error(`${field} must be an absolute Unix socket path ending in .sock`);
  }
  return path;
}

function optionalIp(value: string | undefined): string {
  const ip = String(value || '').trim();
  if (!ip) return '';
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)
    || ip.split('.').some((part) => Number(part) > 255)) {
    throw new Error('RUSTPBX_EXTERNAL_IP must be an IPv4 address without a port');
  }
  return ip;
}

function amiAllows(value: string): string[] {
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!items.length || items.length > 64) {
    throw new Error('RUSTPBX_AMI_ALLOWS must contain 1 to 64 IP addresses or CIDRs');
  }
  for (const item of items) {
    const [address, rawPrefix, extra] = item.split('/');
    const family = isIP(address || '');
    const maxPrefix = family === 4 ? 32 : 128;
    const prefix = rawPrefix === undefined ? maxPrefix : Number(rawPrefix);
    if (extra !== undefined || family === 0 || !Number.isInteger(prefix)
      || prefix < 0 || prefix > maxPrefix) {
      throw new Error('RUSTPBX_AMI_ALLOWS must contain only explicit IP addresses or CIDRs; wildcard access is forbidden');
    }
  }
  return items;
}

function runtimeSecret(env: NodeJS.ProcessEnv, field: string): string {
  const value = required(env, field).trim();
  if (value.length < 12 || /^(?:change|replace|example|dev)[-_]/i.test(value)) {
    throw new Error(`${field} must replace the example placeholder`);
  }
  return value;
}

function webphoneAuth(
  env: NodeJS.ProcessEnv,
  distinctSecrets: string[]
): RustPbxRenderInput['webphone'] {
  const flag = String(env.OPC_IVEKIT_WEBPHONE_ENABLED || '').trim().toLowerCase();
  if (!flag || flag === '0' || flag === 'false') return null;
  if (flag !== '1' && flag !== 'true') {
    throw new Error('OPC_IVEKIT_WEBPHONE_ENABLED must be 0 or 1');
  }
  const secret = required(env, 'OPC_IVEKIT_WEBPHONE_JWT_SECRET');
  if (Buffer.byteLength(secret, 'utf8') < 32 || secret.length > 4_096 || /[\r\n]/.test(secret)) {
    throw new Error('OPC_IVEKIT_WEBPHONE_JWT_SECRET must be 32-4096 bytes');
  }
  if (distinctSecrets.includes(secret)) {
    throw new Error('OPC_IVEKIT_WEBPHONE_JWT_SECRET must be distinct from RustPBX runtime secrets');
  }
  return {
    jwt_secret: secret,
    jwt_issuer: boundedWebphoneClaim(
      required(env, 'OPC_IVEKIT_WEBPHONE_JWT_ISSUER'),
      'OPC_IVEKIT_WEBPHONE_JWT_ISSUER'
    ),
    jwt_audience: boundedWebphoneClaim(
      required(env, 'OPC_IVEKIT_WEBPHONE_JWT_AUDIENCE'),
      'OPC_IVEKIT_WEBPHONE_JWT_AUDIENCE'
    )
  };
}

function boundedWebphoneClaim(value: string, field: string): string {
  if (value.length > 200 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${field} must contain 1-200 safe characters`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, field: string): string {
  const value = String(env[field] || '').trim();
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function port(value: string | undefined, field: string, fallback: number): number {
  const parsed = String(value || '').trim() ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function positiveCapacity(
  value: string | undefined,
  field: string,
  fallback: number,
  maximum = MAX_SIP_CAPACITY_VALUE
): number {
  const parsed = String(value || '').trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
