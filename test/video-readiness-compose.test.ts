import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const COMPOSE_PATH = new URL('../docker-compose.callcenter.yml', import.meta.url);
const ROOT_ENV_PATH = new URL('../.env.example', import.meta.url);
const PRODUCTION_COMPOSE_PATH = new URL('../infra/docker-compose.production.yml', import.meta.url);
const PRODUCTION_TINODE_COMPOSE_PATH = new URL('../infra/docker-compose.tinode.yml', import.meta.url);
const PRODUCTION_ENV_PATH = new URL('../infra/env.example', import.meta.url);
const K8S_OPC_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/opc-deployment.yaml', import.meta.url);
const K8S_HELPERS_PATH = new URL('../infra/k8s/templates/_helpers.tpl', import.meta.url);
const K8S_AI_AGENT_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/ai-agent-deployment.yaml', import.meta.url);
const K8S_SECRETS_PATH = new URL('../infra/k8s/templates/secrets.yaml', import.meta.url);
const K8S_VALUES_PATH = new URL('../infra/k8s/values.yaml', import.meta.url);
const K8S_LIVEKIT_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/livekit-deployment.yaml', import.meta.url);
const K8S_MINIO_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/minio-deployment.yaml', import.meta.url);
const K8S_EGRESS_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/livekit-egress-deployment.yaml', import.meta.url);
const K8S_SIP_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/livekit-sip-deployment.yaml', import.meta.url);
const K8S_RUSTDESK_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/rustdesk-server-deployment.yaml', import.meta.url);
const LIVEKIT_CONFIG_PATH = new URL('../config/livekit.yaml', import.meta.url);
const EGRESS_CONFIG_PATH = new URL('../config/egress.yaml', import.meta.url);
const GITIGNORE_PATH = new URL('../.gitignore', import.meta.url);

test('call center compose passes media security and recording env into opc service', () => {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');
  const opcEnvironment = readServiceEnvironment(compose, 'opc');

  assert.equal(opcEnvironment.LIVEKIT_URL, 'ws://livekit:7880');
  assert.equal(opcEnvironment.LIVEKIT_PUBLIC_URL, '${LIVEKIT_PUBLIC_URL:-ws://localhost:7880}');
  assert.equal(opcEnvironment.OPC_MEDIA_API_TOKEN, '${OPC_MEDIA_API_TOKEN:-dev-media-token}');
  assert.equal(opcEnvironment.OPC_MEDIA_INVITE_SECRET, '${OPC_MEDIA_INVITE_SECRET:-dev-media-invite-secret}');
  assert.equal(opcEnvironment.OPC_MEDIA_INVITE_TTL_MS, '${OPC_MEDIA_INVITE_TTL_MS:-86400000}');
  assert.equal(opcEnvironment.OPC_MEDIA_RECORDING_RETENTION_DAYS, '${OPC_MEDIA_RECORDING_RETENTION_DAYS:-90}');
  assert.equal(opcEnvironment.OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT, '${OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT:-0}');
  assert.equal('OPC_DB_PATH' in opcEnvironment, false);
  assert.equal(opcEnvironment.MINIO_ENDPOINT, 'http://minio:9000');
  assert.equal(opcEnvironment.MINIO_BUCKET, '${MINIO_BUCKET:-recordings}');
  assert.equal(opcEnvironment.MINIO_ACCESS_KEY, 'minioadmin');
  assert.equal(opcEnvironment.MINIO_SECRET_KEY, 'minioadmin');
});

test('call center compose npm scripts ignore the private root env file', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };

  for (const scriptName of ['dev:callcenter', 'dev:callcenter:detach']) {
    const script = packageJson.scripts[scriptName] || '';
    assert.match(script, /^COMPOSE_DISABLE_ENV_FILE=1 /);
    assert.match(script, / docker compose /);
    assert.match(script, / --env-file \.env\.example /);
    assert.match(script, / -f docker-compose\.callcenter\.yml up/);
  }
});

test('LiveKit local config sends webhooks to the reusable media endpoint', () => {
  const config = readFileSync(LIVEKIT_CONFIG_PATH, 'utf8');

  assert.match(config, /http:\/\/opc:3000\/api\/media\/webhooks\/livekit/);
  assert.doesNotMatch(config, /http:\/\/opc:3000\/api\/webhooks\/livekit/);
});

test('call center compose keeps local LiveKit and egress credentials aligned with mounted configs', () => {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');
  const livekitConfig = readFileSync(LIVEKIT_CONFIG_PATH, 'utf8');
  const egressConfig = readFileSync(EGRESS_CONFIG_PATH, 'utf8');

  assert.match(livekitConfig, /keys:\n  devkey: secret/);
  assert.match(livekitConfig, /webhook:\n  api_key: devkey/);
  assert.match(egressConfig, /api_key: devkey/);
  assert.match(egressConfig, /api_secret: secret/);
  assert.match(egressConfig, /access_key: minioadmin/);
  assert.match(egressConfig, /\n    secret: minioadmin/);

  for (const serviceName of ['livekit-sip', 'opc', 'ai-agent']) {
    const environment = readServiceEnvironment(compose, serviceName);
    assert.equal(environment.LIVEKIT_API_KEY, 'devkey');
    assert.equal(environment.LIVEKIT_API_SECRET, 'secret');
  }

  assert.equal(readServiceEnvironment(compose, 'minio').MINIO_ROOT_USER, 'minioadmin');
  assert.equal(readServiceEnvironment(compose, 'minio').MINIO_ROOT_PASSWORD, 'minioadmin');
  const opcEnvironment = readServiceEnvironment(compose, 'opc');
  assert.equal(opcEnvironment.MINIO_ACCESS_KEY, 'minioadmin');
  assert.equal(opcEnvironment.MINIO_SECRET_KEY, 'minioadmin');
});

test('production compose mounts shared media configs and passes Media Core env into opc', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');

  assert.ok(readServiceVolumes(compose, 'livekit').includes('${OPC_MEDIA_CONFIG_DIR:-../.runtime/media}/livekit.yaml:/etc/livekit.yaml:ro'));
  assert.ok(readServiceVolumes(compose, 'livekit-egress').includes('${OPC_MEDIA_CONFIG_DIR:-../.runtime/media}/egress.yaml:/etc/egress.yaml:ro'));
  assert.ok(!readServiceVolumes(compose, 'livekit').includes('../config/livekit.yaml:/etc/livekit.yaml:ro'));
  assert.ok(!readServiceVolumes(compose, 'livekit-egress').includes('../config/egress.yaml:/etc/egress.yaml:ro'));
  assert.ok(readServiceVolumes(compose, 'rustpbx').includes('../config/rustpbx.docker.toml:/app/rustpbx.toml:ro'));

  const opcEnvironment = readServiceEnvironment(compose, 'opc');
  assert.equal(opcEnvironment.LIVEKIT_URL, '${LIVEKIT_URL:?LIVEKIT_URL is required}');
  assert.equal(opcEnvironment.LIVEKIT_PUBLIC_URL, '${LIVEKIT_PUBLIC_URL:?LIVEKIT_PUBLIC_URL is required}');
  assert.equal(opcEnvironment.LIVEKIT_API_KEY, '${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}');
  assert.equal(opcEnvironment.LIVEKIT_API_SECRET, '${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}');
  assert.equal(opcEnvironment.OPC_MEDIA_API_TOKEN, '${OPC_MEDIA_API_TOKEN}');
  assert.equal(opcEnvironment.OPC_MEDIA_INVITE_SECRET, '${OPC_MEDIA_INVITE_SECRET}');
  assert.equal(opcEnvironment.OPC_MEDIA_INVITE_TTL_MS, '${OPC_MEDIA_INVITE_TTL_MS:-86400000}');
  assert.equal(opcEnvironment.OPC_MEDIA_RECORDING_RETENTION_DAYS, '${OPC_MEDIA_RECORDING_RETENTION_DAYS:-90}');
  assert.equal(opcEnvironment.OPC_RECORDING_HTTP_ALLOWED_ORIGINS, '${OPC_RECORDING_HTTP_ALLOWED_ORIGINS:-http://minio:9000}');
  assert.equal(opcEnvironment.MINIO_ENDPOINT, 'http://minio:9000');
  assert.equal(opcEnvironment.MINIO_BUCKET, '${MINIO_BUCKET:-recordings}');
  assert.equal(opcEnvironment.MINIO_ACCESS_KEY, '${MINIO_ACCESS_KEY:-minioadmin}');
  assert.equal(opcEnvironment.MINIO_SECRET_KEY, '${MINIO_SECRET_KEY:-minioadmin}');
  assert.equal(opcEnvironment.OPC_API_KEY, '${OPC_API_KEY}');
});

test('Compose media services use pinned versions and production bundled media is opt-in', () => {
  const local = readFileSync(COMPOSE_PATH, 'utf8');
  const production = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const productionEnv = readFileSync(PRODUCTION_ENV_PATH, 'utf8');

  for (const compose of [local, production]) {
    assert.match(readServiceBlock(compose, 'livekit'), /livekit\/livekit-server:\$\{LIVEKIT_SERVER_IMAGE_TAG:-v1\.13\.3\}/);
    assert.match(readServiceBlock(compose, 'livekit-sip'), /livekit\/sip:\$\{LIVEKIT_SIP_IMAGE_TAG:-v1\.6\.0\}/);
    const egress = readServiceBlock(compose, 'livekit-egress');
    assert.match(egress, /livekit\/egress:\$\{LIVEKIT_EGRESS_IMAGE_TAG:-v1\.13\.0\}/);
    assert.match(egress, /SYS_ADMIN/);
    assert.match(egress, /http:\/\/127\.0\.0\.1:8091/);
  }

  for (const service of ['livekit', 'livekit-sip', 'livekit-egress']) {
    assert.match(readServiceBlock(production, service), /profiles: \["media-bundled"\]/);
  }
  assert.equal(readServiceEnvironment(production, 'livekit-sip').LIVEKIT_URL, 'ws://livekit:7880');
  assert.doesNotMatch(readServiceBlock(production, 'opc'), /livekit:\n\s+condition:/);
  assert.doesNotMatch(readServiceBlock(production, 'ai-agent'), /- livekit/);
  assert.match(productionEnv, /^LIVEKIT_URL=ws:\/\/media\.internal\.example:7880$/m);
});

test('production compose gates databases PgBouncer and object storage', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const postgresBootstrap = readServiceBlock(compose, 'postgres-bootstrap');
  const postgresBootstrapEnvironment = readServiceEnvironment(compose, 'postgres-bootstrap');

  assert.match(postgresBootstrap, /image: postgres:16-alpine/);
  assert.match(postgresBootstrap, /entrypoint: \["\/bin\/sh", "\/bootstrap\/bootstrap-postgres-databases\.sh"\]/);
  assert.equal(postgresBootstrapEnvironment.POSTGRES_HOST, 'postgres');
  assert.equal(postgresBootstrapEnvironment.POSTGRES_USER, 'opc');
  assert.equal(postgresBootstrapEnvironment.OPC_POSTGRES_BOOTSTRAP_DATABASES, 'keycloak');
  assert.ok(
    readServiceVolumes(compose, 'postgres-bootstrap').includes(
      './scripts/bootstrap-postgres-databases.sh:/bootstrap/bootstrap-postgres-databases.sh:ro'
    )
  );
  assert.match(postgresBootstrap, /postgres:\n\s+condition: service_healthy/);
  assert.match(postgresBootstrap, /restart: "no"/);

  const pgbouncer = readServiceBlock(compose, 'pgbouncer');
  assert.match(pgbouncer, /postgres-bootstrap:\n\s+condition: service_completed_successfully/);
  assert.match(pgbouncer, /healthcheck:[\s\S]*psql -X[\s\S]*-p 6432/);
  assert.match(pgbouncer, /-Atqc 'SELECT 1' >\/dev\/null 2>&1/);
  assert.doesNotMatch(pgbouncer, /pg_isready/);
  assert.match(pgbouncer, /PGPASSWORD=\$\$POSTGRESQL_PASSWORD/);
  assert.match(
    readServiceBlock(compose, 'keycloak'),
    /postgres-bootstrap:\n\s+condition: service_completed_successfully/
  );

  const minioInit = readServiceBlock(compose, 'minio-init');
  const minioInitEnvironment = readServiceEnvironment(compose, 'minio-init');
  assert.match(minioInit, /image: minio\/mc:RELEASE\.2025-08-13T08-35-41Z/);
  assert.equal(minioInitEnvironment.MINIO_ENDPOINT, 'http://minio:9000');
  assert.equal(minioInitEnvironment.MINIO_BUCKET, '${MINIO_BUCKET:-recordings}');
  assert.equal(minioInitEnvironment.MINIO_INIT_MAX_ATTEMPTS, '${MINIO_INIT_MAX_ATTEMPTS:-30}');
  assert.equal(minioInitEnvironment.MINIO_INIT_RETRY_SECONDS, '${MINIO_INIT_RETRY_SECONDS:-2}');
  assert.ok(
    readServiceVolumes(compose, 'minio-init').includes(
      './scripts/bootstrap-minio-bucket.sh:/bootstrap/bootstrap-minio-bucket.sh:ro'
    )
  );
  assert.match(minioInit, /minio:\n\s+condition: service_started/);
  assert.match(minioInit, /restart: "no"/);

  for (const serviceName of ['livekit-egress', 'rustpbx', 'opc']) {
    assert.match(
      readServiceBlock(compose, serviceName),
      /minio-init:\n\s+condition: service_completed_successfully/
    );
  }
  assert.match(readServiceBlock(compose, 'opc'), /pgbouncer:\n\s+condition: service_healthy/);
});

test('self-hosted Tinode extends database bootstrap and waits for it', () => {
  const overlay = readFileSync(PRODUCTION_TINODE_COMPOSE_PATH, 'utf8');

  assert.equal(
    readServiceEnvironment(overlay, 'postgres-bootstrap').OPC_POSTGRES_BOOTSTRAP_DATABASES,
    'keycloak,tinode'
  );
  assert.match(
    readServiceBlock(overlay, 'tinode'),
    /postgres-bootstrap:\n\s+condition: service_completed_successfully/
  );
  assert.match(readServiceBlock(overlay, 'opc'), /tinode:\n\s+condition: service_started/);
});

test('Chatwoot is opt-in and production bootstrap remains PostgreSQL-only', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const envExample = readFileSync(PRODUCTION_ENV_PATH, 'utf8');

  assert.match(readServiceBlock(compose, 'chatwoot'), /profiles: \["omnichannel"\]/);
  assert.doesNotMatch(compose, /sqlite|OPC_DB_PATH/i);
  assert.match(envExample, /^MINIO_INIT_MAX_ATTEMPTS=30$/m);
  assert.match(envExample, /^MINIO_INIT_RETRY_SECONDS=2$/m);
});

test('compose media ports and Egress Redis match the LiveKit runtime configuration', () => {
  const localCompose = readFileSync(COMPOSE_PATH, 'utf8');
  const productionCompose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const localLiveKitConfig = readFileSync(LIVEKIT_CONFIG_PATH, 'utf8');
  const localEgressConfig = readFileSync(EGRESS_CONFIG_PATH, 'utf8');

  for (const compose of [localCompose, productionCompose]) {
    const livekit = readServiceBlock(compose, 'livekit');
    assert.match(livekit, /"7881:7881\/tcp"/);
    assert.match(livekit, /"7882-7892:7882-7892\/udp"/);
    assert.doesNotMatch(livekit, /"7881:7881\/udp"/);
  }

  assert.match(localLiveKitConfig, /tcp_port: 7881/);
  assert.match(localLiveKitConfig, /udp_port: 7882-7892/);
  assert.doesNotMatch(localLiveKitConfig, /port_range_start|port_range_end/);
  assert.match(localEgressConfig, /redis:\n  address: redis:6379/);
  assert.match(localEgressConfig, /storage:\n  s3:/);
  assert.doesNotMatch(localEgressConfig, /^s3:/m);
});

test('compose files deploy Tinode with PostgreSQL and wire internal OPC endpoints', () => {
  const localCompose = readFileSync(COMPOSE_PATH, 'utf8');
  const productionBaseCompose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const productionTinodeCompose = readFileSync(PRODUCTION_TINODE_COMPOSE_PATH, 'utf8');

  for (const compose of [localCompose, productionTinodeCompose]) {
    const tinode = readServiceBlock(compose, 'tinode');
    const tinodeEnvironment = readServiceEnvironment(compose, 'tinode');
    const opcEnvironment = readServiceEnvironment(compose, 'opc');

    assert.match(tinode, /image: tinode\/tinode:\$\{TINODE_IMAGE_TAG:-0\.25\.3\}/);
    assert.match(tinode, /"6060:6060"/);
    assert.ok(readServiceVolumes(compose, 'tinode').includes('tinode_botdata:/botdata'));
    assert.equal(tinodeEnvironment.STORE_USE_ADAPTER, 'postgres');
    assert.equal(tinodeEnvironment.WAIT_FOR, 'postgres:5432');
    assert.match(tinodeEnvironment.AUTH_TOKEN_KEY, /\$\{TINODE_AUTH_TOKEN_KEY/);
    assert.match(tinodeEnvironment.UID_ENCRYPTION_KEY, /\$\{TINODE_UID_ENCRYPTION_KEY/);
    assert.equal(tinodeEnvironment.SAMPLE_DATA, '${TINODE_SAMPLE_DATA:-}');
    assert.equal(tinodeEnvironment.UPGRADE_DB, '${TINODE_UPGRADE_DB:-false}');
    assert.equal(opcEnvironment.TINODE_BASE_URL, '${TINODE_BASE_URL:-http://tinode:6060}');
    assert.equal(opcEnvironment.TINODE_WS_URL, '${TINODE_WS_URL:-ws://tinode:6060/v0/channels}');
  }

  assert.equal(
    readServiceEnvironment(localCompose, 'tinode').POSTGRES_DSN,
    'postgresql://opc:${POSTGRES_PASSWORD:-opc_dev_pass}@postgres:5432/tinode?sslmode=disable&connect_timeout=10'
  );
  assert.equal(
    readServiceEnvironment(productionTinodeCompose, 'tinode').POSTGRES_DSN,
    '${TINODE_POSTGRES_DSN:?TINODE_POSTGRES_DSN is required}'
  );
  assert.equal(
    readServiceEnvironment(productionTinodeCompose, 'tinode').AUTH_TOKEN_KEY,
    '${TINODE_AUTH_TOKEN_KEY:?TINODE_AUTH_TOKEN_KEY is required}'
  );
  assert.equal(
    readServiceEnvironment(productionTinodeCompose, 'tinode').UID_ENCRYPTION_KEY,
    '${TINODE_UID_ENCRYPTION_KEY:?TINODE_UID_ENCRYPTION_KEY is required}'
  );
  assert.doesNotMatch(productionBaseCompose, /^  tinode:/m);
  const baseOpcEnvironment = readServiceEnvironment(productionBaseCompose, 'opc');
  assert.equal(baseOpcEnvironment.TINODE_BASE_URL, '${TINODE_BASE_URL:-}');
  assert.equal(baseOpcEnvironment.TINODE_WS_URL, '${TINODE_WS_URL:-}');
});

test('production env requires Tinode runtime identity and PostgreSQL configuration', () => {
  const envExample = readFileSync(PRODUCTION_ENV_PATH, 'utf8');

  for (const envName of [
    'TINODE_IMAGE_TAG',
    'TINODE_POSTGRES_DSN',
    'TINODE_AUTH_TOKEN_KEY',
    'TINODE_UID_ENCRYPTION_KEY',
    'TINODE_SAMPLE_DATA',
    'TINODE_UPGRADE_DB'
  ]) {
    assert.match(envExample, new RegExp(`^${envName}=`, 'm'));
  }
  assert.match(envExample, /^TINODE_IMAGE_TAG=0\.25\.3$/m);
});

test('compose files define RustDesk OSS runtime and wire OPC control-plane env', () => {
  const localCompose = readFileSync(COMPOSE_PATH, 'utf8');
  const productionCompose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');

  const localHbbs = readServiceBlock(localCompose, 'rustdesk-hbbs');
  const localHbbr = readServiceBlock(localCompose, 'rustdesk-hbbr');
  assert.match(localHbbs, /image: rustdesk\/rustdesk-server:\$\{RUSTDESK_SERVER_IMAGE_TAG:-latest\}/);
  assert.match(localHbbs, /command: hbbs/);
  assert.match(localHbbs, /ALWAYS_USE_RELAY: \$\{RUSTDESK_ALWAYS_USE_RELAY:-N\}/);
  assert.match(localHbbs, /"21115:21115\/tcp"/);
  assert.match(localHbbs, /"21116:21116\/tcp"/);
  assert.match(localHbbs, /"21116:21116\/udp"/);
  assert.match(localHbbs, /"21118:21118\/tcp"/);
  assert.ok(readServiceVolumes(localCompose, 'rustdesk-hbbs').includes('rustdesk_data:/root'));
  assert.match(localHbbr, /command: hbbr/);
  assert.match(localHbbr, /"21117:21117\/tcp"/);
  assert.match(localHbbr, /"21119:21119\/tcp"/);
  assert.ok(readServiceVolumes(localCompose, 'rustdesk-hbbr').includes('rustdesk_data:/root'));

  const productionHbbs = readServiceBlock(productionCompose, 'rustdesk-hbbs');
  const productionHbbr = readServiceBlock(productionCompose, 'rustdesk-hbbr');
  assert.match(productionHbbs, /network_mode: "host"/);
  assert.match(productionHbbs, /command: hbbs/);
  assert.match(productionHbbs, /ALWAYS_USE_RELAY: \$\{RUSTDESK_ALWAYS_USE_RELAY:-N\}/);
  assert.ok(readServiceVolumes(productionCompose, 'rustdesk-hbbs').includes('rustdesk_data:/root'));
  assert.match(productionHbbr, /network_mode: "host"/);
  assert.match(productionHbbr, /command: hbbr/);
  assert.ok(readServiceVolumes(productionCompose, 'rustdesk-hbbr').includes('rustdesk_data:/root'));

  for (const compose of [localCompose, productionCompose]) {
    const opcEnvironment = readServiceEnvironment(compose, 'opc');
    assert.equal(opcEnvironment.OPC_REMOTE_GATEWAY_PROVIDER, '${OPC_REMOTE_GATEWAY_PROVIDER:-rustdesk}');
    assert.equal(opcEnvironment.OPC_REMOTE_GATEWAY_TENANT_ID, '${OPC_REMOTE_GATEWAY_TENANT_ID:-tenant_led}');
    assert.equal(opcEnvironment.OPC_REMOTE_GATEWAY_TARGET_TYPE, '${OPC_REMOTE_GATEWAY_TARGET_TYPE:-device}');
    assert.match(opcEnvironment.OPC_REMOTE_GATEWAY_TARGET_ID, /\$\{OPC_REMOTE_GATEWAY_TARGET_ID/);
    assert.match(opcEnvironment.OPC_REMOTE_GATEWAY_TARGET_DISPLAY_NAME, /\$\{OPC_REMOTE_GATEWAY_TARGET_DISPLAY_NAME/);
    assert.match(opcEnvironment.OPC_REMOTE_GATEWAY_ACTOR_IDENTITY, /\$\{OPC_REMOTE_GATEWAY_ACTOR_IDENTITY/);
    assert.equal(opcEnvironment.OPC_REMOTE_GATEWAY_CONSENT_SCOPES, '${OPC_REMOTE_GATEWAY_CONSENT_SCOPES:-view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard}');
    assert.match(opcEnvironment.OPC_REMOTE_GATEWAY_CHECK_LAUNCH_URL, /\$\{OPC_REMOTE_GATEWAY_CHECK_LAUNCH_URL/);
    assert.equal(opcEnvironment.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL, '${OPC_RUSTDESK_CONTROL_PLANE_BASE_URL:-http://opc:3000}');
    assert.match(opcEnvironment.OPC_RUSTDESK_ID_SERVER, /\$\{OPC_RUSTDESK_ID_SERVER/);
    assert.match(opcEnvironment.OPC_RUSTDESK_RELAY_SERVER, /\$\{OPC_RUSTDESK_RELAY_SERVER/);
    assert.match(opcEnvironment.OPC_RUSTDESK_API_SERVER, /\$\{OPC_RUSTDESK_API_SERVER/);
    assert.match(opcEnvironment.OPC_RUSTDESK_PUBLIC_KEY, /\$\{OPC_RUSTDESK_PUBLIC_KEY/);
    assert.equal(opcEnvironment.OPC_RUSTDESK_PUBLIC_KEY_FILE, '${OPC_RUSTDESK_PUBLIC_KEY_FILE:-/rustdesk/id_ed25519.pub}');
    assert.match(opcEnvironment.OPC_RUSTDESK_LAUNCH_BASE_URL, /\$\{OPC_RUSTDESK_LAUNCH_BASE_URL/);
    assert.match(opcEnvironment.OPC_RUSTDESK_LAUNCH_SECRET, /\$\{OPC_RUSTDESK_LAUNCH_SECRET/);
    assert.match(opcEnvironment.OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS, /\$\{OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS/);
    assert.match(opcEnvironment.OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE, /\$\{OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE/);
    assert.equal(opcEnvironment.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT, '${OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT:-0}');
    assert.match(opcEnvironment.OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS, /\$\{OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS/);
    assert.match(opcEnvironment.OPC_RUSTDESK_CHECK_DEVICE_ONLINE, /\$\{OPC_RUSTDESK_CHECK_DEVICE_ONLINE/);
    assert.match(opcEnvironment.OPC_RUSTDESK_CHECK_OPERATION_AUDIT, /\$\{OPC_RUSTDESK_CHECK_OPERATION_AUDIT/);
    assert.match(opcEnvironment.OPC_RUSTDESK_CHECK_SERVER_PORTS, /\$\{OPC_RUSTDESK_CHECK_SERVER_PORTS/);
    assert.match(opcEnvironment.OPC_RUSTDESK_CHECK_HOST, /\$\{OPC_RUSTDESK_CHECK_HOST/);
    assert.match(opcEnvironment.OPC_RUSTDESK_CHECK_TCP_PORTS, /\$\{OPC_RUSTDESK_CHECK_TCP_PORTS/);
    assert.match(opcEnvironment.OPC_RUSTDESK_CHECK_UDP_PORTS, /\$\{OPC_RUSTDESK_CHECK_UDP_PORTS/);
    assert.match(opcEnvironment.OPC_RUSTDESK_CHECK_TIMEOUT_MS, /\$\{OPC_RUSTDESK_CHECK_TIMEOUT_MS/);
    assert.equal(opcEnvironment.OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE, '${OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE:-1}');
    assert.equal(opcEnvironment.OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT, '${OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT:-1}');
    assert.equal(opcEnvironment.OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS, '${OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS:-1}');
    assert.equal(opcEnvironment.OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL, '${OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL:-1}');
    assert.equal(opcEnvironment.OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL, '${OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL:-1}');
    assert.equal(opcEnvironment.OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL, '${OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL:-1}');
    assert.equal(opcEnvironment.OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT, '${OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT:-0}');
    assert.equal('OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE' in opcEnvironment, false);
    assert.match(opcEnvironment.OPC_RUSTDESK_API_TOKEN, /\$\{OPC_RUSTDESK_API_TOKEN/);
    assert.ok(readServiceVolumes(compose, 'opc').includes('rustdesk_data:/rustdesk:ro'));
  }
});

test('production env example declares required Media Core secrets', () => {
  const envExample = readFileSync(PRODUCTION_ENV_PATH, 'utf8');
  const gitignore = readFileSync(GITIGNORE_PATH, 'utf8');

  assert.match(envExample, /^OPC_MEDIA_API_TOKEN=/m);
  assert.match(envExample, /^OPC_MEDIA_INVITE_SECRET=/m);
  assert.match(envExample, /^OPC_MEDIA_INVITE_TTL_MS=/m);
  assert.match(envExample, /^OPC_MEDIA_RECORDING_RETENTION_DAYS=90$/m);
  assert.match(envExample, /^OPC_RECORDING_HTTP_ALLOWED_ORIGINS=/m);
  assert.doesNotMatch(envExample, /^OPC_DB_PATH=/m);
  assert.match(envExample, /^MINIO_BUCKET=/m);
  assert.match(envExample, /^MINIO_ACCESS_KEY=/m);
  assert.match(envExample, /^MINIO_SECRET_KEY=/m);
  assert.match(envExample, /^OPC_MEDIA_CONFIG_DIR=/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_PROVIDER=rustdesk/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_BASE_URL=http:\/\/opc:3000/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_API_TOKEN=change_me_rustdesk_control_token/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_TENANT_ID=tenant_led/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_TARGET_TYPE=device/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_TARGET_ID=/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_CHECK_LAUNCH_URL=0/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_TARGET_DISPLAY_NAME=Remote gateway smoke device/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_ACTOR_IDENTITY=agent_remote_gateway_smoke/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_CONSENT_SCOPES=view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_CREATE_PATH=/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_SESSION_PATH=/m);
  assert.match(envExample, /^OPC_REMOTE_GATEWAY_AUDIT_PATH=/m);
  assert.match(envExample, /^OPC_RUSTDESK_CONTROL_PLANE_BASE_URL=/m);
  assert.match(envExample, /^OPC_RUSTDESK_ID_SERVER=/m);
  assert.match(envExample, /^OPC_RUSTDESK_RELAY_SERVER=/m);
  assert.match(envExample, /^OPC_RUSTDESK_API_SERVER=/m);
  assert.match(envExample, /^OPC_RUSTDESK_PUBLIC_KEY=/m);
  assert.match(envExample, /^OPC_RUSTDESK_PUBLIC_KEY_FILE=/m);
  assert.match(envExample, /^OPC_RUSTDESK_SERVER_KEY=/m);
  assert.match(envExample, /^OPC_RUSTDESK_LAUNCH_BASE_URL=/m);
  assert.match(envExample, /^OPC_RUSTDESK_LAUNCH_SECRET=/m);
  assert.match(envExample, /^OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS=/m);
  assert.match(envExample, /^OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE=/m);
  assert.match(envExample, /^OPC_RUSTDESK_REQUIRE_PROTOCOL_URL=/m);
  assert.match(envExample, /^OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE=/m);
  assert.match(envExample, /^OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT=0/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_TOKEN_SECRET=$/m);
  assert.match(envExample, /^OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS=/m);
  assert.match(envExample, /^OPC_RUSTDESK_API_TOKEN=/m);
  assert.match(envExample, /^OPC_RUSTDESK_CHECK_SERVER_PORTS=/m);
  assert.match(envExample, /^OPC_RUSTDESK_CHECK_HOST=/m);
  assert.match(envExample, /^OPC_RUSTDESK_CHECK_TCP_PORTS=/m);
  assert.match(envExample, /^OPC_RUSTDESK_CHECK_UDP_PORTS=/m);
  assert.match(envExample, /^OPC_RUSTDESK_CHECK_TIMEOUT_MS=/m);
  assert.match(envExample, /^OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE=1/m);
  assert.match(envExample, /^OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT=1/m);
  assert.match(envExample, /^OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS=1/m);
  assert.match(envExample, /^OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL=1/m);
  assert.match(envExample, /^OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL=1/m);
  assert.match(envExample, /^OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL=1/m);
  assert.match(envExample, /^OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT=0/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_INSTANCE_ID=$/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_COMMAND_TOKEN=$/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS=2000/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS=40000/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS=15000/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE=$/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON=\[\]$/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE=$/m);
  assert.match(envExample, /^OPC_RUSTDESK_EDGE_RESTART_ARGS_JSON=\[\]$/m);
  assert.match(envExample, /^RUSTDESK_ALWAYS_USE_RELAY=N/m);
  assert.match(gitignore, /^\.runtime\//m);
});

test('root env example documents every video readiness input', () => {
  const envExample = readFileSync(ROOT_ENV_PATH, 'utf8');

  for (const envName of [
    'OPC_BASE_URL',
    'OPC_FRONTEND_URL',
    'OPC_MEDIA_API_TOKEN',
    'OPC_MEDIA_INVITE_SECRET',
    'OPC_MEDIA_INVITE_TTL_MS',
    'OPC_MEDIA_SMOKE_TENANT_ID',
    'OPC_MEDIA_SMOKE_ROOM_NAME',
    'OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT',
    'OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT',
    'OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS',
    'OPC_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS',
    'OPC_MEDIA_SMOKE_KEEP_ROOM_OPEN',
    'OPC_MEDIA_RECORDING_RETENTION_DAYS',
    'OPC_RECORDING_HTTP_ALLOWED_ORIGINS',
    'OPC_VIDEO_READINESS_TARGETS',
    'OPC_VIDEO_READINESS_CONTINUE_ON_FAILURE',
    'OPC_VIDEO_READINESS_REPORT_FILE',
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'OPC_API_KEY',
    'OPC_AVATAR_SMOKE_ROOM_NAME',
    'OPC_AVATAR_SMOKE_IDENTITY',
    'OPC_AVATAR_SMOKE_SAMPLE_CHUNKS',
    'OPC_AVATAR_SMOKE_SETTLE_SECONDS',
    'OPC_AI_CALLBACK_SMOKE_TENANT_ID',
    'OPC_AI_CALLBACK_SMOKE_ROOM_NAME',
    'OPC_BROWSER_SMOKE_TENANT_ID',
    'OPC_BROWSER_SMOKE_AGENT_A_TOKEN',
    'OPC_BROWSER_SMOKE_AGENT_A_USER_ID',
    'OPC_BROWSER_SMOKE_AGENT_A_SEAT_ID',
    'OPC_BROWSER_SMOKE_AGENT_B_TOKEN',
    'OPC_BROWSER_SMOKE_AGENT_B_USER_ID',
    'OPC_BROWSER_SMOKE_AGENT_B_SEAT_ID',
    'OPC_BROWSER_SMOKE_HEADLESS',
    'OPC_BROWSER_SMOKE_SCREEN_SHARE',
    'OPC_BROWSER_SMOKE_TIMEOUT_MS',
    'OPC_CUSTOMER_VIDEO_URL',
    'OPC_CUSTOMER_BROWSER_SMOKE_URL',
    'OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME',
    'OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID',
    'OPC_CUSTOMER_BROWSER_SMOKE_INVITE',
    'OPC_CUSTOMER_BROWSER_SMOKE_EXPIRES_AT',
    'OPC_CUSTOMER_BROWSER_SMOKE_HEADLESS',
    'OPC_CUSTOMER_BROWSER_SMOKE_TIMEOUT_MS',
    'OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_REMOTE',
    'OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_SCREEN_SHARE',
    'OPC_WEB_ASSIST_CUSTOMER_URL',
    'OPC_REMOTE_ASSIST_CUSTOMER_URL',
    'OPC_WEB_ASSIST_REMOTE_SESSION_ID',
    'OPC_WEB_ASSIST_TENANT_ID',
    'OPC_WEB_ASSIST_ENGINEER_TOKEN',
    'OPC_WEB_ASSIST_ENGINEER_USER_ID',
    'OPC_WEB_ASSIST_ENGINEER_EMAIL',
    'OPC_WEB_ASSIST_BROWSER_SMOKE_HEADLESS',
    'OPC_WEB_ASSIST_BROWSER_SMOKE_TIMEOUT_MS',
    'OPC_COLLAB_SMOKE_TENANT_ID',
    'OPC_COLLAB_SMOKE_USER_ID',
    'OPC_COLLAB_SMOKE_BUSINESS_REF_TYPE',
    'OPC_COLLAB_SMOKE_BUSINESS_REF_ID',
    'OPC_COLLAB_SMOKE_BUSINESS_REF_DISPLAY_NAME',
    'OPC_COLLAB_SMOKE_REMOTE_MODE',
    'OPC_COLLAB_SMOKE_ADAPTER_PROVIDER',
    'OPC_COLLAB_SMOKE_TOOL_PROVIDER',
    'OPC_COLLAB_SMOKE_TOOL_EXTERNAL_ID',
    'OPC_COLLAB_SMOKE_TOOL_LAUNCH_URL',
    'OPC_COLLAB_SMOKE_USE_GATEWAY_TOOL',
    'OPC_COLLAB_SMOKE_GATEWAY_TARGET_TYPE',
    'OPC_COLLAB_SMOKE_GATEWAY_TARGET_ID',
    'OPC_COLLAB_SMOKE_GATEWAY_TARGET_DISPLAY_NAME',
    'OPC_COLLAB_SMOKE_CONSENT_SCOPES',
    'OPC_COLLAB_SMOKE_EVIDENCE_FILENAME',
    'OPC_COLLAB_SMOKE_RETENTION_UNTIL',
    'OPC_REMOTE_GATEWAY_PROVIDER',
    'OPC_REMOTE_GATEWAY_BASE_URL',
    'OPC_REMOTE_GATEWAY_API_TOKEN',
    'OPC_REMOTE_GATEWAY_TARGET_TYPE',
    'OPC_REMOTE_GATEWAY_TARGET_ID',
    'OPC_REMOTE_GATEWAY_CHECK_LAUNCH_URL',
    'OPC_REMOTE_GATEWAY_TARGET_DISPLAY_NAME',
    'OPC_REMOTE_GATEWAY_ACTOR_IDENTITY',
    'OPC_REMOTE_GATEWAY_CONSENT_SCOPES',
    'OPC_REMOTE_GATEWAY_CREATE_PATH',
    'OPC_REMOTE_GATEWAY_SESSION_PATH',
    'OPC_REMOTE_GATEWAY_AUDIT_PATH',
    'OPC_RUSTDESK_CONTROL_PLANE_BASE_URL',
    'OPC_RUSTDESK_ID_SERVER',
    'OPC_RUSTDESK_RELAY_SERVER',
    'OPC_RUSTDESK_API_SERVER',
    'OPC_RUSTDESK_PUBLIC_KEY',
    'OPC_RUSTDESK_PUBLIC_KEY_FILE',
    'OPC_RUSTDESK_SERVER_KEY',
    'OPC_RUSTDESK_LAUNCH_BASE_URL',
    'OPC_RUSTDESK_LAUNCH_SECRET',
    'OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS',
    'OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE',
    'OPC_RUSTDESK_REQUIRE_PROTOCOL_URL',
    'OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE',
    'OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT',
    'OPC_RUSTDESK_EDGE_TOKEN_SECRET',
    'OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS',
    'OPC_RUSTDESK_API_TOKEN',
    'OPC_RUSTDESK_CHECK_SERVER_PORTS',
    'OPC_RUSTDESK_CHECK_HOST',
    'OPC_RUSTDESK_CHECK_TCP_PORTS',
    'OPC_RUSTDESK_CHECK_UDP_PORTS',
    'OPC_RUSTDESK_CHECK_TIMEOUT_MS',
    'OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE',
    'OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT',
    'OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS',
    'OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL',
    'OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL',
    'OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL',
    'OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT',
    'OPC_RUSTDESK_EDGE_INSTANCE_ID',
    'OPC_RUSTDESK_EDGE_COMMAND_TOKEN',
    'OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS',
    'OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS',
    'OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS',
    'OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE',
    'OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON',
    'OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE',
    'OPC_RUSTDESK_EDGE_RESTART_ARGS_JSON',
    'LIVEKIT_SIP_BRIDGE_TARGET',
    'RUSTPBX_LIVEKIT_TRUNK',
    'RUSTPBX_RWI_URL',
    'RUSTPBX_RWI_TOKEN',
    'OPC_SIP_VOLTE_REQUIRE_ACTIVE',
    'OPC_SIP_VOLTE_GATEWAY_STATUS_URL',
    'OPC_SIP_VOLTE_GATEWAY_STATUS_TOKEN',
    'MINIO_BUCKET',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY'
  ]) {
    assert.match(envExample, new RegExp(`^${envName}=`, 'm'), `${envName} missing from .env.example`);
  }
});

test('Kubernetes templates pass reusable video env into opc and ai agent', () => {
  const opcDeployment = readFileSync(K8S_OPC_DEPLOYMENT_PATH, 'utf8');
  const aiAgentDeployment = readFileSync(K8S_AI_AGENT_DEPLOYMENT_PATH, 'utf8');
  const secrets = readFileSync(K8S_SECRETS_PATH, 'utf8');
  const values = readFileSync(K8S_VALUES_PATH, 'utf8');

  for (const envName of [
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'OPC_MEDIA_API_TOKEN',
    'OPC_MEDIA_INVITE_SECRET',
    'OPC_MEDIA_INVITE_TTL_MS',
    'OPC_MEDIA_RECORDING_RETENTION_DAYS',
    'OPC_RECORDING_HTTP_ALLOWED_ORIGINS',
    'OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT',
    'OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS',
    'OPC_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS',
    'MINIO_ENDPOINT',
    'MINIO_BUCKET',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'OPC_API_KEY',
    'OPC_REMOTE_GATEWAY_PROVIDER',
    'OPC_REMOTE_GATEWAY_TENANT_ID',
    'OPC_REMOTE_GATEWAY_TARGET_TYPE',
    'OPC_REMOTE_GATEWAY_TARGET_ID',
    'OPC_REMOTE_GATEWAY_TARGET_DISPLAY_NAME',
    'OPC_REMOTE_GATEWAY_ACTOR_IDENTITY',
    'OPC_REMOTE_GATEWAY_CONSENT_SCOPES',
    'OPC_REMOTE_GATEWAY_CHECK_LAUNCH_URL',
    'OPC_RUSTDESK_CONTROL_PLANE_BASE_URL',
    'OPC_RUSTDESK_ID_SERVER',
    'OPC_RUSTDESK_RELAY_SERVER',
    'OPC_RUSTDESK_API_SERVER',
    'OPC_RUSTDESK_PUBLIC_KEY',
    'OPC_RUSTDESK_PUBLIC_KEY_FILE',
    'OPC_RUSTDESK_LAUNCH_BASE_URL',
    'OPC_RUSTDESK_LAUNCH_SECRET',
    'OPC_RUSTDESK_LAUNCH_TOKEN_TTL_MS',
    'OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE',
    'OPC_RUSTDESK_REQUIRE_PROTOCOL_URL',
    'OPC_RUSTDESK_REQUIRE_DEVICE_ONLINE',
    'OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT',
    'OPC_RUSTDESK_EDGE_TOKEN_SECRET',
    'OPC_RUSTDESK_DEVICE_ONLINE_TTL_MS',
    'OPC_RUSTDESK_CHECK_DEVICE_ONLINE',
    'OPC_RUSTDESK_CHECK_OPERATION_AUDIT',
    'OPC_RUSTDESK_CHECK_SERVER_PORTS',
    'OPC_RUSTDESK_CHECK_HOST',
    'OPC_RUSTDESK_CHECK_TCP_PORTS',
    'OPC_RUSTDESK_CHECK_UDP_PORTS',
    'OPC_RUSTDESK_CHECK_TIMEOUT_MS',
    'OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE',
    'OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT',
    'OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS',
    'OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL',
    'OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL',
    'OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL',
    'OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT',
    'OPC_RUSTDESK_API_TOKEN'
  ]) {
    assert.match(opcDeployment, new RegExp(`name: ${envName}`));
  }

  assert.match(aiAgentDeployment, /name: OPC_API_KEY/);
  assert.match(opcDeployment, /include "opc\.livekitInternalUrl"/);
  assert.match(opcDeployment, /include "opc\.livekitPublicUrl"/);
  assert.match(aiAgentDeployment, /include "opc\.livekitInternalUrl"/);
  assert.match(opcDeployment, /mountPath: \/rustdesk/);
  assert.match(opcDeployment, /claimName: {{ \.Release\.Name }}-rustdesk-data/);
  assert.match(values, /^  launchTokenTtlMs: "900000"/m);
  assert.match(values, /^  edgeTokenSecret: ""/m);
  assert.match(values, /^  readinessRequireHttpsLaunchUrl: "1"/m);
  assert.match(values, /^  requirePhysicalDisconnect: "0"/m);
  assert.match(values, /^  readinessCheckPhysicalDisconnect: "0"/m);
  assert.doesNotMatch(opcDeployment, /name: OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE/);

  for (const secretKey of [
    'livekit-api-key',
    'livekit-api-secret',
    'media-api-token',
    'media-invite-secret',
    'minio-access-key',
    'minio-secret-key',
    'opc-api-key',
    'rustdesk-api-token',
    'rustdesk-edge-token-secret',
    'rustdesk-public-key',
    'rustdesk-server-key'
  ]) {
    assert.match(secrets, new RegExp(`${secretKey}:`));
  }
  assert.doesNotMatch(secrets, /opc-postgres/);
  assert.match(secrets, /\.Release\.Name/);

  assert.match(values, /^media:/m);
  for (const valueKey of [
    'apiToken:',
    'inviteSecret:',
    'inviteTtlMs:',
    'minioEndpoint:',
    'minioBucket:',
    'minioAccessKey:',
    'minioSecretKey:'
  ]) {
    assert.match(values, new RegExp(`^  ${valueKey}`, 'm'));
  }
});

test('Kubernetes chart defines the in-cluster media runtime dependencies', () => {
  const livekit = readFileSync(K8S_LIVEKIT_DEPLOYMENT_PATH, 'utf8');
  const minio = readFileSync(K8S_MINIO_DEPLOYMENT_PATH, 'utf8');
  const egress = readFileSync(K8S_EGRESS_DEPLOYMENT_PATH, 'utf8');
  const sip = readFileSync(K8S_SIP_DEPLOYMENT_PATH, 'utf8');
  const values = readFileSync(K8S_VALUES_PATH, 'utf8');
  const helpers = readFileSync(K8S_HELPERS_PATH, 'utf8');
  const opc = readFileSync(K8S_OPC_DEPLOYMENT_PATH, 'utf8');
  const aiAgent = readFileSync(K8S_AI_AGENT_DEPLOYMENT_PATH, 'utf8');

  assert.match(livekit, /bundled-dev is development-only/);
  assert.match(livekit, /name: {{ \.Release\.Name }}-livekit-config/);
  assert.match(livekit, /kind: Deployment/);
  assert.match(livekit, /name: {{ \.Release\.Name }}-livekit/);
  assert.match(livekit, /\.Values\.livekit\.image\.repository/);
  assert.match(livekit, /containerPort: 7880/);
  assert.match(livekit, /kind: Service/);
  assert.match(livekit, /port: 7880/);

  assert.match(minio, /kind: Deployment/);
  assert.match(minio, /name: {{ \.Release\.Name }}-minio/);
  assert.match(minio, /\.Values\.media\.minio\.image\.repository/);
  assert.match(minio, /MINIO_ROOT_USER/);
  assert.match(minio, /MINIO_ROOT_PASSWORD/);
  assert.match(minio, /kind: Service/);
  assert.match(minio, /\.Values\.media\.minio\.service\.port/);
  assert.match(minio, /targetPort: 9000/);

  assert.match(egress, /name: {{ \.Release\.Name }}-livekit-egress-config/);
  assert.match(egress, /kind: Deployment/);
  assert.match(egress, /name: {{ \.Release\.Name }}-livekit-egress/);
  assert.match(egress, /\.Values\.media\.egress\.image\.repository/);
  assert.match(egress, /EGRESS_CONFIG_FILE/);
  assert.match(egress, /include "opc\.livekitInternalUrl"/);
  assert.match(egress, /logging:\n\s+level: info/);
  assert.match(egress, /redis:\n\s+address:/);
  assert.match(egress, /health_port:/);
  assert.match(egress, /storage:\n\s+s3:/);
  assert.doesNotMatch(egress, /^\s{4}s3:/m);
  assert.match(egress, /SYS_ADMIN/);
  assert.match(egress, /readinessProbe:/);
  assert.match(egress, /http:\/\/%s-minio:9000/);

  assert.match(sip, /kind: Deployment/);
  assert.match(sip, /name: {{ \.Release\.Name }}-livekit-sip/);
  assert.match(sip, /\.Values\.media\.sip\.image\.repository/);
  assert.match(sip, /include "opc\.livekitInternalUrl"/);
  assert.match(sip, /SIP_PORT/);
  assert.match(sip, /containerPort: 5061/);
  assert.match(sip, /kind: Service/);

  assert.match(values, /repository: livekit\/livekit-server/);
  assert.match(values, /repository: minio\/minio/);
  assert.match(values, /repository: livekit\/egress/);
  assert.match(values, /repository: livekit\/sip/);
  assert.match(values, /^  enabled: false$/m);
  assert.match(values, /^  deploymentMode: external$/m);
  assert.match(values, /^  publicUrl: ""$/m);
  assert.match(values, /tag: v1\.13\.3/);
  assert.match(values, /tag: v1\.13\.0/);
  assert.match(values, /tag: v1\.6\.0/);
  assert.match(helpers, /define "opc\.livekitInternalUrl"/);
  assert.match(helpers, /livekit\.url is required when livekit\.enabled=false/);
  assert.match(helpers, /define "opc\.livekitPublicUrl"/);
  assert.match(helpers, /livekit\.publicUrl is required/);
  assert.match(helpers, /livekit\.publicUrl must use wss:\/\//);
  assert.match(helpers, /define "opc\.livekitApiKey"/);
  assert.match(helpers, /livekit\.apiKey is required/);
  assert.match(helpers, /define "opc\.livekitApiSecret"/);
  assert.match(helpers, /livekit\.apiSecret is required/);
  assert.doesNotMatch(readFileSync(K8S_SECRETS_PATH, 'utf8'), /livekit\.apiKey \| default "devkey"/);
  assert.doesNotMatch(readFileSync(K8S_SECRETS_PATH, 'utf8'), /livekit\.apiSecret \| default "secret"/);
  assert.doesNotMatch(livekit, /livekit\.apiKey \| default "devkey"/);
  assert.doesNotMatch(egress, /livekit\.apiSecret \| default "secret"/);
  assert.match(opc, /name: LIVEKIT_PUBLIC_URL/);
  assert.match(opc, /include "opc\.livekitPublicUrl"/);
  assert.match(aiAgent, /include "opc\.livekitInternalUrl"/);
  assert.match(values, /port: 9000/);
  assert.match(values, /consolePort: 9001/);
  assert.match(values, /^  sip:\n[\s\S]*?^      limits:\n        memory: "256Mi"\n        cpu: "300m"/m);

  for (const valueKey of [
    'image:',
    'rtcPort:',
    'portRangeStart:',
    'portRangeEnd:',
    'minio:',
    'egress:',
    'sip:'
  ]) {
    assert.match(values, new RegExp(`^  ${valueKey}`, 'm'));
  }
});

test('Kubernetes chart defines RustDesk OSS runtime dependencies', () => {
  const rustdesk = readFileSync(K8S_RUSTDESK_DEPLOYMENT_PATH, 'utf8');
  const values = readFileSync(K8S_VALUES_PATH, 'utf8');

  assert.match(rustdesk, /{{- if \.Values\.rustdesk\.enabled }}/);
  assert.match(rustdesk, /kind: PersistentVolumeClaim/);
  assert.match(rustdesk, /name: {{ \.Release\.Name }}-rustdesk-data/);
  assert.match(rustdesk, /kind: Deployment/);
  assert.match(rustdesk, /name: {{ \.Release\.Name }}-rustdesk/);
  assert.match(rustdesk, /name: hbbs/);
  assert.match(rustdesk, /command: \["hbbs"\]/);
  assert.match(rustdesk, /name: hbbr/);
  assert.match(rustdesk, /command: \["hbbr"\]/);
  assert.match(rustdesk, /\.Values\.rustdesk\.image\.repository/);
  assert.match(rustdesk, /containerPort: 21115/);
  assert.match(rustdesk, /containerPort: 21116/);
  assert.match(rustdesk, /protocol: UDP/);
  assert.match(rustdesk, /containerPort: 21117/);
  assert.match(rustdesk, /containerPort: 21118/);
  assert.match(rustdesk, /containerPort: 21119/);
  assert.match(rustdesk, /name: ALWAYS_USE_RELAY/);
  assert.match(rustdesk, /\.Values\.rustdesk\.alwaysUseRelay/);
  assert.match(rustdesk, /kind: Service/);
  assert.match(rustdesk, /\.Values\.rustdesk\.service\.type/);

  assert.match(values, /^rustdesk:/m);
  assert.match(values, /repository: rustdesk\/rustdesk-server/);
  assert.match(values, /alwaysUseRelay: "N"/);
  for (const valueKey of [
    'enabled:',
    'publicHost:',
    'relayHost:',
    'apiServer:',
    'controlPlaneBaseUrl:',
    'publicKey:',
    'publicKeyFile:',
    'launchBaseUrl:',
    'protocolUrlTemplate:',
    'requirePhysicalDisconnect:',
    'checkDeviceOnline:',
    'checkOperationAudit:',
    'checkServerPorts:',
    'checkHost:',
    'checkTcpPorts:',
    'checkUdpPorts:',
    'checkTimeoutMs:',
    'readinessCheckDeviceOnline:',
    'readinessCheckOperationAudit:',
    'readinessCheckServerPorts:',
    'readinessRequireProtocolUrl:',
    'readinessCheckLaunchUrl:',
    'readinessCheckPhysicalDisconnect:',
    'remoteGatewayTenantId:',
    'remoteGatewayTargetType:',
    'remoteGatewayTargetId:',
    'remoteGatewayTargetDisplayName:',
    'remoteGatewayActorIdentity:',
    'remoteGatewayConsentScopes:',
    'remoteGatewayCheckLaunchUrl:',
    'serverKey:',
    'apiToken:',
    'service:',
    'persistence:'
  ]) {
    assert.match(values, new RegExp(`^  ${valueKey}`, 'm'));
  }
});

function readServiceEnvironment(compose: string, serviceName: string): Record<string, string> {
  const serviceBlock = readServiceBlock(compose, serviceName);
  const environmentBlock = readNestedBlock(serviceBlock, 'environment', 4);
  const values: Record<string, string> = {};
  for (const line of environmentBlock.split('\n')) {
    const match = line.match(/^\s{6}([A-Z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = stripYamlScalar(match[2]);
  }
  return values;
}

function readServiceVolumes(compose: string, serviceName: string): string[] {
  const serviceBlock = readServiceBlock(compose, serviceName);
  const volumesBlock = readNestedBlock(serviceBlock, 'volumes', 4);
  return volumesBlock
    .split('\n')
    .map((line) => line.match(/^\s{6}-\s*(.*)$/)?.[1])
    .filter((volume): volume is string => Boolean(volume))
    .map(stripYamlScalar);
}

function readServiceBlock(compose: string, serviceName: string): string {
  const lines = compose.split('\n');
  const startIndex = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(startIndex, -1, `service ${serviceName} not found`);
  const endIndex = lines.findIndex((line, index) => index > startIndex && /^  [a-zA-Z0-9_-]+:$/.test(line));
  return lines.slice(startIndex, endIndex === -1 ? lines.length : endIndex).join('\n');
}

function readNestedBlock(block: string, key: string, indent: number): string {
  const lines = block.split('\n');
  const startIndex = lines.findIndex((line) => line === `${' '.repeat(indent)}${key}:`);
  assert.notEqual(startIndex, -1, `${key} block not found`);
  const nextPeerIndex = lines.findIndex(
    (line, index) => index > startIndex && line.startsWith(' '.repeat(indent)) && !line.startsWith(' '.repeat(indent + 2))
  );
  return lines.slice(startIndex + 1, nextPeerIndex === -1 ? lines.length : nextPeerIndex).join('\n');
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
