import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { renderRustPbxConfig } from '../scripts/render-rustpbx-config.js';
import { createVoiceQueueTenantLister } from '../src/agent-runtime/converact/voice/runtime.js';
import type { PgQueryable } from '../src/db-pg.js';

const STANDALONE_COMPOSE = new URL('../infra/converact/docker-compose.yml', import.meta.url);
const VOICE_COMPOSE = new URL('../infra/converact/docker-compose.voice.yml', import.meta.url);
const SERVICE_COMPOSE = new URL('../services/converact-service/docker-compose.yml', import.meta.url);
const SERVICE_VOICE_COMPOSE = new URL('../services/converact-service/docker-compose.voice.yml', import.meta.url);
const SERVICE_RUSTPBX_INIT = new URL('../services/converact-service/init-rustpbx-database.sh', import.meta.url);
const SERVICE_HELM_VALUES = new URL('../services/converact-service/helm/converact/values.yaml', import.meta.url);
const SERVICE_HELM_DEPLOYMENT = new URL(
  '../services/converact-service/helm/converact/templates/deployment.yaml',
  import.meta.url
);
const SERVICE_HELM_RUSTPBX = new URL(
  '../services/converact-service/helm/converact/templates/rustpbx-deployment.yaml',
  import.meta.url
);
const SERVICE_HELM_KAMAILIO = new URL(
  '../services/converact-service/helm/converact/templates/kamailio-deployment.yaml',
  import.meta.url
);
const SERVICE_HELM_HELPERS = new URL(
  '../services/converact-service/helm/converact/templates/_helpers.tpl',
  import.meta.url
);
const PRODUCTION_COMPOSE = new URL('../infra/docker-compose.production.yml', import.meta.url);
const PRODUCTION_ENV_EXAMPLE = new URL('../infra/env.example', import.meta.url);
const STANDALONE_BOOTSTRAP = new URL('../infra/converact/init-postgres-runtime-role.sh', import.meta.url);
const CHECKED_IN_CONFIG = new URL('../config/rustpbx.docker.toml', import.meta.url);
const HELM_VALUES = new URL('../infra/k8s/values.yaml', import.meta.url);
const HELM_SECRETS = new URL('../infra/k8s/templates/secrets.yaml', import.meta.url);
const HELM_OPC = new URL('../infra/k8s/templates/opc-deployment.yaml', import.meta.url);
const HELM_RUSTPBX = new URL('../infra/k8s/templates/rustpbx-deployment.yaml', import.meta.url);
const VOICE_RUNTIME = new URL('../src/agent-runtime/converact/voice/runtime.ts', import.meta.url);
const SERVICE_PACKAGE = new URL('../services/converact-service/package.json', import.meta.url);
const SOURCE_POLICY = new URL('../services/converact-service/source-policy.json', import.meta.url);
const STANDALONE_CONTEXT_VERIFIER = new URL('../scripts/verify-ivekit-standalone-context.ts', import.meta.url);

const SECRET_VALUES = {
  RUSTPBX_DATABASE_URL: 'postgresql://rustpbx_app:database-secret@postgres:5432/rustpbx',
  RUSTPBX_IMAGE: 'ghcr.io/songgoldenwind-crypto/opc-rustpbx@sha256:2dc00f409f49bf48a23de6101d9d7371692eb7f067e70f4d449f16e158302526',
  RUSTPBX_AMI_ALLOWS: '127.0.0.1,172.31.240.0/24',
  RUSTPBX_MANAGEMENT_TOKEN: 'management-secret-value',
  RUSTPBX_RWI_TOKEN: 'rwi-secret-value',
  RUSTPBX_WEBHOOK_TOKEN: 'webhook-secret-value',
  CONVERACT_FABRIC_WEBPHONE_ENABLED: '1',
  CONVERACT_FABRIC_WEBPHONE_JWT_SECRET: 'webphone-jwt-secret-value-that-is-at-least-32-bytes',
  CONVERACT_FABRIC_WEBPHONE_JWT_ISSUER: 'ivekit',
  CONVERACT_FABRIC_WEBPHONE_JWT_AUDIENCE: 'rustpbx-webphone',
  RUSTPBX_ROUTER_URL: 'http://ivekit-api:3000/api/ivekit/voice/providers/profile/router',
  RUSTPBX_CDR_WEBHOOK_URL: 'http://ivekit-api:3000/api/ivekit/voice/providers/profile/cdrs',
  RUSTPBX_SIP_PORT: '5060',
  RUSTPBX_RTP_START_PORT: '20000',
  RUSTPBX_RTP_END_PORT: '20100'
} satisfies NodeJS.ProcessEnv;

test('standalone Helm exposes SIP/VoLTE activation without enabling it by default', () => {
  const values = readFileSync(SERVICE_HELM_VALUES, 'utf8');
  const deployment = readFileSync(SERVICE_HELM_DEPLOYMENT, 'utf8');
  const helpers = readFileSync(SERVICE_HELM_HELPERS, 'utf8');

  assert.match(values, /^    CONVERACT_SIP_VOLTE_ENABLED: "0"$/m);
  assert.match(values, /^    LIVEKIT_SIP_BRIDGE_TARGET: ""$/m);
  assert.match(values, /^    RUSTPBX_LIVEKIT_TRUNK: ""$/m);
  assert.match(values, /^    RUSTPBX_RWI_URL: ""$/m);
  assert.match(values, /repository: ghcr\.io\/songgoldenwind-crypto\/opc-rustpbx/);
  assert.match(helpers, /iveKit-patched RustPBX image/);
  assert.match(helpers, /restsend\/rustpbx/);
  assert.match(deployment, /range \$name, \$value := \.Values\.config\.env/);
});

test('standalone service forwards SIP control secrets through the optional runtime env file', () => {
  const compose = readFileSync(SERVICE_COMPOSE, 'utf8');
  const ivekit = serviceBlock(compose, 'ivekit');

  assert.match(ivekit, /env_file:/);
  assert.match(ivekit, /CONVERACT_FABRIC_VOICE_RUNTIME_ENV_FILE:-\.\/voice-runtime\.env/);
  assert.match(ivekit, /required: false/);
  assert.match(ivekit, /RUSTPBX_RWI_URL: \$\{RUSTPBX_RWI_URL:-\}/);
});

test('RustPBX renderer accepts only immutable PostgreSQL production inputs', () => {
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_DATABASE_URL: 'sqlite:///tmp/rustpbx.db' }),
    /PostgreSQL/i
  );
  assert.throws(
    () => renderRustPbxConfig({
      ...SECRET_VALUES,
      RUSTPBX_IMAGE: 'ghcr.io/songgoldenwind-crypto/opc-rustpbx:latest'
    }),
    /immutable/i
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_IMAGE: 'ghcr.io/restsend/rustpbx' }),
    /iveKit-patched/i
  );
  assert.throws(
    () => renderRustPbxConfig({
      ...SECRET_VALUES,
      RUSTPBX_IMAGE: `ghcr.io/restsend/rustpbx@sha256:${'a'.repeat(64)}`
    }),
    /iveKit-patched/i
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_RTP_START_PORT: '5050' }),
    /RTP/i
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_RTP_END_PORT: '20020' }),
    /RTP/i
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_MANAGEMENT_TOKEN: '' }),
    /RUSTPBX_MANAGEMENT_TOKEN/
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_MANAGEMENT_TOKEN: 'rwi-secret-value' }),
    /distinct/i
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_AMI_ALLOWS: '*' }),
    /RUSTPBX_AMI_ALLOWS/
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, CONVERACT_FABRIC_WEBPHONE_JWT_SECRET: 'short' }),
    /WEBPHONE_JWT_SECRET/
  );
  assert.throws(
    () => renderRustPbxConfig({
      ...SECRET_VALUES,
      RUSTPBX_MANAGEMENT_TOKEN: SECRET_VALUES.CONVERACT_FABRIC_WEBPHONE_JWT_SECRET
    }),
    /distinct/i
  );
  for (const [field, value] of [
    ['RUSTPBX_SIP_MAX_ACTIVE_TRANSACTIONS', '0'],
    ['RUSTPBX_SIP_MAX_FINISHED_TRANSACTIONS', '-1'],
    ['RUSTPBX_SIP_INCOMING_TRANSACTION_QUEUE_CAPACITY', '1.5'],
    ['RUSTPBX_SIP_MAX_TRANSPORT_CONNECTIONS', '10000001'],
    ['RUSTPBX_MEDIA_SESSION_CLEANUP_CONCURRENCY', '4097'],
    ['RUSTPBX_MEDIA_SESSION_CLEANUP_TIMEOUT_MS', '0'],
    ['RUSTPBX_MEDIA_RECORDING_CHANNEL_CAPACITY', '0'],
    ['RUSTPBX_MEDIA_RECORDING_WORKER_THREADS', '65'],
    ['RUSTPBX_MEDIA_RECORDING_WORKER_QUEUE_CAPACITY', '0'],
    ['RUSTPBX_REALTIME_AUDIO_TAP_CHANNEL_CAPACITY', '0'],
    ['RUSTPBX_REALTIME_AUDIO_TAP_SEND_TIMEOUT_MS', '1001'],
    ['RUSTPBX_CALL_RECORD_MAX_CONCURRENT', '4097'],
    ['RUSTPBX_CALL_RECORD_CHANNEL_CAPACITY', '262145'],
    ['RUSTPBX_CALL_RECORD_WORKER_THREADS', '17']
  ]) {
    assert.throws(
      () => renderRustPbxConfig({ ...SECRET_VALUES, [field]: value }),
      new RegExp(field)
    );
  }
});

test('RustPBX renderer emits a usable config and a secret-free summary', () => {
  const rendered = renderRustPbxConfig(SECRET_VALUES);

  assert.match(rendered.config, /database_url = "postgresql:\/\/rustpbx_app:database-secret@postgres:5432\/rustpbx"/);
  assert.match(rendered.config, /rtp_start_port = 20000/);
  assert.match(rendered.config, /udp_port = 5060/);
  assert.match(rendered.config, /tcp_port = 5060/);
  assert.match(rendered.config, /generated_dir = "\/app\/generated"/);
  assert.match(rendered.config, /sip_max_active_transactions = 65536/);
  assert.match(rendered.config, /sip_max_finished_transactions = 65536/);
  assert.match(rendered.config, /sip_incoming_transaction_queue_capacity = 8192/);
  assert.match(rendered.config, /sip_max_transport_connections = 32768/);
  assert.match(rendered.config, /media_session_cleanup_concurrency = 64/);
  assert.match(rendered.config, /media_session_cleanup_timeout_ms = 2000/);
  assert.match(rendered.config, /media_recording_channel_capacity = 256/);
  assert.match(rendered.config, /media_recording_worker_threads = 4/);
  assert.match(rendered.config, /media_recording_worker_queue_capacity = 4096/);
  assert.match(rendered.config, /realtime_audio_tap_socket_path = "\/run\/ivekit\/realtime-audio-tap\.sock"/);
  assert.match(rendered.config, /realtime_audio_tap_channel_capacity = 256/);
  assert.match(rendered.config, /realtime_audio_tap_send_timeout_ms = 10/);
  assert.match(rendered.config, /max_concurrent = 64/);
  assert.match(rendered.config, /channel_capacity = 65536/);
  assert.match(rendered.config, /worker_threads = 1/);
  assert.match(rendered.config, /persist_to_database = false/);
  assert.match(
    rendered.config,
    /\[callrecord\]\s*\ntype = "noop"/
  );
  assert.doesNotMatch(
    rendered.config,
    /\[callrecord\][\s\S]*X-PBX-Key/
  );
  assert.match(rendered.config, /\[\[proxy\.user_backends\]\]\s*\ntype = "extension"\s*\nttl = 30/);
  assert.match(rendered.config, /ws_handler = "\/ws"/);
  assert.match(rendered.config, /\[proxy\.jwt_auth\]/);
  assert.match(rendered.config, /enabled = true/);
  assert.match(rendered.config, /secret = "webphone-jwt-secret-value-that-is-at-least-32-bytes"/);
  assert.match(rendered.config, /user_id_claim = "sub"/);
  assert.match(rendered.config, /issuer = "ivekit"/);
  assert.match(rendered.config, /audience = "rustpbx-webphone"/);
  assert.match(rendered.config, /check_local_user = true/);
  assert.match(rendered.config, /ws_token_param = "token"/);
  assert.match(rendered.config, /dev_mint_enabled = false/);
  assert.match(rendered.config, /\[\[console\.api_tokens\]\]/);
  assert.match(rendered.config, /token = "management-secret-value"/);
  assert.match(rendered.config, /\[ami\]\s*\nallows = \["127\.0\.0\.1", "172\.31\.240\.0\/24"\]/);
  assert.match(rendered.config, /\[\[rwi\.tokens\]\]/);
  assert.match(rendered.config, /X-PBX-Key = "webhook-secret-value"/);
  assert.doesNotMatch(rendered.config, /sqlite/i);

  const summary = JSON.stringify(rendered.summary);
  for (const secret of [
    'database-secret', 'management-secret-value', 'rwi-secret-value', 'webhook-secret-value'
  ]) {
    assert.equal(summary.includes(secret), false);
  }
  assert.deepEqual(rendered.summary, {
    database: 'postgresql',
    image_immutable: true,
    sip_port: 5060,
    rtp_start_port: 20000,
    rtp_end_port: 20100,
    sip_max_active_transactions: 65536,
    sip_max_finished_transactions: 65536,
    sip_incoming_transaction_queue_capacity: 8192,
    sip_max_transport_connections: 32768,
    media_session_cleanup_concurrency: 64,
    media_session_cleanup_timeout_ms: 2000,
    media_recording_channel_capacity: 256,
    media_recording_worker_threads: 4,
    media_recording_worker_queue_capacity: 4096,
    realtime_audio_tap_enabled: true,
    realtime_audio_tap_channel_capacity: 256,
    realtime_audio_tap_send_timeout_ms: 10,
    call_record_max_concurrent: 64,
    call_record_channel_capacity: 65536,
    call_record_worker_threads: 1,
    management_exposure: 'internal',
    rwi_exposure: 'internal'
  });
});

test('RustPBX renderer accepts profile-tuned bounded SIP capacity', () => {
  const rendered = renderRustPbxConfig({
    ...SECRET_VALUES,
    RUSTPBX_SIP_MAX_ACTIVE_TRANSACTIONS: '131072',
    RUSTPBX_SIP_MAX_FINISHED_TRANSACTIONS: '98304',
    RUSTPBX_SIP_INCOMING_TRANSACTION_QUEUE_CAPACITY: '16384',
    RUSTPBX_SIP_MAX_TRANSPORT_CONNECTIONS: '65536',
    RUSTPBX_MEDIA_SESSION_CLEANUP_CONCURRENCY: '128',
    RUSTPBX_MEDIA_SESSION_CLEANUP_TIMEOUT_MS: '3500',
    RUSTPBX_MEDIA_RECORDING_CHANNEL_CAPACITY: '1024',
    RUSTPBX_MEDIA_RECORDING_WORKER_THREADS: '8',
    RUSTPBX_MEDIA_RECORDING_WORKER_QUEUE_CAPACITY: '8192',
    RUSTPBX_REALTIME_AUDIO_TAP_SOCKET_PATH: '/run/ivekit/custom-audio-tap.sock',
    RUSTPBX_REALTIME_AUDIO_TAP_CHANNEL_CAPACITY: '2048',
    RUSTPBX_REALTIME_AUDIO_TAP_SEND_TIMEOUT_MS: '25',
    RUSTPBX_CALL_RECORD_MAX_CONCURRENT: '512',
    RUSTPBX_CALL_RECORD_CHANNEL_CAPACITY: '131072',
    RUSTPBX_CALL_RECORD_WORKER_THREADS: '3'
  });

  assert.match(rendered.config, /sip_max_active_transactions = 131072/);
  assert.match(rendered.config, /sip_max_finished_transactions = 98304/);
  assert.match(rendered.config, /sip_incoming_transaction_queue_capacity = 16384/);
  assert.match(rendered.config, /sip_max_transport_connections = 65536/);
  assert.match(rendered.config, /media_session_cleanup_concurrency = 128/);
  assert.match(rendered.config, /media_session_cleanup_timeout_ms = 3500/);
  assert.match(rendered.config, /media_recording_channel_capacity = 1024/);
  assert.match(rendered.config, /media_recording_worker_threads = 8/);
  assert.match(rendered.config, /media_recording_worker_queue_capacity = 8192/);
  assert.match(rendered.config, /realtime_audio_tap_socket_path = "\/run\/ivekit\/custom-audio-tap\.sock"/);
  assert.match(rendered.config, /realtime_audio_tap_channel_capacity = 2048/);
  assert.match(rendered.config, /realtime_audio_tap_send_timeout_ms = 25/);
  assert.match(rendered.config, /max_concurrent = 512/);
  assert.match(rendered.config, /channel_capacity = 131072/);
  assert.match(rendered.config, /worker_threads = 3/);
  assert.equal(rendered.summary.call_record_max_concurrent, 512);
  assert.equal(rendered.summary.call_record_channel_capacity, 131072);
  assert.equal(rendered.summary.call_record_worker_threads, 3);
});

test('standalone Voice overlay isolates RustPBX data and exposes only SIP and RTP', () => {
  const core = readFileSync(STANDALONE_COMPOSE, 'utf8');
  const voice = readFileSync(VOICE_COMPOSE, 'utf8');
  const bootstrap = readFileSync(STANDALONE_BOOTSTRAP, 'utf8');

  assert.match(bootstrap, /rustpbx_app/);
  assert.match(bootstrap, /CREATE DATABASE rustpbx OWNER rustpbx_app/);
  assert.match(bootstrap, /NOBYPASSRLS/);
  assert.match(bootstrap, /REVOKE CONNECT ON DATABASE rustpbx FROM PUBLIC/);
  assert.match(voice, /image: \$\{RUSTPBX_IMAGE:\?RUSTPBX_IMAGE is required\}/);
  assert.match(
    voice,
    /profiles: \["voice", "voice-capacity", "voice-media-control", "voice-t1"\]/
  );
  assert.match(voice, /scripts\/render-rustpbx-config\.ts/);
  assert.match(voice, /src\/converact-rustpbx-route-snapshot\.ts/);
  assert.match(voice, /rustpbx-route-snapshot:\/app\/route-snapshot/);
  assert.match(voice, /IVEKIT_RUSTPBX_ROUTE_LOOKUP_HMAC_ROOT_KEY/);
  assert.match(voice, /IVEKIT_RUSTPBX_INBOUND_ADMISSION_URL/);
  assert.match(voice, /IVEKIT_RUSTPBX_INBOUND_ADMISSION_SERVICE_KEY/);
  assert.match(voice, /IVEKIT_RUSTPBX_CELL_ID/);
  assert.match(voice, /IVEKIT_RUSTPBX_OWNER_NODE_ID/);
  assert.match(voice, /rustpbx-component-node:/);
  assert.match(
    voice,
    /profiles: \["voice-capacity", "voice-media-control", "voice-t1"\]/
  );
  assert.match(voice, /scripts\/ivekit-component-node-admission\.ts/);
  assert.match(voice, /network_mode: service:rustpbx/);
  assert.match(voice, /CONVERACT_FABRIC_COMPONENT_NODE_COMPONENT: rustpbx/);
  assert.match(voice, /CONVERACT_FABRIC_COMPONENT_NODE_INTERACTION_KINDS: sip_voice/);
  assert.match(voice, /IVEKIT_RUSTPBX_COMPONENT_NODE_ENABLED/);
  assert.match(voice, /http:\/\/127\.0\.0\.1:3210/);
  assert.match(voice, /rustpbx-runtime-config:\/app\/config/);
  assert.match(voice, /rustpbx-generated-config:\/app\/generated/);
  assert.match(voice, /rustpbx-runtime-recovery:/);
  assert.match(voice, /network_mode: service:rustpbx/);
  assert.match(voice, /scripts\/ivekit-rustpbx-recovery\.ts/);
  assert.match(voice, /RUSTPBX_DATABASE_URL: postgresql:\/\/rustpbx_app@postgres:5432\/rustpbx/);
  assert.match(voice, /RUSTPBX_DB_PASSWORD/);
  assert.match(voice, /RUSTPBX_AMI_ALLOWS: \$\{RUSTPBX_AMI_ALLOWS:\?RUSTPBX_AMI_ALLOWS is required\}/);
  assert.match(voice, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_MANAGEMENT_TOKEN:\?RUSTPBX_MANAGEMENT_TOKEN is required\}/);
  assert.doesNotMatch(voice, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_RWI_TOKEN/);
  assert.match(voice, /CONVERACT_FABRIC_VOICE_SECRET_ENV_NAMES: \$\{CONVERACT_FABRIC_VOICE_SECRET_ENV_NAMES:-RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN\}/);
  assert.match(voice, /path: \$\{CONVERACT_FABRIC_VOICE_RUNTIME_ENV_FILE:-\.\/voice-runtime\.env\}/);
  assert.match(voice, /required: false/);
  assert.match(voice, /expose:\s*\n\s*- "8080"/);
  assert.match(voice, /\$\{RUSTPBX_SIP_PORT:-5060\}:5060\/udp/);
  assert.match(voice, /\$\{RUSTPBX_RTP_START_PORT:-20000\}-\$\{RUSTPBX_RTP_END_PORT:-20100\}:20000-20100\/udp/);
  assert.doesNotMatch(serviceBlock(voice, 'opc'), /RUSTPBX_DB_PASSWORD/);
  assert.doesNotMatch(serviceBlock(core, 'opc'), /RUSTPBX_DB_PASSWORD/);
  assert.doesNotMatch(voice, /sqlite/i);
  assert.match(voice, /CONVERACT_FABRIC_WEBPHONE_WSS_URL/);
  assert.match(voice, /CONVERACT_FABRIC_WEBPHONE_SIP_REALM/);
  assert.match(voice, /CONVERACT_FABRIC_WEBPHONE_JWT_SECRET/);
  assert.match(voice, /CONVERACT_FABRIC_WEBPHONE_ICE_SERVERS_JSON/);
});

test('WebPhone production deployment shares one JWT authority and exposes only the WSS path', () => {
  const serviceVoice = readFileSync(SERVICE_VOICE_COMPOSE, 'utf8');
  const serviceValues = readFileSync(SERVICE_HELM_VALUES, 'utf8');
  const serviceDeployment = readFileSync(SERVICE_HELM_DEPLOYMENT, 'utf8');
  const serviceRustPbx = readFileSync(SERVICE_HELM_RUSTPBX, 'utf8');
  const serviceKamailio = readFileSync(SERVICE_HELM_KAMAILIO, 'utf8');
  const kamailioConfig = readFileSync(
    'src/agent-runtime/converact/voice/kamailio-config.ts',
    'utf8'
  );
  const platformValues = readFileSync(HELM_VALUES, 'utf8');
  const platformSecrets = readFileSync(HELM_SECRETS, 'utf8');
  const platformApi = readFileSync(HELM_OPC, 'utf8');
  const platformRustPbx = readFileSync(HELM_RUSTPBX, 'utf8');

  for (const compose of [readFileSync(VOICE_COMPOSE, 'utf8'), serviceVoice]) {
    assert.match(serviceBlock(compose, 'rustpbx-config-render'), /CONVERACT_FABRIC_WEBPHONE_JWT_SECRET/);
    const api = compose.includes('\n  ivekit:')
      ? serviceBlock(compose, 'ivekit')
      : serviceBlock(compose, 'opc');
    assert.match(api, /CONVERACT_FABRIC_WEBPHONE_WSS_URL/);
    assert.match(api, /CONVERACT_FABRIC_WEBPHONE_SIP_REALM/);
    assert.match(api, /CONVERACT_FABRIC_WEBPHONE_JWT_SECRET/);
    assert.match(api, /CONVERACT_FABRIC_WEBPHONE_TTL_SECONDS/);
  }
  for (const values of [serviceValues, platformValues]) {
    assert.match(values, /webphone:\s*\n\s+enabled: true/);
    assert.match(values, /publicWssUrl:/);
    assert.match(values, /jwtAudience: rustpbx-webphone/);
  }
  assert.match(platformValues, /path: \/ws/);
  assert.match(serviceDeployment, /name: CONVERACT_FABRIC_WEBPHONE_WSS_URL/);
  assert.match(serviceRustPbx, /name: CONVERACT_FABRIC_WEBPHONE_JWT_SECRET/);
  assert.doesNotMatch(serviceRustPbx, /kind: Ingress|voice\.webphone\.ingress/);
  assert.match(serviceKamailio, /name: sip-wss[\s\S]*port: \{\{ \$kamailio\.advertise\.wssPort \}\}/);
  assert.match(kamailioConfig, /\$hu =~ "\^\/ws\(\$\|\[\?\]\)"/);
  assert.match(platformSecrets, /rustpbx-webphone-jwt-secret:/);
  assert.match(platformApi, /name: CONVERACT_FABRIC_WEBPHONE_WSS_URL/);
  assert.match(platformRustPbx, /ws_handler = "\/ws"/);
  assert.match(platformRustPbx, /\[proxy\.jwt_auth\]/);
  assert.match(platformRustPbx, /kind: Ingress[\s\S]*pathType: Exact/);
});

test('RustPBX media plane never depends on recording upload or object storage availability', () => {
  const voice = readFileSync(VOICE_COMPOSE, 'utf8');
  const rustpbx = serviceBlock(voice, 'rustpbx');
  const uploader = serviceBlock(voice, 'rustpbx-recording-spool');

  assert.doesNotMatch(rustpbx, /minio|object.?stor|\bs3\b/i);
  assert.doesNotMatch(rustpbx, /depends_on:[\s\S]*rustpbx-recording-spool:/);
  assert.match(rustpbx, /rustpbx-recording-spool:\/app\/recording-spool/);
  assert.match(uploader, /depends_on:[\s\S]*rustpbx:/);
  assert.match(uploader, /rustpbx-recording-spool:\/app\/recording-spool/);
  assert.doesNotMatch(uploader, /network_mode:\s*service:rustpbx/);
});

test('standalone service Voice overlay uses only compiled image entrypoints', () => {
  const voice = readFileSync(SERVICE_VOICE_COMPOSE, 'utf8');
  const bootstrap = readFileSync(SERVICE_RUSTPBX_INIT, 'utf8');

  assert.match(voice, /command: \["node", "dist\/converact-render-rustpbx-config\.js"\]/);
  assert.doesNotMatch(voice, /--import|\btsx\b|scripts\//);
  assert.match(voice, /command: \["node", "dist\/converact-rustpbx-route-snapshot\.js"\]/);
  assert.match(voice, /rustpbx-route-snapshot:\/app\/route-snapshot/);
  assert.match(voice, /command: \["node", "dist\/converact-rustpbx-recovery\.js"\]/);
  assert.match(voice, /exec node dist\/converact-component-node-admission\.js/);
  assert.match(voice, /rustpbx-generated-config:\/app\/generated/);
  assert.match(voice, /network_mode: service:rustpbx/);
  assert.match(voice, /rustpbx-db-init:/);
  assert.match(voice, /ivekit:/);
  assert.doesNotMatch(voice, /^\s+opc:/m);
  assert.match(voice, /http:\/\/ivekit:3000\/api\/ivekit\/voice\/providers/);
  assert.match(voice, /\/inbound-admission/);
  assert.match(voice, /RUSTPBX_AMI_ALLOWS: \$\{RUSTPBX_AMI_ALLOWS:\?RUSTPBX_AMI_ALLOWS is required\}/);
  assert.match(voice, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_MANAGEMENT_TOKEN:\?RUSTPBX_MANAGEMENT_TOKEN is required\}/);
  assert.doesNotMatch(voice, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_RWI_TOKEN/);
  assert.match(voice, /CONVERACT_FABRIC_VOICE_SECRET_ENV_NAMES: \$\{CONVERACT_FABRIC_VOICE_SECRET_ENV_NAMES:-RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN\}/);
  assert.match(voice, /CONVERACT_FABRIC_VOICE_RUNTIME_ENV_FILE/);
  assert.match(bootstrap, /CREATE ROLE rustpbx_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
  assert.match(bootstrap, /CREATE DATABASE rustpbx OWNER rustpbx_app/);
  assert.match(bootstrap, /REVOKE CONNECT ON DATABASE rustpbx FROM opc_runtime/);
  assert.doesNotMatch(voice, /sqlite/i);
});

test('standalone image exposes compiled Voice config and preflight entrypoints', () => {
  const servicePackage = JSON.parse(readFileSync(SERVICE_PACKAGE, 'utf8')) as {
    scripts: Record<string, string>;
  };
  const sourcePolicy = JSON.parse(readFileSync(SOURCE_POLICY, 'utf8')) as {
    entrypoints: string[];
  };
  const verifier = readFileSync(STANDALONE_CONTEXT_VERIFIER, 'utf8');

  assert.equal(
    servicePackage.scripts['render:rustpbx'],
    'node dist/converact-render-rustpbx-config.js'
  );
  assert.equal(
    servicePackage.scripts['preflight:voice'],
    'node dist/converact-voice-preflight.js'
  );
  assert.equal(
    servicePackage.scripts['recover:rustpbx'],
    'node dist/converact-rustpbx-recovery.js'
  );
  assert.equal(
    servicePackage.scripts['project:rustpbx-routes'],
    'node dist/converact-rustpbx-route-snapshot.js'
  );
  assert.equal(
    servicePackage.scripts['upload:rustpbx-recordings'],
    'node dist/converact-rustpbx-recording-spool.js'
  );
  assert.equal(
    servicePackage.scripts['admit:component-node'],
    'node dist/converact-component-node-admission.js'
  );
  assert.equal(sourcePolicy.entrypoints.includes('src/converact-render-rustpbx-config.ts'), true);
  assert.equal(sourcePolicy.entrypoints.includes('src/converact-voice-preflight.ts'), true);
  assert.equal(sourcePolicy.entrypoints.includes('src/converact-rustpbx-recovery.ts'), true);
  assert.equal(sourcePolicy.entrypoints.includes('src/converact-rustpbx-route-snapshot.ts'), true);
  assert.equal(sourcePolicy.entrypoints.includes('src/converact-rustpbx-recording-spool.ts'), true);
  assert.equal(sourcePolicy.entrypoints.includes('src/converact-component-node-admission.ts'), true);
  for (const entrypoint of [
    'converact-server.js',
    'converact-worker.js',
    'converact-migrate.js',
    'converact-init-runtime-role.js',
    'converact-intelligence-preflight.js',
    'converact-render-rustpbx-config.js',
    'converact-rustpbx-route-snapshot.js',
    'converact-rustpbx-recording-spool.js',
    'converact-component-node-admission.js',
    'converact-rustpbx-recovery.js',
    'converact-voice-preflight.js'
  ]) assert.equal(verifier.includes(`'${entrypoint}'`), true, entrypoint);
});

test('production compose has no floating or SQLite RustPBX deployment', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE, 'utf8');
  const rustpbx = serviceBlock(compose, 'rustpbx');
  const opc = serviceBlock(compose, 'opc');

  assert.match(rustpbx, /image: \$\{RUSTPBX_IMAGE:\?RUSTPBX_IMAGE is required\}/);
  assert.match(rustpbx, /profiles: \["voice", "voice-capacity"\]/);
  assert.match(rustpbx, /rustpbx-runtime-config:\/app\/config/);
  assert.match(rustpbx, /rustpbx-generated-config:\/app\/generated/);
  assert.match(rustpbx, /rustpbx-route-snapshot:\/app\/route-snapshot/);
  assert.match(compose, /src\/converact-rustpbx-route-snapshot\.ts/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_ROUTE_LOOKUP_HMAC_ROOT_KEY/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_INBOUND_ADMISSION_URL/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_OWNER_NODE_ID/);
  assert.match(compose, /rustpbx-component-node:/);
  assert.match(compose, /profiles: \["voice-capacity"\]/);
  assert.match(compose, /scripts\/ivekit-component-node-admission\.ts/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_COMPONENT_NODE_ENABLED/);
  assert.match(rustpbx, /http:\/\/127\.0\.0\.1:3210/);
  assert.match(compose, /rustpbx-runtime-recovery:/);
  assert.match(compose, /network_mode: service:rustpbx/);
  assert.match(rustpbx, /postgres-bootstrap:\s*\n\s+condition: service_completed_successfully/);
  assert.doesNotMatch(rustpbx, /:latest/);
  assert.doesNotMatch(rustpbx, /sqlite/i);
  assert.doesNotMatch(opc, /RUSTPBX_DB_PASSWORD/);
  assert.match(compose, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_MANAGEMENT_TOKEN/);
  assert.doesNotMatch(compose, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_RWI_TOKEN/);
  assert.match(opc, /CONVERACT_FABRIC_VOICE_SECRET_ENV_NAMES: \$\{CONVERACT_FABRIC_VOICE_SECRET_ENV_NAMES:-RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN\}/);
  assert.match(opc, /CONVERACT_FABRIC_VOICE_RUNTIME_ENV_FILE/);
});

test('production env example satisfies mandatory RustPBX route-key interpolation', () => {
  const envExample = readFileSync(PRODUCTION_ENV_EXAMPLE, 'utf8');
  assert.match(
    envExample,
    /^CONVERACT_FABRIC_VOICE_ADDRESS_KEY=replace_with_32_byte_base64_address_key$/m
  );
  assert.match(
    envExample,
    /^CONVERACT_FABRIC_VOICE_ADDRESS_HMAC_KEY=replace_with_distinct_32_byte_base64_hmac_key$/m
  );
});

test('RustPBX Helm templates optionally co-locate the fenced component-node agent', () => {
  const serviceTemplate = readFileSync(SERVICE_HELM_RUSTPBX, 'utf8');
  const serviceValues = readFileSync(SERVICE_HELM_VALUES, 'utf8');
  const platformTemplate = readFileSync(HELM_RUSTPBX, 'utf8');
  const platformValues = readFileSync(HELM_VALUES, 'utf8');

  for (const template of [serviceTemplate, platformTemplate]) {
    assert.match(template, /componentNode\.enabled/);
    assert.match(template, /name: component-node-admission/);
    assert.match(template, /(?:ivekit|converact)-component-node-admission/);
    assert.match(template, /CONVERACT_FABRIC_COMPONENT_NODE_COMPONENT/);
    assert.match(template, /CONVERACT_FABRIC_COMPONENT_NODE_INTERACTION_KINDS/);
    assert.match(template, /CONVERACT_FABRIC_COMPONENT_NODE_DIMENSIONS_JSON/);
    assert.match(template, /IVEKIT_RUSTPBX_COMPONENT_NODE_ENABLED/);
    assert.match(template, /IVEKIT_RUSTPBX_COMPONENT_NODE_URL/);
    assert.match(template, /http:\/\/127\.0\.0\.1:3210/);
    assert.match(template, /path: \/readyz[\s\S]*port: component-node/);
    assert.match(template, /path: \/livez[\s\S]*port: component-node/);
    assert.match(template, /name: component-node[\s\S]*port: 3210/);
  }
  assert.match(serviceValues, /componentNode:\s*\n\s+enabled: true/);
  assert.match(platformValues, /componentNode:\s*\n\s+enabled: false/);
  for (const values of [serviceValues, platformValues]) {
    assert.match(values, /tokenKey:/);
    assert.match(values, /regionId:/);
    assert.match(values, /zoneId:/);
    assert.match(values, /profileIds:/);
    assert.match(values, /dimensionsJson:/);
  }
});

test('RustPBX deployments co-locate the bounded recording spool sidecar and shared durable volume', () => {
  const standaloneVoice = readFileSync(VOICE_COMPOSE, 'utf8');
  const serviceVoice = readFileSync(SERVICE_VOICE_COMPOSE, 'utf8');
  const serviceTemplate = readFileSync(SERVICE_HELM_RUSTPBX, 'utf8');
  const serviceValues = readFileSync(SERVICE_HELM_VALUES, 'utf8');
  const platformTemplate = readFileSync(HELM_RUSTPBX, 'utf8');
  const platformValues = readFileSync(HELM_VALUES, 'utf8');

  for (const compose of [standaloneVoice, serviceVoice]) {
    assert.match(compose, /rustpbx-recording-spool:/);
    assert.match(compose, /converact-rustpbx-recording-spool/);
    assert.match(compose, /IVEKIT_RUSTPBX_RECORDING_SPOOL_ENABLED/);
    assert.match(compose, /IVEKIT_RUSTPBX_RECORDING_SPOOL_DIR: \/app\/recording-spool/);
    assert.match(compose, /CONVERACT_FABRIC_RECORDING_SERVICE_KEY_FILE: \/run\/secrets\/rustpbx-recording-service-key/);
    assert.match(compose, /CONVERACT_FABRIC_RECORDING_LEASE_SECRET_FILE: \/run\/secrets\/rustpbx-recording-lease-secret/);
    assert.match(compose, /rustpbx-recording-spool:\/app\/recording-spool/);
    assert.match(compose, /rustpbx-recording-state:\/app\/recording-state/);
    assert.match(compose, /CONVERACT_FABRIC_COMPONENT_NODE_RECORDING_SPOOL_METRICS_FILE: \/app\/recording-state\/metrics\.json/);
    assert.match(compose, /rustpbx-recording-state:\/app\/recording-state:ro/);
  }
  for (const template of [serviceTemplate, platformTemplate]) {
    assert.match(template, /name: recording-spool-uploader/);
    assert.match(template, /converact-rustpbx-recording-spool/);
    assert.match(template, /IVEKIT_RUSTPBX_RECORDING_SPOOL_ENABLED/);
    assert.match(template, /mountPath: \/app\/recording-spool/);
    assert.match(template, /mountPath: \/app\/recording-state/);
    assert.match(template, /mountPath: \/run\/ivekit-recording-secrets/);
    assert.match(template, /recordingSpool\.leaseSecretKey/);
    assert.match(template, /CONVERACT_FABRIC_COMPONENT_NODE_RECORDING_SPOOL_METRICS_FILE/);
    assert.match(template, /value: \/app\/recording-state\/metrics\.json/);
  }
  for (const values of [serviceValues, platformValues]) {
    assert.match(values, /recordingSpool:\s*\n\s+enabled: true/);
    assert.match(values, /partSizeBytes: "8388608"/);
    assert.match(values, /uploadConcurrency: "4"/);
    assert.match(values, /leaseSecretKey:/);
  }
  assert.match(platformTemplate, /kind: StatefulSet/);
  assert.match(platformTemplate, /podManagementPolicy: Parallel/);
  assert.match(platformTemplate, /volumeClaimTemplates:/);
  assert.match(platformTemplate, /name: recording-spool/);
  assert.match(platformTemplate, /name: recording-state/);
  assert.match(platformValues, /persistence:\s*\n\s+enabled: true/);
  assert.match(platformValues, /recordingSpoolSize: 50Gi/);
});

test('RustPBX capacity limits and overload telemetry are consistent across deployment surfaces', () => {
  const composeFiles = [
    readFileSync(VOICE_COMPOSE, 'utf8'),
    readFileSync(SERVICE_VOICE_COMPOSE, 'utf8'),
    readFileSync(PRODUCTION_COMPOSE, 'utf8')
  ];
  const platformValues = readFileSync(HELM_VALUES, 'utf8');
  const platformTemplate = readFileSync(HELM_RUSTPBX, 'utf8');
  const serviceValues = readFileSync(SERVICE_HELM_VALUES, 'utf8');
  const serviceTemplate = readFileSync(SERVICE_HELM_RUSTPBX, 'utf8');
  const serviceMonitor = readFileSync(
    new URL('../services/converact-service/helm/converact/templates/service-monitor.yaml', import.meta.url),
    'utf8'
  );
  const prometheusRules = readFileSync(
    new URL('../services/converact-service/helm/converact/files/prometheus-rules.yaml', import.meta.url),
    'utf8'
  );

  for (const compose of composeFiles) {
    assert.match(compose, /RUSTPBX_SIP_MAX_ACTIVE_TRANSACTIONS[^\n]*65536/);
    assert.match(compose, /RUSTPBX_SIP_MAX_FINISHED_TRANSACTIONS[^\n]*65536/);
    assert.match(compose, /RUSTPBX_SIP_INCOMING_TRANSACTION_QUEUE_CAPACITY[^\n]*8192/);
    assert.match(compose, /RUSTPBX_SIP_MAX_TRANSPORT_CONNECTIONS[^\n]*32768/);
    assert.match(compose, /RUSTPBX_MEDIA_SESSION_CLEANUP_CONCURRENCY[^\n]*64/);
    assert.match(compose, /RUSTPBX_MEDIA_SESSION_CLEANUP_TIMEOUT_MS[^\n]*2000/);
    assert.match(compose, /RUSTPBX_MEDIA_RECORDING_CHANNEL_CAPACITY[^\n]*256/);
    assert.match(compose, /RUSTPBX_MEDIA_RECORDING_WORKER_THREADS[^\n]*4/);
    assert.match(compose, /RUSTPBX_MEDIA_RECORDING_WORKER_QUEUE_CAPACITY[^\n]*4096/);
    assert.match(compose, /RUSTPBX_CALL_RECORD_MAX_CONCURRENT[^\n]*64/);
    assert.match(compose, /RUSTPBX_CALL_RECORD_CHANNEL_CAPACITY[^\n]*65536/);
    assert.match(compose, /RUSTPBX_CALL_RECORD_WORKER_THREADS[^\n]*1/);
  }
  for (const values of [platformValues, serviceValues]) {
    assert.match(values, /sipCapacity:[\s\S]*maxActiveTransactions: 65536/);
    assert.match(values, /incomingTransactionQueueCapacity: 8192/);
    assert.match(values, /maxTransportConnections: 32768/);
    assert.match(values, /sessionCleanupConcurrency: 64/);
    assert.match(values, /sessionCleanupTimeoutMs: 2000/);
    assert.match(values, /recordingChannelCapacity: 256/);
    assert.match(values, /recordingWorkerThreads: 4/);
    assert.match(values, /recordingWorkerQueueCapacity: 4096/);
    assert.match(values, /callRecordCapacity:[\s\S]*maxConcurrent: 64/);
    assert.match(values, /callRecordCapacity:[\s\S]*channelCapacity: 65536/);
    assert.match(values, /callRecordCapacity:[\s\S]*workerThreads: 1/);
  }
  assert.match(platformTemplate, /sip_max_active_transactions = \{\{ int \.Values\.voice\.sipCapacity\.maxActiveTransactions \}\}/);
  assert.match(platformTemplate, /media_session_cleanup_concurrency = \{\{ int \.Values\.voice\.mediaCapacity\.sessionCleanupConcurrency \}\}/);
  assert.match(platformTemplate, /media_session_cleanup_timeout_ms = \{\{ int \.Values\.voice\.mediaCapacity\.sessionCleanupTimeoutMs \}\}/);
  assert.match(platformTemplate, /max_concurrent = \{\{ int \.Values\.voice\.callRecordCapacity\.maxConcurrent \}\}/);
  assert.match(platformTemplate, /channel_capacity = \{\{ int \.Values\.voice\.callRecordCapacity\.channelCapacity \}\}/);
  assert.match(platformTemplate, /worker_threads = \{\{ int \.Values\.voice\.callRecordCapacity\.workerThreads \}\}/);
  assert.match(platformTemplate, /kind: ServiceMonitor[\s\S]*port: management/);
  assert.match(platformTemplate, /IveKitRustPbxSipOverloadRejections/);
  assert.match(serviceTemplate, /name: RUSTPBX_SIP_MAX_ACTIVE_TRANSACTIONS/);
  assert.match(serviceTemplate, /name: RUSTPBX_MEDIA_SESSION_CLEANUP_CONCURRENCY/);
  assert.match(serviceTemplate, /name: RUSTPBX_MEDIA_SESSION_CLEANUP_TIMEOUT_MS/);
  assert.match(serviceTemplate, /name: RUSTPBX_MEDIA_RECORDING_CHANNEL_CAPACITY/);
  assert.match(serviceTemplate, /name: RUSTPBX_MEDIA_RECORDING_WORKER_THREADS/);
  assert.match(serviceTemplate, /name: RUSTPBX_MEDIA_RECORDING_WORKER_QUEUE_CAPACITY/);
  assert.match(serviceTemplate, /name: RUSTPBX_CALL_RECORD_MAX_CONCURRENT/);
  assert.match(serviceTemplate, /name: RUSTPBX_CALL_RECORD_CHANNEL_CAPACITY/);
  assert.match(serviceTemplate, /name: RUSTPBX_CALL_RECORD_WORKER_THREADS/);
  assert.match(serviceTemplate, /prometheus\.io\/path: \/metrics/);
  assert.match(serviceMonitor, /app\.kubernetes\.io\/component: rustpbx[\s\S]*port: management/);
  assert.match(prometheusRules, /IveKitRustPbxSipTransactionSaturation/);
  assert.match(prometheusRules, /IveKitRustPbxSipOverloadRejections/);
  assert.match(platformTemplate, /IveKitRustPbxRecordingQueueDrops/);
  assert.match(prometheusRules, /IveKitRustPbxRecordingQueueDrops/);
  assert.match(prometheusRules, /rustpbx_media_recording_queue_drops_total/);
  assert.match(platformTemplate, /IveKitRustPbxSessionCleanupDegraded/);
  assert.match(prometheusRules, /IveKitRustPbxSessionCleanupDegraded/);
  assert.match(prometheusRules, /rustpbx_media_session_cleanup_total/);
});

test('checked-in RustPBX config is secret-free and cannot start production', () => {
  const config = readFileSync(CHECKED_IN_CONFIG, 'utf8');

  assert.doesNotMatch(config, /sqlite/i);
  assert.doesNotMatch(config, /dev-(?:pbx-key|rwi-token)/i);
  assert.match(config, /__RUSTPBX_DATABASE_URL_REQUIRED__/);
  assert.match(config, /__RUSTPBX_MANAGEMENT_TOKEN_REQUIRED__/);
  assert.match(config, /\[ami\]/);
  assert.match(config, /tcp_port = 5060/);
  assert.match(config, /generated_dir = "\/app\/generated"/);
  assert.match(config, /sip_max_active_transactions = 65536/);
  assert.match(config, /sip_incoming_transaction_queue_capacity = 8192/);
  assert.match(config, /media_session_cleanup_concurrency = 64/);
  assert.match(config, /media_session_cleanup_timeout_ms = 2000/);
  assert.match(config, /media_recording_channel_capacity = 256/);
  assert.match(config, /media_recording_worker_threads = 4/);
  assert.match(config, /media_recording_worker_queue_capacity = 4096/);
  assert.match(config, /persist_to_database = false/);
  assert.match(config, /\[\[proxy\.user_backends\]\]\s*\ntype = "extension"/);
  assert.match(config, /__RUSTPBX_RWI_TOKEN_REQUIRED__/);
  assert.match(config, /generated by scripts\/render-rustpbx-config\.ts/i);
});

test('Helm Voice workload is opt-in, immutable, isolated, and operationally bounded', () => {
  const values = readFileSync(HELM_VALUES, 'utf8');
  const secrets = readFileSync(HELM_SECRETS, 'utf8');
  const opc = readFileSync(HELM_OPC, 'utf8');
  const rustpbx = readFileSync(HELM_RUSTPBX, 'utf8');

  assert.match(values, /voice:\s*\n\s+enabled: false/);
  assert.match(values, /repository: ivekit\/rustpbx/);
  assert.match(values, /routeSnapshot:\s*\n\s+hmacKey:/);
  assert.match(values, /database:\s*\n\s+username: rustpbx_app\s*\n\s+name: rustpbx/);
  assert.match(secrets, /rustpbx-database-url:/);
  assert.match(secrets, /rustpbx-management-token:/);
  assert.match(secrets, /rustpbx-rwi-token:/);
  assert.match(secrets, /rustpbx-webhook-token:/);
  assert.match(secrets, /ivekit-voice-address-key:/);
  assert.match(secrets, /rustpbx-route-snapshot-hmac-key:/);
  assert.match(rustpbx, /^\{\{- if \.Values\.voice\.enabled \}\}/);
  assert.match(rustpbx, /image: \{\{ \$rustpbxImage \| quote \}\}/);
  assert.match(rustpbx, /\[\[console\.api_tokens\]\]/);
  assert.match(rustpbx, /token = \{\{ \$managementToken \| quote \}\}/);
  assert.match(rustpbx, /\[ami\][\s\S]*allows =/);
  assert.match(rustpbx, /tcp_port = \{\{ \$sipPort \}\}/);
  assert.match(rustpbx, /generated_dir = "\/app\/generated"/);
  assert.match(rustpbx, /mountPath: \/app\/generated/);
  assert.match(rustpbx, /name: route-snapshot-projector/);
  assert.match(rustpbx, /src\/converact-rustpbx-route-snapshot\.ts/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_ROUTE_LOOKUP_HMAC_ROOT_KEY/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_INBOUND_ADMISSION_URL/);
  assert.match(rustpbx, /fieldPath: metadata\.name/);
  assert.match(rustpbx, /mountPath: \/app\/route-snapshot/);
  assert.match(rustpbx, /postStart:[\s\S]*\/ami\/v1\/reload\/trunks/);
  assert.match(rustpbx, /\/bin\/bash[\s\S]*\/dev\/tcp\/127\.0\.0\.1/);
  assert.doesNotMatch(rustpbx, /\bcurl\b|\bwget\b/);
  assert.match(rustpbx, /\[\[proxy\.user_backends\]\]\s*\n\s*type = "extension"/);
  assert.match(rustpbx, /persist_to_database = false/);
  assert.match(rustpbx, /kind: PodDisruptionBudget/);
  assert.match(rustpbx, /readinessProbe:/);
  assert.match(rustpbx, /livenessProbe:/);
  assert.doesNotMatch(rustpbx, /path: \/health/);
  assert.match(rustpbx, /securityContext:/);
  assert.match(rustpbx, /resources:/);
  assert.match(rustpbx, /name: management/);
  assert.match(rustpbx, /clusterIP: None/);
  assert.match(rustpbx, /name: sip-udp/);
  assert.match(rustpbx, /name: rtp-/);
  assert.doesNotMatch(opc, /rustpbx-database-url/);
  assert.doesNotMatch(opc, /RUSTPBX_DB_PASSWORD/);
  assert.match(opc, /name: RUSTPBX_MANAGEMENT_TOKEN[\s\S]*?key: rustpbx-management-token/);
});

test('standalone Helm Voice renderer receives a distinct RustPBX management token', () => {
  const values = readFileSync(SERVICE_HELM_VALUES, 'utf8');
  const rustpbx = readFileSync(SERVICE_HELM_RUSTPBX, 'utf8');

  assert.match(values, /managementTokenKey: rustpbx-management-token/);
  assert.match(values, /hmacKeyKey: rustpbx-route-snapshot-hmac-key/);
  assert.match(values, /amiAllows:\s*\n\s+- 127\.0\.0\.1/);
  assert.match(rustpbx, /name: RUSTPBX_MANAGEMENT_TOKEN[\s\S]*?key: \{\{ \.Values\.voice\.managementTokenKey \}\}/);
  assert.match(rustpbx, /name: RUSTPBX_AMI_ALLOWS/);
  assert.match(rustpbx, /mountPath: \/app\/generated/);
  assert.match(rustpbx, /dist\/converact-rustpbx-route-snapshot\.js/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_ROUTE_LOOKUP_HMAC_ROOT_KEY/);
  assert.match(rustpbx, /IVEKIT_RUSTPBX_INBOUND_ADMISSION_URL/);
  assert.match(rustpbx, /fieldPath: metadata\.name/);
  assert.match(rustpbx, /mountPath: \/app\/route-snapshot/);
  assert.match(rustpbx, /postStart:[\s\S]*\/ami\/v1\/reload\/trunks/);
  assert.match(rustpbx, /\/bin\/bash[\s\S]*\/dev\/tcp\/127\.0\.0\.1/);
  assert.doesNotMatch(rustpbx, /\bcurl\b|\bwget\b/);
  assert.doesNotMatch(rustpbx, /path: \/health/);
  assert.match(values, /CONVERACT_FABRIC_VOICE_SECRET_ENV_NAMES: "RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN"/);
});

test('Voice reconciliation scheduler discovers call and configuration unknowns', () => {
  const runtime = readFileSync(VOICE_RUNTIME, 'utf8');
  const worker = runtime.slice(
    runtime.indexOf('export function startIveKitVoiceReconciliationWorker'),
    runtime.indexOf('export async function listVoiceWorkerTenants')
  );

  assert.match(worker, /createVoiceQueueTenantLister\([\s\S]*'voice_command', 'voice_configuration'/);
});

test('Voice multi-queue tenant lister rotates scarce capacity without exceeding the limit', async () => {
  const pg = {
    async query(_text: string, values: unknown[]) {
      const queue = values[0];
      const rows = queue === 'voice_command'
        ? [{ tenant_id: 'tenant-call' }, { tenant_id: 'tenant-shared' }]
        : [{ tenant_id: 'tenant-config' }, { tenant_id: 'tenant-shared' }];
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
    }
  } as unknown as PgQueryable;
  const list = createVoiceQueueTenantLister(
    pg,
    ['voice_command', 'voice_configuration'],
    1
  );

  assert.deepEqual(await list(), ['tenant-call']);
  assert.deepEqual(await list(), ['tenant-config']);
  assert.deepEqual(await list(), ['tenant-call']);
});

function serviceBlock(compose: string, serviceName: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-zA-Z0-9_-]+:$/.test(lines[index] || '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}
