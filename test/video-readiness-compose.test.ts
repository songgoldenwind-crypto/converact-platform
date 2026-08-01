import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const COMPOSE_PATH = new URL('../docker-compose.callcenter.yml', import.meta.url);
const ROOT_ENV_PATH = new URL('../.env.example', import.meta.url);
const PRODUCTION_COMPOSE_PATH = new URL('../infra/docker-compose.production.yml', import.meta.url);
const PRODUCTION_TINODE_COMPOSE_PATH = new URL('../infra/docker-compose.tinode.yml', import.meta.url);
const PRODUCTION_ENV_PATH = new URL('../infra/env.example', import.meta.url);
const LIVEKIT_EDGE_COMPOSE_PATH = new URL('../infra/livekit/docker-compose.yml', import.meta.url);
const LIVEKIT_STORAGE_COMPOSE_PATH = new URL('../infra/livekit/docker-compose.storage.yml', import.meta.url);
const LIVEKIT_ENV_PATH = new URL('../infra/livekit/env.example', import.meta.url);
const CONVERACT_APPLICATION_COMPOSE_PATH = new URL('../infra/converact/docker-compose.yml', import.meta.url);
const CONVERACT_POSTGRES_ROLE_INIT_PATH = new URL('../infra/converact/init-postgres-runtime-role.sh', import.meta.url);
const K8S_CONVERACT_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/converact-deployment.yaml', import.meta.url);
const K8S_HELPERS_PATH = new URL('../infra/k8s/templates/_helpers.tpl', import.meta.url);
const K8S_AI_AGENT_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/ai-agent-deployment.yaml', import.meta.url);
const K8S_FRONTEND_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/frontend-deployment.yaml', import.meta.url);
const K8S_RUSTPBX_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/rustpbx-deployment.yaml', import.meta.url);
const K8S_POSTGRES_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/postgres-statefulset.yaml', import.meta.url);
const K8S_REDIS_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/redis-deployment.yaml', import.meta.url);
const K8S_NATS_DEPLOYMENT_PATH = new URL('../infra/k8s/templates/nats-statefulset.yaml', import.meta.url);
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
const DOCKERFILE_PATH = new URL('../Dockerfile', import.meta.url);
const MINIO_SERVER_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
const MINIO_CLIENT_IMAGE = 'minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';

test('call center compose passes media security and recording env into converact service', () => {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');
  const converactEnvironment = readServiceEnvironment(compose, 'converact');

  assert.equal(converactEnvironment.LIVEKIT_URL, 'ws://livekit:7880');
  assert.equal(converactEnvironment.LIVEKIT_PUBLIC_URL, '${LIVEKIT_PUBLIC_URL:-ws://localhost:7880}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_API_TOKEN, '${CONVERACT_MEDIA_API_TOKEN:-dev-media-token}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_INVITE_SECRET, '${CONVERACT_MEDIA_INVITE_SECRET:-dev-media-invite-secret}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_INVITE_TTL_MS, '${CONVERACT_MEDIA_INVITE_TTL_MS:-86400000}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_RECORDING_RETENTION_DAYS, '${CONVERACT_MEDIA_RECORDING_RETENTION_DAYS:-90}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT, '${CONVERACT_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT:-0}');
  assert.equal(converactEnvironment.CONVERACT_SIP_VOLTE_ENABLED, '${CONVERACT_SIP_VOLTE_ENABLED:-0}');
  assert.equal('CONVERACT_DB_PATH' in converactEnvironment, false);
  assert.equal(converactEnvironment.MINIO_ENDPOINT, 'http://minio:9000');
  assert.equal(converactEnvironment.MINIO_BUCKET, '${MINIO_BUCKET:-recordings}');
  assert.equal(converactEnvironment.MINIO_ACCESS_KEY, 'minioadmin');
  assert.equal(converactEnvironment.MINIO_SECRET_KEY, 'minioadmin');
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

  assert.match(config, /http:\/\/converact:3000\/api\/media\/webhooks\/livekit/);
  assert.doesNotMatch(config, /http:\/\/converact:3000\/api\/webhooks\/livekit/);
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

  for (const serviceName of ['livekit-sip', 'converact', 'ai-agent']) {
    const environment = readServiceEnvironment(compose, serviceName);
    assert.equal(environment.LIVEKIT_API_KEY, 'devkey');
    assert.equal(environment.LIVEKIT_API_SECRET, 'secret');
  }

  assert.equal(readServiceEnvironment(compose, 'minio').MINIO_ROOT_USER, 'minioadmin');
  assert.equal(readServiceEnvironment(compose, 'minio').MINIO_ROOT_PASSWORD, 'minioadmin');
  const converactEnvironment = readServiceEnvironment(compose, 'converact');
  assert.equal(converactEnvironment.MINIO_ACCESS_KEY, 'minioadmin');
  assert.equal(converactEnvironment.MINIO_SECRET_KEY, 'minioadmin');
});

test('call center compose bootstraps recording storage without coupling LiveKit to storage', () => {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');
  const minio = readServiceBlock(compose, 'minio');
  const minioInit = readServiceBlock(compose, 'minio-init');

  assert.ok(minio.includes(`image: ${MINIO_SERVER_IMAGE}`));
  assert.ok(minioInit.includes(`image: ${MINIO_CLIENT_IMAGE}`));
  assert.match(minioInit, /bootstrap-minio-bucket\.sh/);
  assert.equal(readServiceEnvironment(compose, 'minio-init').MINIO_BUCKET, '${MINIO_BUCKET:-recordings}');
  assert.ok(
    readServiceVolumes(compose, 'minio-init').includes(
      './infra/scripts/bootstrap-minio-bucket.sh:/bootstrap/bootstrap-minio-bucket.sh:ro'
    )
  );
  assert.match(minioInit, /minio:\n\s+condition: service_healthy/);
  assert.match(
    readServiceBlock(compose, 'livekit-egress'),
    /minio-init:\n\s+condition: service_completed_successfully/
  );

  const livekit = readServiceBlock(compose, 'livekit');
  assert.doesNotMatch(livekit, /minio(?:-init)?:/);
  assert.doesNotMatch(livekit, /livekit-egress:/);
});

test('production compose mounts shared media configs and passes Media Core env into converact', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');

  assert.ok(readServiceVolumes(compose, 'livekit').includes('${CONVERACT_MEDIA_CONFIG_DIR:-../.runtime/media}/livekit.yaml:/etc/livekit.yaml:ro'));
  assert.ok(readServiceVolumes(compose, 'livekit-egress').includes('${CONVERACT_MEDIA_CONFIG_DIR:-../.runtime/media}/egress.yaml:/etc/egress.yaml:ro'));
  assert.ok(!readServiceVolumes(compose, 'livekit').includes('../config/livekit.yaml:/etc/livekit.yaml:ro'));
  assert.ok(!readServiceVolumes(compose, 'livekit-egress').includes('../config/egress.yaml:/etc/egress.yaml:ro'));
  assert.ok(readServiceVolumes(compose, 'rustpbx').includes('rustpbx-runtime-config:/app/config:ro'));
  assert.ok(!readServiceVolumes(compose, 'rustpbx').includes('../config/rustpbx.docker.toml:/app/rustpbx.toml:ro'));

  const converactEnvironment = readServiceEnvironment(compose, 'converact');
  assert.equal(converactEnvironment.LIVEKIT_URL, '${LIVEKIT_URL:?LIVEKIT_URL is required}');
  assert.equal(converactEnvironment.LIVEKIT_PUBLIC_URL, '${LIVEKIT_PUBLIC_URL:?LIVEKIT_PUBLIC_URL is required}');
  assert.equal(converactEnvironment.LIVEKIT_API_KEY, '${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}');
  assert.equal(converactEnvironment.LIVEKIT_API_SECRET, '${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_API_TOKEN, '${CONVERACT_MEDIA_API_TOKEN}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_INVITE_SECRET, '${CONVERACT_MEDIA_INVITE_SECRET}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_INVITE_TTL_MS, '${CONVERACT_MEDIA_INVITE_TTL_MS:-86400000}');
  assert.equal(converactEnvironment.CONVERACT_MEDIA_RECORDING_RETENTION_DAYS, '${CONVERACT_MEDIA_RECORDING_RETENTION_DAYS:-90}');
  assert.equal(converactEnvironment.CONVERACT_RECORDING_HTTP_ALLOWED_ORIGINS, '${CONVERACT_RECORDING_HTTP_ALLOWED_ORIGINS:-http://minio:9000}');
  assert.equal(converactEnvironment.CONVERACT_SIP_VOLTE_ENABLED, '${CONVERACT_SIP_VOLTE_ENABLED:-0}');
  assert.equal(converactEnvironment.LIVEKIT_SIP_BRIDGE_TARGET, '${LIVEKIT_SIP_BRIDGE_TARGET:-}');
  assert.equal(converactEnvironment.RUSTPBX_LIVEKIT_TRUNK, '${RUSTPBX_LIVEKIT_TRUNK:-}');
  assert.equal(converactEnvironment.RUSTPBX_RWI_URL, '${RUSTPBX_RWI_URL:-}');
  assert.equal(converactEnvironment.MINIO_ENDPOINT, 'http://minio:9000');
  assert.equal(converactEnvironment.MINIO_BUCKET, '${MINIO_BUCKET:-recordings}');
  assert.equal(converactEnvironment.MINIO_ACCESS_KEY, '${MINIO_ACCESS_KEY:-minioadmin}');
  assert.equal(converactEnvironment.MINIO_SECRET_KEY, '${MINIO_SECRET_KEY:-minioadmin}');
  assert.equal(converactEnvironment.CONVERACT_API_KEY, '${CONVERACT_API_KEY}');
});

test('Compose media services use pinned versions and production bundled media is opt-in', () => {
  const local = readFileSync(COMPOSE_PATH, 'utf8');
  const production = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const productionEnv = readFileSync(PRODUCTION_ENV_PATH, 'utf8');
  const rootEnv = readFileSync(ROOT_ENV_PATH, 'utf8');
  const k8sValues = readFileSync(K8S_VALUES_PATH, 'utf8');

  assert.match(
    readServiceBlock(local, 'livekit'),
    /image: \$\{LIVEKIT_SERVER_IMAGE:-ghcr\.io\/songgoldenwind-crypto\/converact-livekit-server:v1\.13\.4-ivekit\.1-0b3fd288\}/
  );
  assert.match(
    readServiceBlock(production, 'livekit'),
    /image: \$\{LIVEKIT_SERVER_IMAGE:\?LIVEKIT_SERVER_IMAGE immutable Converact Fabric fork reference is required\}/
  );
  for (const compose of [local, production]) {
    const egress = readServiceBlock(compose, 'livekit-egress');
    assert.match(egress, /livekit\/egress:\$\{LIVEKIT_EGRESS_IMAGE_TAG:-v1\.13\.0\}/);
    assert.match(egress, /SYS_ADMIN/);
    assert.match(egress, /http:\/\/127\.0\.0\.1:8091/);
  }
  assert.match(readServiceBlock(local, 'livekit-sip'), /livekit\/sip:\$\{LIVEKIT_SIP_IMAGE_TAG:-v1\.7\.0\}/);
  assert.match(
    readServiceBlock(production, 'livekit-sip'),
    /image: \$\{LIVEKIT_SIP_IMAGE:\?LIVEKIT_SIP_IMAGE immutable reference is required\}/
  );
  assert.match(
    productionEnv,
    /^LIVEKIT_SERVER_IMAGE=ghcr\.io\/songgoldenwind-crypto\/converact-livekit-server@sha256:[a-f0-9]{64}$/m
  );
  assert.match(
    productionEnv,
    /^LIVEKIT_SIP_IMAGE=ghcr\.io\/songgoldenwind-crypto\/converact-livekit-sip@sha256:[a-f0-9]{64}$/m
  );
  assert.match(productionEnv, /^LIVEKIT_SERVER_IMAGE_TAG=v1\.13\.4-ivekit\.1$/m);
  assert.match(rootEnv, /^LIVEKIT_SERVER_IMAGE_TAG=v1\.13\.4-ivekit\.1$/m);
  assert.match(k8sValues, /repository: ghcr\.io\/songgoldenwind-crypto\/converact-livekit-server/);

  for (const service of ['livekit', 'livekit-sip', 'livekit-egress']) {
    assert.match(readServiceBlock(production, service), /profiles: \["media-bundled"\]/);
  }
  assert.equal(readServiceEnvironment(production, 'livekit-sip').LIVEKIT_URL, 'ws://livekit:7880');
  assert.doesNotMatch(readServiceBlock(production, 'converact'), /livekit:\n\s+condition:/);
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
  assert.equal(postgresBootstrapEnvironment.CONVERACT_POSTGRES_BOOTSTRAP_DATABASES, 'keycloak');
  assert.ok(
    readServiceVolumes(compose, 'postgres-bootstrap').includes(
      './scripts/bootstrap-postgres-databases.sh:/bootstrap/bootstrap-postgres-databases.sh:ro'
    )
  );
  assert.match(postgresBootstrap, /postgres:\n\s+condition: service_healthy/);
  assert.match(postgresBootstrap, /restart: "no"/);

  const pgbouncer = readServiceBlock(compose, 'pgbouncer');
  assert.match(
    pgbouncer,
    /image: edoburu\/pgbouncer:v1\.25\.2-p0@sha256:7d7a27d9e90985cab5cf42256f5c13a3120baa4b055b69df37beb272b89b2340/
  );
  assert.doesNotMatch(pgbouncer, /bitnami|:latest/);
  assert.match(pgbouncer, /DB_HOST: postgres/);
  assert.match(pgbouncer, /DB_USER: converact/);
  assert.match(pgbouncer, /DB_PASSWORD: \$\{POSTGRES_PASSWORD\}/);
  assert.match(pgbouncer, /AUTH_TYPE: scram-sha-256/);
  assert.match(pgbouncer, /POOL_MODE: transaction/);
  assert.match(pgbouncer, /LISTEN_PORT: "6432"/);
  assert.match(pgbouncer, /postgres-bootstrap:\n\s+condition: service_completed_successfully/);
  assert.match(pgbouncer, /healthcheck:[\s\S]*psql -X[\s\S]*-p 6432/);
  assert.match(pgbouncer, /-Atqc 'SELECT 1' >\/dev\/null 2>&1/);
  assert.doesNotMatch(pgbouncer, /pg_isready/);
  assert.match(pgbouncer, /PGPASSWORD=\$\$DB_PASSWORD/);
  assert.match(
    readServiceBlock(compose, 'keycloak'),
    /postgres-bootstrap:\n\s+condition: service_completed_successfully/
  );

  const minio = readServiceBlock(compose, 'minio');
  const minioInit = readServiceBlock(compose, 'minio-init');
  const minioInitEnvironment = readServiceEnvironment(compose, 'minio-init');
  assert.ok(minio.includes(`image: ${MINIO_SERVER_IMAGE}`));
  assert.match(minio, /healthcheck:[\s\S]*http:\/\/127\.0\.0\.1:9000\/minio\/health\/live/);
  assert.ok(minioInit.includes(`image: ${MINIO_CLIENT_IMAGE}`));
  assert.equal(minioInitEnvironment.MINIO_ENDPOINT, 'http://minio:9000');
  assert.equal(minioInitEnvironment.MINIO_BUCKET, '${MINIO_BUCKET:-recordings}');
  assert.equal(minioInitEnvironment.MINIO_INIT_MAX_ATTEMPTS, '${MINIO_INIT_MAX_ATTEMPTS:-30}');
  assert.equal(minioInitEnvironment.MINIO_INIT_RETRY_SECONDS, '${MINIO_INIT_RETRY_SECONDS:-2}');
  assert.ok(
    readServiceVolumes(compose, 'minio-init').includes(
      './scripts/bootstrap-minio-bucket.sh:/bootstrap/bootstrap-minio-bucket.sh:ro'
    )
  );
  assert.match(minioInit, /minio:\n\s+condition: service_healthy/);
  assert.match(minioInit, /restart: "no"/);

  for (const serviceName of ['livekit-egress', 'converact']) {
    assert.match(
      readServiceBlock(compose, serviceName),
      /minio-init:\n\s+condition: service_completed_successfully/
    );
  }
  const rustpbx = readServiceBlock(compose, 'rustpbx');
  assert.match(rustpbx, /rustpbx-postgres-bootstrap:\n\s+condition: service_completed_successfully/);
  assert.match(rustpbx, /rustpbx-config-render:\n\s+condition: service_completed_successfully/);
  assert.doesNotMatch(rustpbx, /minio-init:/);
  assert.match(readServiceBlock(compose, 'converact'), /pgbouncer:\n\s+condition: service_healthy/);
});

test('standalone LiveKit storage overlay keeps MinIO private and gates Egress on bucket readiness', () => {
  const edgeCompose = readFileSync(LIVEKIT_EDGE_COMPOSE_PATH, 'utf8');
  const storageCompose = readFileSync(LIVEKIT_STORAGE_COMPOSE_PATH, 'utf8');
  const envExample = readFileSync(LIVEKIT_ENV_PATH, 'utf8');

  const minio = readServiceBlock(storageCompose, 'minio');
  assert.match(minio, /image: minio\/minio:\$\{LIVEKIT_MINIO_IMAGE_TAG:\?LIVEKIT_MINIO_IMAGE_TAG is required\}@\$\{LIVEKIT_MINIO_IMAGE_DIGEST:\?LIVEKIT_MINIO_IMAGE_DIGEST is required\}/);
  assert.match(minio, /"127\.0\.0\.1:9000:9000"/);
  assert.match(minio, /"127\.0\.0\.1:9001:9001"/);
  assert.equal(readServiceEnvironment(storageCompose, 'minio').MINIO_ROOT_USER, '${MINIO_ROOT_ACCESS_KEY:?MINIO_ROOT_ACCESS_KEY is required}');
  assert.equal(readServiceEnvironment(storageCompose, 'minio').MINIO_ROOT_PASSWORD, '${MINIO_ROOT_SECRET_KEY:?MINIO_ROOT_SECRET_KEY is required}');

  const minioInit = readServiceBlock(storageCompose, 'minio-init');
  const minioInitEnvironment = readServiceEnvironment(storageCompose, 'minio-init');
  assert.equal(minioInitEnvironment.MINIO_ROOT_ACCESS_KEY, '${MINIO_ROOT_ACCESS_KEY:?MINIO_ROOT_ACCESS_KEY is required}');
  assert.equal(minioInitEnvironment.MINIO_ACCESS_KEY, '${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}');
  assert.notEqual(minioInitEnvironment.MINIO_ROOT_ACCESS_KEY, minioInitEnvironment.MINIO_ACCESS_KEY);
  assert.match(minioInit, /bootstrap-minio-bucket\.sh/);
  assert.match(minioInit, /image: minio\/mc:\$\{LIVEKIT_MINIO_MC_IMAGE_TAG:\?LIVEKIT_MINIO_MC_IMAGE_TAG is required\}@\$\{LIVEKIT_MINIO_MC_IMAGE_DIGEST:\?LIVEKIT_MINIO_MC_IMAGE_DIGEST is required\}/);
  assert.ok(
    readServiceVolumes(storageCompose, 'minio-init').includes(
      '../scripts/bootstrap-minio-bucket.sh:/bootstrap/bootstrap-minio-bucket.sh:ro'
    )
  );
  assert.match(minioInit, /minio:\n\s+condition: service_healthy/);

  assert.match(
    readServiceBlock(storageCompose, 'egress'),
    /minio-init:\n\s+condition: service_completed_successfully/
  );
  assert.match(edgeCompose, /^  egress:/m);
  assert.match(envExample, /^LIVEKIT_MINIO_IMAGE_TAG=RELEASE\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/m);
  assert.match(envExample, /^LIVEKIT_MINIO_IMAGE_DIGEST=sha256:[a-f0-9]{64}$/m);
  assert.match(envExample, /^LIVEKIT_MINIO_MC_IMAGE_TAG=RELEASE\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/m);
  assert.match(envExample, /^LIVEKIT_MINIO_MC_IMAGE_DIGEST=sha256:[a-f0-9]{64}$/m);
  assert.doesNotMatch(envExample, /^MINIO_(?:ACCESS_KEY|SECRET_KEY)=minioadmin$/m);
});

test('standalone Converact Fabric application stack isolates PostgreSQL, Tinode, Converact, and RustDesk', () => {
  const compose = readFileSync(CONVERACT_APPLICATION_COMPOSE_PATH, 'utf8');
  const envExample = readFileSync(new URL('../infra/converact/env.example', import.meta.url), 'utf8');

  const postgres = readServiceBlock(compose, 'postgres');
  assert.match(postgres, /image: \$\{CONVERACT_POSTGRES_IMAGE:\?CONVERACT_POSTGRES_IMAGE immutable digest reference is required\}/);
  assert.doesNotMatch(postgres, /\n\s+ports:/);
  assert.match(postgres, /postgres_data:\/var\/lib\/postgresql\/data/);
  assert.equal(readServiceEnvironment(compose, 'postgres').POSTGRES_USER, 'opc_admin');
  assert.doesNotMatch(compose, /^  postgres-bootstrap:/m);

  const runtimeRole = readServiceBlock(compose, 'postgres-runtime-role');
  assert.match(runtimeRole, /init-postgres-runtime-role\.sh/);
  assert.match(runtimeRole, /postgres:\n\s+condition: service_healthy/);

  const migrate = readServiceBlock(compose, 'postgres-migrate');
  assert.match(migrate, /run-postgres-migrations\.ts/);
  assert.match(migrate, /postgres-runtime-role:\n\s+condition: service_completed_successfully/);

  const redis = readServiceBlock(compose, 'redis');
  assert.match(redis, /image: \$\{CONVERACT_REDIS_IMAGE:\?CONVERACT_REDIS_IMAGE immutable digest reference is required\}/);
  assert.doesNotMatch(redis, /\n\s+ports:/);

  const tinode = readServiceBlock(compose, 'tinode');
  assert.match(tinode, /image: \$\{TINODE_IMAGE:\?TINODE_IMAGE immutable digest reference is required\}/);
  assert.match(tinode, /"127\.0\.0\.1:\$\{TINODE_HTTP_PORT:-6060\}:6060"/);
  assert.equal(readServiceEnvironment(compose, 'tinode').STORE_USE_ADAPTER, 'postgres');
  assert.equal(readServiceEnvironment(compose, 'tinode').PGPASSWORD, '${TINODE_DB_PASSWORD:?TINODE_DB_PASSWORD is required}');
  assert.doesNotMatch(String(readServiceEnvironment(compose, 'tinode').POSTGRES_DSN), /opc_admin|POSTGRES_PASSWORD/);
  assert.equal(readServiceEnvironment(compose, 'tinode').SAMPLE_DATA, '');
  assert.match(tinode, /postgres:\n\s+condition: service_healthy/);

  const tinodeBootstrap = readServiceBlock(compose, 'tinode-bootstrap');
  assert.match(tinodeBootstrap, /image: \$\{CONVERACT_PLATFORM_IMAGE:-converact-platform:local\}/);
  assert.match(tinodeBootstrap, /bootstrap-tinode-service-account\.ts/);
  assert.match(tinodeBootstrap, /tinode:\n\s+condition: service_healthy/);
  const tinodeBootstrapEnvironment = readServiceEnvironment(compose, 'tinode-bootstrap');
  assert.equal(
    tinodeBootstrapEnvironment.TINODE_POSTGRES_DSN,
    'postgresql://tinode_app@postgres:5432/tinode?sslmode=disable&connect_timeout=10'
  );
  assert.equal(
    tinodeBootstrapEnvironment.PGPASSWORD,
    '${TINODE_DB_PASSWORD:?TINODE_DB_PASSWORD is required}'
  );

  const converact = readServiceBlock(compose, 'converact');
  assert.match(converact, /command: \["npm", "run", "start:converact"\]/);
  assert.match(converact, /"127\.0\.0\.1:\$\{CONVERACT_HTTP_PORT:-8300\}:3000"/);
  assert.match(converact, /postgres:\n\s+condition: service_healthy/);
  assert.match(converact, /tinode-bootstrap:\n\s+condition: service_completed_successfully/);
  const converactEnvironment = readServiceEnvironment(compose, 'converact');
  assert.equal(converactEnvironment.PGUSER, 'opc_runtime');
  assert.equal(converactEnvironment.PGPASSWORD, '${CONVERACT_RUNTIME_DB_PASSWORD:?CONVERACT_RUNTIME_DB_PASSWORD is required}');
  assert.equal('DATABASE_URL' in converactEnvironment, false);
  assert.equal('DATABASE_MIGRATION_URL' in converactEnvironment, false);
  assert.equal('POSTGRES_PASSWORD' in converactEnvironment, false);
  assert.equal(converactEnvironment.LIVEKIT_URL, '${LIVEKIT_URL:?LIVEKIT_URL is required}');
  assert.equal(converactEnvironment.LIVEKIT_PUBLIC_URL, '${LIVEKIT_PUBLIC_URL:?LIVEKIT_PUBLIC_URL is required}');
  assert.equal(converactEnvironment.MINIO_ENDPOINT, 'http://minio:9000');
  assert.equal(converactEnvironment.TINODE_BASE_URL, 'http://tinode:6060');
  assert.equal(converactEnvironment.TINODE_WS_URL, 'ws://tinode:6060/v0/channels');
  assert.equal(converactEnvironment.TINODE_PUBLIC_WS_URL, '${TINODE_PUBLIC_WS_URL:?TINODE_PUBLIC_WS_URL is required}');
  assert.equal('CONVERACT_DISABLE_DIALER' in converactEnvironment, false);
  assert.equal(converactEnvironment.CONVERACT_SCHEMA_MANAGED_BY_MIGRATIONS, '1');
  assert.equal(converactEnvironment.CONVERACT_REMOTE_GATEWAY_BASE_URL, 'http://converact-api:3000');
  assert.equal(converactEnvironment.CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL, 'http://converact-api:3000');
  assert.equal(
    converactEnvironment.CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE,
    '${CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE:-rustdesk://connect/{rustdesk_id}?session={external_id}}'
  );
  assert.match(converact, /aliases:\n\s+- converact-api/);
  assert.match(converact, /converact_media: \{\}/);

  for (const service of ['rustdesk-hbbs', 'rustdesk-hbbr']) {
    const block = readServiceBlock(compose, service);
    assert.match(block, /image: \$\{RUSTDESK_SERVER_IMAGE:\?RUSTDESK_SERVER_IMAGE immutable digest reference is required\}/);
    assert.match(block, /network_mode: "host"/);
    assert.doesNotMatch(block, /:latest/);
  }

  for (const variable of [
    'CONVERACT_POSTGRES_IMAGE=postgres:16.10-alpine3.22',
    'CONVERACT_REDIS_IMAGE=redis:7.4.9',
    'TINODE_IMAGE=tinode/tinode:0.25.3',
    'RUSTDESK_SERVER_IMAGE=ghcr.io/songgoldenwind-crypto/converact-rustdesk-server:1.1.16-ivekit.1-73523b31'
  ]) {
    assert.match(envExample, new RegExp(`^${variable.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`, 'm'));
  }
  assert.doesNotMatch(envExample, /^(?:CONVERACT_FABRIC|CONVERACT)_(?:POSTGRES|REDIS)_IMAGE_TAG=/m);

  assert.match(compose, /name: \$\{CONVERACT_MEDIA_DOCKER_NETWORK:-converact-media_default\}/);
  assert.doesNotMatch(compose, /CONVERACT_DB_PATH|sqlite/i);

  const roleInit = readFileSync(CONVERACT_POSTGRES_ROLE_INIT_PATH, 'utf8');
  assert.match(roleInit, /CREATE ROLE opc_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
  assert.match(roleInit, /CREATE ROLE tinode_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
  assert.match(roleInit, /CREATE DATABASE tinode OWNER tinode_app/);
  assert.match(roleInit, /ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin/);
  assert.match(roleInit, /schema_migrations/);
  assert.match(readFileSync(new URL('../scripts/run-postgres-migrations.ts', import.meta.url), 'utf8'), /REVOKE ALL PRIVILEGES ON TABLE schema_migrations FROM opc_runtime/);
  assert.doesNotMatch(roleInit, /echo.*PASSWORD|set -x/i);
});

test('self-hosted Tinode extends database bootstrap and waits for it', () => {
  const overlay = readFileSync(PRODUCTION_TINODE_COMPOSE_PATH, 'utf8');

  assert.equal(
    readServiceEnvironment(overlay, 'postgres-bootstrap').CONVERACT_POSTGRES_BOOTSTRAP_DATABASES,
    'keycloak,tinode'
  );
  assert.match(
    readServiceBlock(overlay, 'tinode'),
    /postgres-bootstrap:\n\s+condition: service_completed_successfully/
  );
  assert.match(readServiceBlock(overlay, 'converact'), /tinode:\n\s+condition: service_started/);
});

test('Chatwoot is opt-in and production bootstrap remains PostgreSQL-only', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const envExample = readFileSync(PRODUCTION_ENV_PATH, 'utf8');

  assert.match(readServiceBlock(compose, 'chatwoot'), /profiles: \["omnichannel"\]/);
  assert.doesNotMatch(compose, /sqlite|CONVERACT_DB_PATH/i);
  assert.match(envExample, /^MINIO_INIT_MAX_ATTEMPTS=30$/m);
  assert.match(envExample, /^MINIO_INIT_RETRY_SECONDS=2$/m);
});

test('production application image has no SQLite runtime fallback', () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');

  assert.doesNotMatch(dockerfile, /CONVERACT_DB_PATH|converact\.sqlite|sqlite/i);
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

test('compose files deploy Tinode with PostgreSQL and wire internal Converact endpoints', () => {
  const localCompose = readFileSync(COMPOSE_PATH, 'utf8');
  const productionBaseCompose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');
  const productionTinodeCompose = readFileSync(PRODUCTION_TINODE_COMPOSE_PATH, 'utf8');

  for (const compose of [localCompose, productionTinodeCompose]) {
    const tinode = readServiceBlock(compose, 'tinode');
    const tinodeEnvironment = readServiceEnvironment(compose, 'tinode');
    const converactEnvironment = readServiceEnvironment(compose, 'converact');

    assert.match(tinode, /image: tinode\/tinode:\$\{TINODE_IMAGE_TAG:-0\.25\.3\}/);
    assert.match(tinode, /"6060:6060"/);
    assert.ok(readServiceVolumes(compose, 'tinode').includes('tinode_botdata:/botdata'));
    assert.equal(tinodeEnvironment.STORE_USE_ADAPTER, 'postgres');
    assert.equal(tinodeEnvironment.WAIT_FOR, 'postgres:5432');
    assert.match(tinodeEnvironment.AUTH_TOKEN_KEY, /\$\{TINODE_AUTH_TOKEN_KEY/);
    assert.match(tinodeEnvironment.UID_ENCRYPTION_KEY, /\$\{TINODE_UID_ENCRYPTION_KEY/);
    assert.equal(tinodeEnvironment.SAMPLE_DATA, '${TINODE_SAMPLE_DATA:-}');
    assert.equal(tinodeEnvironment.UPGRADE_DB, '${TINODE_UPGRADE_DB:-false}');
    assert.equal(converactEnvironment.TINODE_BASE_URL, '${TINODE_BASE_URL:-http://tinode:6060}');
    assert.equal(converactEnvironment.TINODE_WS_URL, '${TINODE_WS_URL:-ws://tinode:6060/v0/channels}');
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
  const baseConveractEnvironment = readServiceEnvironment(productionBaseCompose, 'converact');
  assert.equal(baseConveractEnvironment.TINODE_BASE_URL, '${TINODE_BASE_URL:-}');
  assert.equal(baseConveractEnvironment.TINODE_WS_URL, '${TINODE_WS_URL:-}');
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

test('compose files define RustDesk OSS runtime and wire Converact control-plane env', () => {
  const localCompose = readFileSync(COMPOSE_PATH, 'utf8');
  const productionCompose = readFileSync(PRODUCTION_COMPOSE_PATH, 'utf8');

  const localHbbs = readServiceBlock(localCompose, 'rustdesk-hbbs');
  const localHbbr = readServiceBlock(localCompose, 'rustdesk-hbbr');
  assert.match(localHbbs, /image: rustdesk\/rustdesk-server:\$\{RUSTDESK_SERVER_IMAGE_TAG:-1\.1\.16\}/);
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
  assert.match(productionHbbs, /image: \$\{RUSTDESK_SERVER_IMAGE:\?RUSTDESK_SERVER_IMAGE immutable digest reference is required\}/);
  assert.match(productionHbbs, /network_mode: "host"/);
  assert.match(productionHbbs, /command: hbbs/);
  assert.match(productionHbbs, /ALWAYS_USE_RELAY: \$\{RUSTDESK_ALWAYS_USE_RELAY:-N\}/);
  assert.ok(readServiceVolumes(productionCompose, 'rustdesk-hbbs').includes('rustdesk_data:/data'));
  assert.doesNotMatch(productionHbbs, /rustdesk\/rustdesk-server:/);
  assert.match(productionHbbr, /network_mode: "host"/);
  assert.match(productionHbbr, /command: hbbr/);
  assert.ok(readServiceVolumes(productionCompose, 'rustdesk-hbbr').includes('rustdesk_data:/data'));

  for (const compose of [localCompose, productionCompose]) {
    const converactEnvironment = readServiceEnvironment(compose, 'converact');
    assert.equal(converactEnvironment.CONVERACT_REMOTE_GATEWAY_PROVIDER, '${CONVERACT_REMOTE_GATEWAY_PROVIDER:-rustdesk}');
    assert.equal(converactEnvironment.CONVERACT_REMOTE_GATEWAY_TENANT_ID, '${CONVERACT_REMOTE_GATEWAY_TENANT_ID:-tenant_led}');
    assert.equal(converactEnvironment.CONVERACT_REMOTE_GATEWAY_TARGET_TYPE, '${CONVERACT_REMOTE_GATEWAY_TARGET_TYPE:-device}');
    assert.match(converactEnvironment.CONVERACT_REMOTE_GATEWAY_TARGET_ID, /\$\{CONVERACT_REMOTE_GATEWAY_TARGET_ID/);
    assert.match(converactEnvironment.CONVERACT_REMOTE_GATEWAY_TARGET_DISPLAY_NAME, /\$\{CONVERACT_REMOTE_GATEWAY_TARGET_DISPLAY_NAME/);
    assert.match(converactEnvironment.CONVERACT_REMOTE_GATEWAY_ACTOR_IDENTITY, /\$\{CONVERACT_REMOTE_GATEWAY_ACTOR_IDENTITY/);
    assert.equal(converactEnvironment.CONVERACT_REMOTE_GATEWAY_CONSENT_SCOPES, '${CONVERACT_REMOTE_GATEWAY_CONSENT_SCOPES:-view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard}');
    assert.match(converactEnvironment.CONVERACT_REMOTE_GATEWAY_CHECK_LAUNCH_URL, /\$\{CONVERACT_REMOTE_GATEWAY_CHECK_LAUNCH_URL/);
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL, '${CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL:-http://converact:3000}');
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_ID_SERVER, /\$\{CONVERACT_RUSTDESK_ID_SERVER/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_RELAY_SERVER, /\$\{CONVERACT_RUSTDESK_RELAY_SERVER/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_API_SERVER, /\$\{CONVERACT_RUSTDESK_API_SERVER/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_PUBLIC_KEY, /\$\{CONVERACT_RUSTDESK_PUBLIC_KEY/);
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_PUBLIC_KEY_FILE, '${CONVERACT_RUSTDESK_PUBLIC_KEY_FILE:-/rustdesk/id_ed25519.pub}');
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_LAUNCH_BASE_URL, /\$\{CONVERACT_RUSTDESK_LAUNCH_BASE_URL/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_LAUNCH_SECRET, /\$\{CONVERACT_RUSTDESK_LAUNCH_SECRET/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_LAUNCH_TOKEN_TTL_MS, /\$\{CONVERACT_RUSTDESK_LAUNCH_TOKEN_TTL_MS/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_REQUIRE_DEVICE_ONLINE, /\$\{CONVERACT_RUSTDESK_REQUIRE_DEVICE_ONLINE/);
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT, '${CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT:-0}');
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS, /\$\{CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE, /\$\{CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_CHECK_OPERATION_AUDIT, /\$\{CONVERACT_RUSTDESK_CHECK_OPERATION_AUDIT/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_CHECK_SERVER_PORTS, /\$\{CONVERACT_RUSTDESK_CHECK_SERVER_PORTS/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_CHECK_HOST, /\$\{CONVERACT_RUSTDESK_CHECK_HOST/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_CHECK_TCP_PORTS, /\$\{CONVERACT_RUSTDESK_CHECK_TCP_PORTS/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_CHECK_UDP_PORTS, /\$\{CONVERACT_RUSTDESK_CHECK_UDP_PORTS/);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS, /\$\{CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS/);
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE, '${CONVERACT_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE:-1}');
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT, '${CONVERACT_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT:-1}');
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS, '${CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS:-1}');
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL, '${CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL:-1}');
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_READINESS_CHECK_LAUNCH_URL, '${CONVERACT_RUSTDESK_READINESS_CHECK_LAUNCH_URL:-1}');
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL, '${CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL:-1}');
    assert.equal(converactEnvironment.CONVERACT_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT, '${CONVERACT_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT:-0}');
    assert.equal('CONVERACT_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE' in converactEnvironment, false);
    assert.match(converactEnvironment.CONVERACT_RUSTDESK_API_TOKEN, /\$\{CONVERACT_RUSTDESK_API_TOKEN/);
    assert.ok(readServiceVolumes(compose, 'converact').includes('rustdesk_data:/rustdesk:ro'));
  }
});

test('production env example declares required Media Core secrets', () => {
  const envExample = readFileSync(PRODUCTION_ENV_PATH, 'utf8');
  const gitignore = readFileSync(GITIGNORE_PATH, 'utf8');

  assert.match(envExample, /^CONVERACT_MEDIA_API_TOKEN=/m);
  assert.match(envExample, /^CONVERACT_MEDIA_INVITE_SECRET=/m);
  assert.match(envExample, /^CONVERACT_MEDIA_INVITE_TTL_MS=/m);
  assert.match(envExample, /^CONVERACT_MEDIA_RECORDING_RETENTION_DAYS=90$/m);
  assert.match(envExample, /^CONVERACT_RECORDING_HTTP_ALLOWED_ORIGINS=/m);
  assert.doesNotMatch(envExample, /^CONVERACT_DB_PATH=/m);
  assert.match(envExample, /^MINIO_BUCKET=/m);
  assert.match(envExample, /^MINIO_ACCESS_KEY=/m);
  assert.match(envExample, /^MINIO_SECRET_KEY=/m);
  assert.match(envExample, /^CONVERACT_MEDIA_CONFIG_DIR=/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_PROVIDER=rustdesk/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_BASE_URL=http:\/\/converact:3000/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_API_TOKEN=change_me_rustdesk_control_token/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_TENANT_ID=tenant_led/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_TARGET_TYPE=device/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_TARGET_ID=/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_CHECK_LAUNCH_URL=0/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_TARGET_DISPLAY_NAME=Remote gateway smoke device/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_ACTOR_IDENTITY=agent_remote_gateway_smoke/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_CONSENT_SCOPES=view_screen,control_mouse_keyboard,record_screen,transfer_file,clipboard/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_CREATE_PATH=/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_SESSION_PATH=/m);
  assert.match(envExample, /^CONVERACT_REMOTE_GATEWAY_AUDIT_PATH=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_ID_SERVER=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_RELAY_SERVER=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_API_SERVER=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_PUBLIC_KEY=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_PUBLIC_KEY_FILE=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_SERVER_KEY=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_LAUNCH_BASE_URL=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_LAUNCH_SECRET=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_LAUNCH_TOKEN_TTL_MS=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_REQUIRE_PROTOCOL_URL=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_REQUIRE_DEVICE_ONLINE=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT=0/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET=$/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_API_TOKEN=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_CHECK_SERVER_PORTS=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_CHECK_HOST=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_CHECK_TCP_PORTS=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_CHECK_UDP_PORTS=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS=/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE=1/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT=1/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS=1/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL=1/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_CHECK_LAUNCH_URL=1/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL=1/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT=0/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_INSTANCE_ID=$/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_COMMAND_TOKEN=$/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS=2000/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_COMMAND_LEASE_MS=40000/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS=15000/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE=$/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON=\[\]$/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_RESTART_EXECUTABLE=$/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_RESTART_ARGS_JSON=\[\]$/m);
  assert.match(envExample, /^RUSTDESK_ALWAYS_USE_RELAY=N/m);
  assert.match(gitignore, /^\.runtime\//m);
});

test('root env example documents every video readiness input', () => {
  const envExample = readFileSync(ROOT_ENV_PATH, 'utf8');

  for (const envName of [
    'CONVERACT_BASE_URL',
    'CONVERACT_FRONTEND_URL',
    'CONVERACT_MEDIA_API_TOKEN',
    'CONVERACT_MEDIA_INVITE_SECRET',
    'CONVERACT_MEDIA_INVITE_TTL_MS',
    'CONVERACT_MEDIA_SMOKE_TENANT_ID',
    'CONVERACT_MEDIA_SMOKE_ROOM_NAME',
    'CONVERACT_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT',
    'CONVERACT_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT',
    'CONVERACT_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS',
    'CONVERACT_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS',
    'CONVERACT_MEDIA_SMOKE_KEEP_ROOM_OPEN',
    'CONVERACT_MEDIA_RECORDING_RETENTION_DAYS',
    'CONVERACT_RECORDING_HTTP_ALLOWED_ORIGINS',
    'CONVERACT_VIDEO_READINESS_TARGETS',
    'CONVERACT_VIDEO_READINESS_CONTINUE_ON_FAILURE',
    'CONVERACT_VIDEO_READINESS_REPORT_FILE',
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'CONVERACT_API_KEY',
    'CONVERACT_AVATAR_SMOKE_ROOM_NAME',
    'CONVERACT_AVATAR_SMOKE_IDENTITY',
    'CONVERACT_AVATAR_SMOKE_SAMPLE_CHUNKS',
    'CONVERACT_AVATAR_SMOKE_SETTLE_SECONDS',
    'CONVERACT_AI_CALLBACK_SMOKE_TENANT_ID',
    'CONVERACT_AI_CALLBACK_SMOKE_ROOM_NAME',
    'CONVERACT_BROWSER_SMOKE_TENANT_ID',
    'CONVERACT_BROWSER_SMOKE_AGENT_A_TOKEN',
    'CONVERACT_BROWSER_SMOKE_AGENT_A_USER_ID',
    'CONVERACT_BROWSER_SMOKE_AGENT_A_SEAT_ID',
    'CONVERACT_BROWSER_SMOKE_AGENT_B_TOKEN',
    'CONVERACT_BROWSER_SMOKE_AGENT_B_USER_ID',
    'CONVERACT_BROWSER_SMOKE_AGENT_B_SEAT_ID',
    'CONVERACT_BROWSER_SMOKE_HEADLESS',
    'CONVERACT_BROWSER_SMOKE_SCREEN_SHARE',
    'CONVERACT_BROWSER_SMOKE_TIMEOUT_MS',
    'CONVERACT_CUSTOMER_VIDEO_URL',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_URL',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_ROOM_NAME',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_TENANT_ID',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_INVITE',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_EXPIRES_AT',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_HEADLESS',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_TIMEOUT_MS',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_EXPECT_REMOTE',
    'CONVERACT_CUSTOMER_BROWSER_SMOKE_EXPECT_SCREEN_SHARE',
    'CONVERACT_WEB_ASSIST_CUSTOMER_URL',
    'CONVERACT_REMOTE_ASSIST_CUSTOMER_URL',
    'CONVERACT_WEB_ASSIST_REMOTE_SESSION_ID',
    'CONVERACT_WEB_ASSIST_TENANT_ID',
    'CONVERACT_WEB_ASSIST_ENGINEER_TOKEN',
    'CONVERACT_WEB_ASSIST_ENGINEER_USER_ID',
    'CONVERACT_WEB_ASSIST_ENGINEER_EMAIL',
    'CONVERACT_WEB_ASSIST_BROWSER_SMOKE_HEADLESS',
    'CONVERACT_WEB_ASSIST_BROWSER_SMOKE_TIMEOUT_MS',
    'CONVERACT_COLLAB_SMOKE_TENANT_ID',
    'CONVERACT_COLLAB_SMOKE_USER_ID',
    'CONVERACT_COLLAB_SMOKE_BUSINESS_REF_TYPE',
    'CONVERACT_COLLAB_SMOKE_BUSINESS_REF_ID',
    'CONVERACT_COLLAB_SMOKE_BUSINESS_REF_DISPLAY_NAME',
    'CONVERACT_COLLAB_SMOKE_REMOTE_MODE',
    'CONVERACT_COLLAB_SMOKE_ADAPTER_PROVIDER',
    'CONVERACT_COLLAB_SMOKE_TOOL_PROVIDER',
    'CONVERACT_COLLAB_SMOKE_TOOL_EXTERNAL_ID',
    'CONVERACT_COLLAB_SMOKE_TOOL_LAUNCH_URL',
    'CONVERACT_COLLAB_SMOKE_USE_GATEWAY_TOOL',
    'CONVERACT_COLLAB_SMOKE_GATEWAY_TARGET_TYPE',
    'CONVERACT_COLLAB_SMOKE_GATEWAY_TARGET_ID',
    'CONVERACT_COLLAB_SMOKE_GATEWAY_TARGET_DISPLAY_NAME',
    'CONVERACT_COLLAB_SMOKE_CONSENT_SCOPES',
    'CONVERACT_COLLAB_SMOKE_EVIDENCE_FILENAME',
    'CONVERACT_COLLAB_SMOKE_RETENTION_UNTIL',
    'CONVERACT_REMOTE_GATEWAY_PROVIDER',
    'CONVERACT_REMOTE_GATEWAY_BASE_URL',
    'CONVERACT_REMOTE_GATEWAY_API_TOKEN',
    'CONVERACT_REMOTE_GATEWAY_TARGET_TYPE',
    'CONVERACT_REMOTE_GATEWAY_TARGET_ID',
    'CONVERACT_REMOTE_GATEWAY_CHECK_LAUNCH_URL',
    'CONVERACT_REMOTE_GATEWAY_TARGET_DISPLAY_NAME',
    'CONVERACT_REMOTE_GATEWAY_ACTOR_IDENTITY',
    'CONVERACT_REMOTE_GATEWAY_CONSENT_SCOPES',
    'CONVERACT_REMOTE_GATEWAY_CREATE_PATH',
    'CONVERACT_REMOTE_GATEWAY_SESSION_PATH',
    'CONVERACT_REMOTE_GATEWAY_AUDIT_PATH',
    'CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL',
    'CONVERACT_RUSTDESK_ID_SERVER',
    'CONVERACT_RUSTDESK_RELAY_SERVER',
    'CONVERACT_RUSTDESK_API_SERVER',
    'CONVERACT_RUSTDESK_PUBLIC_KEY',
    'CONVERACT_RUSTDESK_PUBLIC_KEY_FILE',
    'CONVERACT_RUSTDESK_SERVER_KEY',
    'CONVERACT_RUSTDESK_LAUNCH_BASE_URL',
    'CONVERACT_RUSTDESK_LAUNCH_SECRET',
    'CONVERACT_RUSTDESK_LAUNCH_TOKEN_TTL_MS',
    'CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE',
    'CONVERACT_RUSTDESK_REQUIRE_PROTOCOL_URL',
    'CONVERACT_RUSTDESK_REQUIRE_DEVICE_ONLINE',
    'CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT',
    'CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET',
    'CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS',
    'CONVERACT_RUSTDESK_API_TOKEN',
    'CONVERACT_RUSTDESK_CHECK_SERVER_PORTS',
    'CONVERACT_RUSTDESK_CHECK_HOST',
    'CONVERACT_RUSTDESK_CHECK_TCP_PORTS',
    'CONVERACT_RUSTDESK_CHECK_UDP_PORTS',
    'CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS',
    'CONVERACT_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE',
    'CONVERACT_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT',
    'CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS',
    'CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL',
    'CONVERACT_RUSTDESK_READINESS_CHECK_LAUNCH_URL',
    'CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL',
    'CONVERACT_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT',
    'CONVERACT_RUSTDESK_EDGE_INSTANCE_ID',
    'CONVERACT_RUSTDESK_EDGE_COMMAND_TOKEN',
    'CONVERACT_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS',
    'CONVERACT_RUSTDESK_EDGE_COMMAND_LEASE_MS',
    'CONVERACT_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS',
    'CONVERACT_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE',
    'CONVERACT_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON',
    'CONVERACT_RUSTDESK_EDGE_RESTART_EXECUTABLE',
    'CONVERACT_RUSTDESK_EDGE_RESTART_ARGS_JSON',
    'LIVEKIT_SIP_BRIDGE_TARGET',
    'RUSTPBX_LIVEKIT_TRUNK',
    'RUSTPBX_RWI_URL',
    'RUSTPBX_RWI_TOKEN',
    'CONVERACT_SIP_VOLTE_ENABLED',
    'CONVERACT_SIP_VOLTE_REQUIRE_ACTIVE',
    'CONVERACT_SIP_VOLTE_GATEWAY_STATUS_URL',
    'CONVERACT_SIP_VOLTE_GATEWAY_STATUS_TOKEN',
    'MINIO_BUCKET',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY'
  ]) {
    assert.match(envExample, new RegExp(`^${envName}=`, 'm'), `${envName} missing from .env.example`);
  }
});

test('Kubernetes templates pass reusable video env into converact and ai agent', () => {
  const converactDeployment = readFileSync(K8S_CONVERACT_DEPLOYMENT_PATH, 'utf8');
  const aiAgentDeployment = readFileSync(K8S_AI_AGENT_DEPLOYMENT_PATH, 'utf8');
  const secrets = readFileSync(K8S_SECRETS_PATH, 'utf8');
  const values = readFileSync(K8S_VALUES_PATH, 'utf8');
  const helpers = readFileSync(K8S_HELPERS_PATH, 'utf8');

  for (const envName of [
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'CONVERACT_MEDIA_API_TOKEN',
    'CONVERACT_MEDIA_INVITE_SECRET',
    'CONVERACT_MEDIA_INVITE_TTL_MS',
    'CONVERACT_MEDIA_RECORDING_RETENTION_DAYS',
    'CONVERACT_SIP_VOLTE_ENABLED',
    'LIVEKIT_SIP_BRIDGE_TARGET',
    'RUSTPBX_LIVEKIT_TRUNK',
    'RUSTPBX_RWI_URL',
    'CONVERACT_RECORDING_HTTP_ALLOWED_ORIGINS',
    'CONVERACT_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT',
    'CONVERACT_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS',
    'CONVERACT_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS',
    'CONVERACT_API_KEY',
    'CONVERACT_REMOTE_GATEWAY_PROVIDER',
    'CONVERACT_REMOTE_GATEWAY_TENANT_ID',
    'CONVERACT_REMOTE_GATEWAY_TARGET_TYPE',
    'CONVERACT_REMOTE_GATEWAY_TARGET_ID',
    'CONVERACT_REMOTE_GATEWAY_TARGET_DISPLAY_NAME',
    'CONVERACT_REMOTE_GATEWAY_ACTOR_IDENTITY',
    'CONVERACT_REMOTE_GATEWAY_CONSENT_SCOPES',
    'CONVERACT_REMOTE_GATEWAY_CHECK_LAUNCH_URL',
    'CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL',
    'CONVERACT_RUSTDESK_ID_SERVER',
    'CONVERACT_RUSTDESK_RELAY_SERVER',
    'CONVERACT_RUSTDESK_API_SERVER',
    'CONVERACT_RUSTDESK_PUBLIC_KEY',
    'CONVERACT_RUSTDESK_PUBLIC_KEY_FILE',
    'CONVERACT_RUSTDESK_LAUNCH_BASE_URL',
    'CONVERACT_RUSTDESK_LAUNCH_SECRET',
    'CONVERACT_RUSTDESK_LAUNCH_TOKEN_TTL_MS',
    'CONVERACT_RUSTDESK_PROTOCOL_URL_TEMPLATE',
    'CONVERACT_RUSTDESK_REQUIRE_PROTOCOL_URL',
    'CONVERACT_RUSTDESK_REQUIRE_DEVICE_ONLINE',
    'CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT',
    'CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET',
    'CONVERACT_RUSTDESK_DEVICE_ONLINE_TTL_MS',
    'CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE',
    'CONVERACT_RUSTDESK_CHECK_OPERATION_AUDIT',
    'CONVERACT_RUSTDESK_CHECK_SERVER_PORTS',
    'CONVERACT_RUSTDESK_CHECK_HOST',
    'CONVERACT_RUSTDESK_CHECK_TCP_PORTS',
    'CONVERACT_RUSTDESK_CHECK_UDP_PORTS',
    'CONVERACT_RUSTDESK_CHECK_TIMEOUT_MS',
    'CONVERACT_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE',
    'CONVERACT_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT',
    'CONVERACT_RUSTDESK_READINESS_CHECK_SERVER_PORTS',
    'CONVERACT_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL',
    'CONVERACT_RUSTDESK_READINESS_CHECK_LAUNCH_URL',
    'CONVERACT_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL',
    'CONVERACT_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT',
    'CONVERACT_RUSTDESK_API_TOKEN'
  ]) {
    assert.match(converactDeployment, new RegExp(`name: ${envName}`));
  }

  assert.match(aiAgentDeployment, /name: CONVERACT_API_KEY/);
  assert.match(converactDeployment, /include "converact\.livekitInternalUrl"/);
  assert.match(converactDeployment, /include "converact\.livekitPublicUrl"/);
  assert.match(converactDeployment, /include "converact\.objectStorageEnv"/);
  for (const envName of [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'S3_FORCE_PATH_STYLE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY'
  ]) {
    assert.match(helpers, new RegExp(`name: ${envName}`));
  }
  assert.match(aiAgentDeployment, /include "converact\.livekitInternalUrl"/);
  assert.match(converactDeployment, /mountPath: \/rustdesk/);
  assert.match(converactDeployment, /claimName: {{ \.Release\.Name }}-rustdesk-data/);
  assert.match(values, /^  launchTokenTtlMs: "900000"/m);
  assert.match(values, /^  edgeTokenSecret: ""/m);
  assert.match(values, /^  readinessRequireHttpsLaunchUrl: "1"/m);
  assert.match(values, /^  requirePhysicalDisconnect: "0"/m);
  assert.match(values, /^  readinessCheckPhysicalDisconnect: "0"/m);
  assert.doesNotMatch(converactDeployment, /name: CONVERACT_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE/);

  for (const secretKey of [
    'livekit-api-key',
    'livekit-api-secret',
    'media-api-token',
    'media-invite-secret',
    'converact-api-key',
    'rustdesk-api-token',
    'rustdesk-edge-token-secret',
    'rustdesk-public-key',
    'rustdesk-server-key'
  ]) {
    assert.match(secrets, new RegExp(`${secretKey}:`));
  }
  assert.doesNotMatch(secrets, /converact-postgres/);
  assert.match(secrets, /\.Release\.Name/);

  assert.match(values, /^media:/m);
  assert.match(values, /^    gatewayEnabled: false$/m);
  assert.match(values, /^    bridgeTarget: ""$/m);
  assert.match(values, /^    rustpbxTrunk: ""$/m);
  assert.match(values, /^    rustpbxRwiUrl: ""$/m);
  for (const valueKey of ['apiToken:', 'inviteSecret:', 'inviteTtlMs:', 'objectStorage:']) {
    assert.match(values, new RegExp(`^  ${valueKey}`, 'm'));
  }
  assert.match(values, /^    mode: external$/m);
  assert.match(values, /^    authMode: secret$/m);
  assert.match(values, /^    existingSecret: converact-object-storage-runtime$/m);
});

test('Kubernetes chart defines the in-cluster media runtime dependencies', () => {
  const livekit = readFileSync(K8S_LIVEKIT_DEPLOYMENT_PATH, 'utf8');
  const minio = readFileSync(K8S_MINIO_DEPLOYMENT_PATH, 'utf8');
  const egress = readFileSync(K8S_EGRESS_DEPLOYMENT_PATH, 'utf8');
  const sip = readFileSync(K8S_SIP_DEPLOYMENT_PATH, 'utf8');
  const values = readFileSync(K8S_VALUES_PATH, 'utf8');
  const helpers = readFileSync(K8S_HELPERS_PATH, 'utf8');
  const converact = readFileSync(K8S_CONVERACT_DEPLOYMENT_PATH, 'utf8');
  const aiAgent = readFileSync(K8S_AI_AGENT_DEPLOYMENT_PATH, 'utf8');

  assert.match(livekit, /bundled-dev is development-only/);
  assert.match(livekit, /name: {{ \.Release\.Name }}-livekit-config/);
  assert.match(livekit, /kind: Deployment/);
  assert.match(livekit, /name: {{ \.Release\.Name }}-livekit/);
  assert.match(livekit, /include "converact\.livekitImage"/);
  assert.match(livekit, /containerPort: 7880/);
  assert.match(livekit, /kind: Service/);
  assert.match(livekit, /port: 7880/);

  assert.match(minio, /kind: Deployment/);
  assert.match(minio, /name: {{ \.Release\.Name }}-minio/);
  assert.match(minio, /\.Values\.media\.minio\.image\.repository/);
  assert.match(minio, /\.Values\.media\.minio\.image\.tag/);
  assert.match(minio, /required "media\.minio\.image\.digest is required" \.Values\.media\.minio\.image\.digest/);
  assert.match(minio, /regexMatch "\^sha256:\[a-f0-9\]\{64\}\$" \$minioImageDigest/);
  assert.match(minio, /fail "media\.minio\.image\.digest must be an immutable sha256 digest"/);
  assert.match(minio, /MINIO_ROOT_USER/);
  assert.match(minio, /MINIO_ROOT_PASSWORD/);
  assert.match(minio, /startupProbe:[\s\S]*\/minio\/health\/live/);
  assert.match(minio, /readinessProbe:[\s\S]*\/minio\/health\/ready/);
  assert.match(minio, /livenessProbe:[\s\S]*\/minio\/health\/live/);
  assert.match(minio, /kind: Service/);
  assert.match(minio, /\.Values\.media\.minio\.service\.port/);
  assert.match(minio, /targetPort: 9000/);

  assert.match(egress, /range \$poolName, \$pool := \.Values\.media\.egress\.pools/);
  assert.match(egress, /^{{- if \.Values\.media\.egress\.enabled }}/);
  assert.doesNotMatch(egress, /\.Values\.livekit\.enabled \.Values\.media\.egress\.enabled/);
  assert.match(egress, /kind: StatefulSet/);
  assert.match(egress, /livekit-egress-{{ \$poolName }}/);
  assert.match(egress, /\.Values\.media\.egress\.image\.repository/);
  assert.match(egress, /EGRESS_CONFIG_FILE/);
  assert.match(egress, /include "converact\.livekitInternalUrl"/);
  assert.match(egress, /include "converact\.livekitRedisConfig"/);
  assert.match(egress, /insecure: {{ hasPrefix "ws:\/\/" \$livekitInternalUrl }}/);
  assert.doesNotMatch(egress, /^\s+insecure: true$/m);
  assert.match(egress, /logging:\n\s+level: info/);
  assert.match(egress, /redis:\n\s+\{\{- include "converact\.livekitRedisConfig"/);
  assert.match(helpers, /define "converact\.livekitRedisConfig"/);
  assert.match(helpers, /address:/);
  assert.match(helpers, /username:/);
  assert.match(helpers, /password:/);
  assert.match(helpers, /db:/);
  assert.match(helpers, /tls:/);
  assert.match(egress, /health_port:/);
  assert.match(egress, /prometheus_port:/);
  assert.match(egress, /backup_storage:/);
  assert.match(egress, /cpu_cost:/);
  assert.match(egress, /room_composite_cpu_cost:/);
  assert.match(egress, /track_cpu_cost:/);
  assert.match(egress, /storage:\n\s+s3:/);
  assert.doesNotMatch(egress, /^\s{4}s3:/m);
  assert.match(egress, /SYS_ADMIN/);
  assert.match(egress, /readinessProbe:/);
  assert.match(egress, /livenessProbe:/);
  assert.match(egress, /terminationGracePeriodSeconds:/);
  assert.match(egress, /topologySpreadConstraints:/);
  assert.match(egress, /podAntiAffinity:/);
  assert.match(egress, /volumeClaimTemplates:/);
  assert.match(egress, /kind: PodDisruptionBudget/);
  assert.match(egress, /kind: ScaledObject/);
  assert.match(egress, /kind: HorizontalPodAutoscaler/);
  assert.match(egress, /kind: PrometheusRule/);
  assert.match(egress, /include "converact\.objectStorageEnv"/);

  assert.match(sip, /kind: Deployment/);
  assert.match(sip, /name: {{ \.Release\.Name }}-livekit-sip/);
  assert.match(sip, /include "converact\.livekitSipImage"/);
  assert.match(sip, /include "converact\.livekitInternalUrl"/);
  assert.match(sip, /sip_port: {{ \.Values\.media\.sip\.service\.port \| default 5061 }}/);
  assert.match(sip, /containerPort: 5061/);
  assert.match(sip, /kind: Service/);

  assert.match(values, /repository: ghcr\.io\/songgoldenwind-crypto\/converact-livekit-server/);
  assert.match(values, /repository: minio\/minio/);
  const minioValuesStart = values.indexOf('  minio:\n', values.indexOf('media:\n'));
  const minioValues = values.slice(minioValuesStart, values.indexOf('  egress:\n', minioValuesStart));
  assert.match(minioValues, /tag: RELEASE\.2025-09-07T16-13-09Z/);
  assert.match(minioValues, /digest: sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e/);
  assert.doesNotMatch(minioValues, /tag: latest/);
  assert.match(values, /repository: ghcr\.io\/songgoldenwind-crypto\/converact-livekit-egress/);
  assert.match(values, /repository: ghcr\.io\/songgoldenwind-crypto\/converact-livekit-sip/);
  assert.match(values, /^  enabled: false$/m);
  assert.match(values, /^  deploymentMode: external$/m);
  assert.match(
    values,
    /^  redis:\n    mode: direct\n    address: ""\n    sentinelMasterName: ""\n    sentinelAddresses: \[\]/m
  );
  assert.match(values, /^    reconnectWaitMs: 1000\n    maxReconnectAttempts: -1\n    tls:\n      enabled: false$/m);
  assert.match(values, /^  publicUrl: ""$/m);
  assert.doesNotMatch(values.slice(values.indexOf('livekit:'), values.indexOf('\n\nvoice:')), /tag:/);
  assert.match(values, /upstreamTag: v1\.13\.0/);
  assert.match(values, /^      digest: ""$/m);
  assert.match(values, /^    prometheusPort: 9090$/m);
  assert.match(values, /^    pools:$/m);
  assert.match(values, /^      track:$/m);
  assert.match(values, /^      composite:$/m);
  assert.match(values, /^        autoscaling:$/m);
  assert.match(values, /^          storageSize: 200Gi$/m);
  assert.doesNotMatch(values.slice(values.indexOf('  sip:\n', values.indexOf('media:\n')), values.indexOf('\n\ntinode:')), /tag:/);
  assert.match(helpers, /define "converact\.livekitInternalUrl"/);
  assert.match(helpers, /livekit\.url is required when livekit\.enabled=false/);
  assert.match(helpers, /define "converact\.livekitPublicUrl"/);
  assert.match(helpers, /livekit\.publicUrl is required/);
  assert.match(helpers, /livekit\.publicUrl must use wss:\/\//);
  assert.match(helpers, /define "converact\.livekitApiKey"/);
  assert.match(helpers, /livekit\.apiKey is required/);
  assert.match(helpers, /define "converact\.livekitApiSecret"/);
  assert.match(helpers, /livekit\.apiSecret is required/);
  assert.match(helpers, /define "converact\.livekitRedisAddress"/);
  assert.match(helpers, /livekit\.redis\.address is required when external LiveKit uses in-chart Egress/);
  assert.match(livekit, /include "converact\.livekitRedisConfig"/);
  assert.doesNotMatch(readFileSync(K8S_SECRETS_PATH, 'utf8'), /livekit\.apiKey \| default "devkey"/);
  assert.doesNotMatch(readFileSync(K8S_SECRETS_PATH, 'utf8'), /livekit\.apiSecret \| default "secret"/);
  assert.doesNotMatch(livekit, /livekit\.apiKey \| default "devkey"/);
  assert.doesNotMatch(egress, /livekit\.apiSecret \| default "secret"/);
  assert.match(converact, /name: LIVEKIT_PUBLIC_URL/);
  assert.match(converact, /include "converact\.livekitPublicUrl"/);
  assert.match(aiAgent, /include "converact\.livekitInternalUrl"/);
  assert.match(values, /port: 9000/);
  assert.match(values, /consolePort: 9001/);
  assert.match(values, /^  sip:\n[\s\S]*?^      limits:\n        memory: "256Mi"\n        cpu: "300m"/m);
  assert.match(values, /^  pliThrottle:\n    lowQuality: 100ms\n    midQuality: 100ms\n    highQuality: 100ms$/m);
  assert.match(
    livekit,
    /pli_throttle:\n        low_quality: \{\{ \.Values\.livekit\.pliThrottle\.lowQuality \| quote \}\}\n        mid_quality: \{\{ \.Values\.livekit\.pliThrottle\.midQuality \| quote \}\}\n        high_quality: \{\{ \.Values\.livekit\.pliThrottle\.highQuality \| quote \}\}/
  );

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

test('Kubernetes chart fails closed unless Converact application images use immutable digests', () => {
  const helpers = readFileSync(K8S_HELPERS_PATH, 'utf8');
  const values = readFileSync(K8S_VALUES_PATH, 'utf8');
  const converact = readFileSync(K8S_CONVERACT_DEPLOYMENT_PATH, 'utf8');
  const aiAgent = readFileSync(K8S_AI_AGENT_DEPLOYMENT_PATH, 'utf8');
  const frontend = readFileSync(K8S_FRONTEND_DEPLOYMENT_PATH, 'utf8');
  const rustpbx = readFileSync(K8S_RUSTPBX_DEPLOYMENT_PATH, 'utf8');

  for (const [section, helper] of [
    ['converact', 'platform'],
    ['aiAgent', 'aiAgent'],
    ['frontend', 'frontend']
  ]) {
    assert.match(helpers, new RegExp(`define "converact\\.${helper}Image"`));
    assert.match(helpers, new RegExp(`${section}\\.image\\.digest is required`));
    assert.match(helpers, new RegExp(`${section}\\.image\\.digest must be an immutable sha256 digest`));
  }
  assert.match(helpers, /regexMatch "\^sha256:\[a-f0-9\]\{64\}\$"/);

  for (const sectionName of ['converact', 'aiAgent', 'frontend']) {
    const start = values.indexOf(`${sectionName}:\n`);
    const end = values.indexOf('\n\n', start);
    const section = values.slice(start, end);
    assert.match(section, /repository: /);
    assert.match(section, /digest: ""/);
    assert.doesNotMatch(section, /tag:/);
  }

  assert.match(converact, /image: {{ include "converact\.platformImage" \. | quote }}/);
  assert.match(aiAgent, /image: {{ include "converact\.aiAgentImage" \. | quote }}/);
  assert.match(frontend, /image: {{ include "converact\.frontendImage" \. | quote }}/);
  assert.match(rustpbx, /\$converactImage := include "converact\.platformImage" \./);
  assert.doesNotMatch(
    `${converact}\n${aiAgent}\n${frontend}\n${rustpbx}`,
    /(?:converact|aiAgent|frontend)\.image\.tag|:latest/
  );
});

test('Kubernetes chart renders every bundled infrastructure image by immutable digest', () => {
  const helpers = readFileSync(K8S_HELPERS_PATH, 'utf8');
  const values = readFileSync(K8S_VALUES_PATH, 'utf8');
  const templates = {
    postgres: readFileSync(K8S_POSTGRES_DEPLOYMENT_PATH, 'utf8'),
    redis: readFileSync(K8S_REDIS_DEPLOYMENT_PATH, 'utf8'),
    nats: readFileSync(K8S_NATS_DEPLOYMENT_PATH, 'utf8'),
    livekit: readFileSync(K8S_LIVEKIT_DEPLOYMENT_PATH, 'utf8'),
    livekitSip: readFileSync(K8S_SIP_DEPLOYMENT_PATH, 'utf8'),
    rustdesk: readFileSync(K8S_RUSTDESK_DEPLOYMENT_PATH, 'utf8'),
  };

  for (const component of Object.keys(templates)) {
    assert.match(helpers, new RegExp(`define "converact\\.${component}Image"`));
    assert.match(helpers, new RegExp(`immutable sha256 digest`));
    assert.match(templates[component as keyof typeof templates], new RegExp(`include "converact\\.${component}Image"`));
    assert.doesNotMatch(templates[component as keyof typeof templates], /image:\s*[^\n]*:[^@\s"}]+\s*$/m);
  }

  for (const section of ['postgres', 'redis', 'nats', 'livekit', 'rustdesk']) {
    const marker = `\n${section}:\n`;
    const start = values.indexOf(marker) + 1;
    const end = values.indexOf('\n\n', start);
    assert.notEqual(start, 0, `missing top-level ${section} values`);
    assert.match(values.slice(start, end), /image:\n\s+repository: [^\n]+\n\s+digest: ""/);
  }
  assert.match(values, /sip:\n[\s\S]*?image:\n\s+repository: ghcr\.io\/songgoldenwind-crypto\/converact-livekit-sip\n\s+digest: ""/);
});

test('Kubernetes chart defines RustDesk OSS runtime dependencies', () => {
  const rustdesk = readFileSync(K8S_RUSTDESK_DEPLOYMENT_PATH, 'utf8');
  const converact = readFileSync(K8S_CONVERACT_DEPLOYMENT_PATH, 'utf8');
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
  assert.match(rustdesk, /include "converact\.rustdeskImage"/);
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
  assert.match(values, /repository: ghcr\.io\/songgoldenwind-crypto\/converact-rustdesk-server/);
  assert.match(values, /^  serverVersion: "1\.1\.16"$/m);
  assert.match(values.slice(values.indexOf('rustdesk:')), /^    digest: ""$/m);
  assert.match(values, /alwaysUseRelay: "N"/);
  for (const [envName, valuePath] of [
    ['RUSTDESK_SERVER_IMAGE_TAG', 'rustdesk.serverVersion'],
    ['CONVERACT_RUSTDESK_CLIENT_VERSION', 'rustdesk.clientVersion'],
    ['CONVERACT_RUSTDESK_CLIENT_PROFILE_TTL_SECONDS', 'rustdesk.clientProfileTtlSeconds'],
    ['CONVERACT_RUSTDESK_CLIENT_ARTIFACTS_JSON', 'rustdesk.clientArtifactsJson']
  ]) {
    assert.match(converact, new RegExp(`name: ${envName}\\n\\s+value: \\{\\{ \\.Values\\.${valuePath.replaceAll('.', '\\.')}`));
  }
  assert.doesNotMatch(converact, /CONVERACT_RUSTDESK_CLIENT_PROFILE_TTL_MS/);
  assert.match(rustdesk, /image: {{ include "converact\.rustdeskImage" \. \| quote }}/);
  assert.match(values, /^  clientVersion: "1\.4\.9"$/m);
  assert.ok((rustdesk.match(/mountPath: \/data/g) || []).length >= 2);
  assert.match(rustdesk, /runAsUser: 10001/);
  assert.match(values, /^  clientProfileTtlSeconds: "900"$/m);
  assert.match(values, /^  clientArtifactsJson: ""$/m);
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
