import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { renderRustPbxConfig } from '../scripts/render-rustpbx-config.js';
import { createVoiceQueueTenantLister } from '../src/agent-runtime/ivekit/voice/runtime.js';
import type { PgQueryable } from '../src/db-pg.js';

const STANDALONE_COMPOSE = new URL('../infra/ivekit/docker-compose.yml', import.meta.url);
const VOICE_COMPOSE = new URL('../infra/ivekit/docker-compose.voice.yml', import.meta.url);
const SERVICE_VOICE_COMPOSE = new URL('../services/ivekit-service/docker-compose.voice.yml', import.meta.url);
const SERVICE_RUSTPBX_INIT = new URL('../services/ivekit-service/init-rustpbx-database.sh', import.meta.url);
const SERVICE_HELM_VALUES = new URL('../services/ivekit-service/helm/ivekit/values.yaml', import.meta.url);
const SERVICE_HELM_RUSTPBX = new URL(
  '../services/ivekit-service/helm/ivekit/templates/rustpbx-deployment.yaml',
  import.meta.url
);
const PRODUCTION_COMPOSE = new URL('../infra/docker-compose.production.yml', import.meta.url);
const STANDALONE_BOOTSTRAP = new URL('../infra/ivekit/init-postgres-runtime-role.sh', import.meta.url);
const CHECKED_IN_CONFIG = new URL('../config/rustpbx.docker.toml', import.meta.url);
const HELM_VALUES = new URL('../infra/k8s/values.yaml', import.meta.url);
const HELM_SECRETS = new URL('../infra/k8s/templates/secrets.yaml', import.meta.url);
const HELM_OPC = new URL('../infra/k8s/templates/opc-deployment.yaml', import.meta.url);
const HELM_RUSTPBX = new URL('../infra/k8s/templates/rustpbx-deployment.yaml', import.meta.url);
const VOICE_RUNTIME = new URL('../src/agent-runtime/ivekit/voice/runtime.ts', import.meta.url);
const SERVICE_PACKAGE = new URL('../services/ivekit-service/package.json', import.meta.url);
const SOURCE_POLICY = new URL('../services/ivekit-service/source-policy.json', import.meta.url);
const STANDALONE_CONTEXT_VERIFIER = new URL('../scripts/verify-ivekit-standalone-context.ts', import.meta.url);

const SECRET_VALUES = {
  RUSTPBX_DATABASE_URL: 'postgresql://rustpbx_app:database-secret@postgres:5432/rustpbx',
  RUSTPBX_IMAGE: 'ghcr.io/restsend/rustpbx@sha256:2dc00f409f49bf48a23de6101d9d7371692eb7f067e70f4d449f16e158302526',
  RUSTPBX_AMI_ALLOWS: '127.0.0.1,172.31.240.0/24',
  RUSTPBX_MANAGEMENT_TOKEN: 'management-secret-value',
  RUSTPBX_RWI_TOKEN: 'rwi-secret-value',
  RUSTPBX_WEBHOOK_TOKEN: 'webhook-secret-value',
  RUSTPBX_ROUTER_URL: 'http://ivekit-api:3000/api/ivekit/voice/providers/profile/router',
  RUSTPBX_CDR_WEBHOOK_URL: 'http://ivekit-api:3000/api/ivekit/voice/providers/profile/cdrs',
  RUSTPBX_SIP_PORT: '5060',
  RUSTPBX_RTP_START_PORT: '20000',
  RUSTPBX_RTP_END_PORT: '20100'
} satisfies NodeJS.ProcessEnv;

test('RustPBX renderer accepts only immutable PostgreSQL production inputs', () => {
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_DATABASE_URL: 'sqlite:///tmp/rustpbx.db' }),
    /PostgreSQL/i
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_IMAGE: 'ghcr.io/restsend/rustpbx:latest' }),
    /immutable/i
  );
  assert.throws(
    () => renderRustPbxConfig({ ...SECRET_VALUES, RUSTPBX_IMAGE: 'ghcr.io/restsend/rustpbx' }),
    /immutable/i
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
});

test('RustPBX renderer emits a usable config and a secret-free summary', () => {
  const rendered = renderRustPbxConfig(SECRET_VALUES);

  assert.match(rendered.config, /database_url = "postgresql:\/\/rustpbx_app:database-secret@postgres:5432\/rustpbx"/);
  assert.match(rendered.config, /rtp_start_port = 20000/);
  assert.match(rendered.config, /udp_port = 5060/);
  assert.match(rendered.config, /tcp_port = 5060/);
  assert.match(rendered.config, /generated_dir = "\/app\/generated"/);
  assert.match(rendered.config, /\[\[proxy\.user_backends\]\]\s*\ntype = "extension"\s*\nttl = 30/);
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
    management_exposure: 'internal',
    rwi_exposure: 'internal'
  });
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
  assert.match(voice, /profiles: \["voice"\]/);
  assert.match(voice, /scripts\/render-rustpbx-config\.ts/);
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
  assert.match(voice, /OPC_IVEKIT_VOICE_SECRET_ENV_NAMES: \$\{OPC_IVEKIT_VOICE_SECRET_ENV_NAMES:-RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN\}/);
  assert.match(voice, /path: \$\{OPC_IVEKIT_VOICE_RUNTIME_ENV_FILE:-\.\/voice-runtime\.env\}/);
  assert.match(voice, /required: false/);
  assert.match(voice, /expose:\s*\n\s*- "8080"/);
  assert.match(voice, /\$\{RUSTPBX_SIP_PORT:-5060\}:5060\/udp/);
  assert.match(voice, /\$\{RUSTPBX_RTP_START_PORT:-20000\}-\$\{RUSTPBX_RTP_END_PORT:-20100\}:20000-20100\/udp/);
  assert.doesNotMatch(serviceBlock(voice, 'opc'), /RUSTPBX_DB_PASSWORD/);
  assert.doesNotMatch(serviceBlock(core, 'opc'), /RUSTPBX_DB_PASSWORD/);
  assert.doesNotMatch(voice, /sqlite/i);
});

test('standalone service Voice overlay uses only compiled image entrypoints', () => {
  const voice = readFileSync(SERVICE_VOICE_COMPOSE, 'utf8');
  const bootstrap = readFileSync(SERVICE_RUSTPBX_INIT, 'utf8');

  assert.match(voice, /command: \["node", "dist\/ivekit-render-rustpbx-config\.js"\]/);
  assert.doesNotMatch(voice, /--import|\btsx\b|scripts\//);
  assert.match(voice, /command: \["node", "dist\/ivekit-rustpbx-recovery\.js"\]/);
  assert.match(voice, /rustpbx-generated-config:\/app\/generated/);
  assert.match(voice, /network_mode: service:rustpbx/);
  assert.match(voice, /rustpbx-db-init:/);
  assert.match(voice, /ivekit:/);
  assert.doesNotMatch(voice, /^\s+opc:/m);
  assert.match(voice, /http:\/\/ivekit:3000\/api\/ivekit\/voice\/providers/);
  assert.match(voice, /RUSTPBX_AMI_ALLOWS: \$\{RUSTPBX_AMI_ALLOWS:\?RUSTPBX_AMI_ALLOWS is required\}/);
  assert.match(voice, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_MANAGEMENT_TOKEN:\?RUSTPBX_MANAGEMENT_TOKEN is required\}/);
  assert.doesNotMatch(voice, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_RWI_TOKEN/);
  assert.match(voice, /OPC_IVEKIT_VOICE_SECRET_ENV_NAMES: \$\{OPC_IVEKIT_VOICE_SECRET_ENV_NAMES:-RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN\}/);
  assert.match(voice, /OPC_IVEKIT_VOICE_RUNTIME_ENV_FILE/);
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
    'node dist/ivekit-render-rustpbx-config.js'
  );
  assert.equal(
    servicePackage.scripts['preflight:voice'],
    'node dist/ivekit-voice-preflight.js'
  );
  assert.equal(
    servicePackage.scripts['recover:rustpbx'],
    'node dist/ivekit-rustpbx-recovery.js'
  );
  assert.equal(sourcePolicy.entrypoints.includes('src/ivekit-render-rustpbx-config.ts'), true);
  assert.equal(sourcePolicy.entrypoints.includes('src/ivekit-voice-preflight.ts'), true);
  assert.equal(sourcePolicy.entrypoints.includes('src/ivekit-rustpbx-recovery.ts'), true);
  for (const entrypoint of [
    'ivekit-server.js',
    'ivekit-migrate.js',
    'ivekit-init-runtime-role.js',
    'ivekit-intelligence-preflight.js',
    'ivekit-render-rustpbx-config.js',
    'ivekit-rustpbx-recovery.js',
    'ivekit-voice-preflight.js'
  ]) assert.equal(verifier.includes(`'${entrypoint}'`), true, entrypoint);
});

test('production compose has no floating or SQLite RustPBX deployment', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE, 'utf8');
  const rustpbx = serviceBlock(compose, 'rustpbx');
  const opc = serviceBlock(compose, 'opc');

  assert.match(rustpbx, /image: \$\{RUSTPBX_IMAGE:\?RUSTPBX_IMAGE is required\}/);
  assert.match(rustpbx, /profiles: \["voice"\]/);
  assert.match(rustpbx, /rustpbx-runtime-config:\/app\/config/);
  assert.match(rustpbx, /rustpbx-generated-config:\/app\/generated/);
  assert.match(compose, /rustpbx-runtime-recovery:/);
  assert.match(compose, /network_mode: service:rustpbx/);
  assert.match(rustpbx, /postgres-bootstrap:\s*\n\s+condition: service_completed_successfully/);
  assert.doesNotMatch(rustpbx, /:latest/);
  assert.doesNotMatch(rustpbx, /sqlite/i);
  assert.doesNotMatch(opc, /RUSTPBX_DB_PASSWORD/);
  assert.match(compose, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_MANAGEMENT_TOKEN/);
  assert.doesNotMatch(compose, /RUSTPBX_MANAGEMENT_TOKEN: \$\{RUSTPBX_RWI_TOKEN/);
  assert.match(opc, /OPC_IVEKIT_VOICE_SECRET_ENV_NAMES: \$\{OPC_IVEKIT_VOICE_SECRET_ENV_NAMES:-RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN\}/);
  assert.match(opc, /OPC_IVEKIT_VOICE_RUNTIME_ENV_FILE/);
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
  assert.match(values, /repository: ghcr\.io\/restsend\/rustpbx/);
  assert.match(values, /digest: "sha256:2dc00f409f49bf48a23de6101d9d7371692eb7f067e70f4d449f16e158302526"/);
  assert.match(values, /database:\s*\n\s+username: rustpbx_app\s*\n\s+name: rustpbx/);
  assert.match(secrets, /rustpbx-database-url:/);
  assert.match(secrets, /rustpbx-management-token:/);
  assert.match(secrets, /rustpbx-rwi-token:/);
  assert.match(secrets, /rustpbx-webhook-token:/);
  assert.match(secrets, /ivekit-voice-address-key:/);
  assert.match(rustpbx, /^\{\{- if \.Values\.voice\.enabled \}\}/);
  assert.match(rustpbx, /image: \{\{ \$rustpbxImage \| quote \}\}/);
  assert.match(rustpbx, /\[\[console\.api_tokens\]\]/);
  assert.match(rustpbx, /token = \{\{ \$managementToken \| quote \}\}/);
  assert.match(rustpbx, /\[ami\][\s\S]*allows =/);
  assert.match(rustpbx, /tcp_port = \{\{ \$sipPort \}\}/);
  assert.match(rustpbx, /generated_dir = "\/app\/generated"/);
  assert.match(rustpbx, /mountPath: \/app\/generated/);
  assert.match(rustpbx, /postStart:[\s\S]*\/ami\/v1\/reload\/trunks/);
  assert.match(rustpbx, /\/bin\/bash[\s\S]*\/dev\/tcp\/127\.0\.0\.1/);
  assert.doesNotMatch(rustpbx, /\bcurl\b|\bwget\b/);
  assert.match(rustpbx, /\[\[proxy\.user_backends\]\]\s*\n\s*type = "extension"/);
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
  assert.match(values, /amiAllows:\s*\n\s+- 127\.0\.0\.1/);
  assert.match(rustpbx, /name: RUSTPBX_MANAGEMENT_TOKEN[\s\S]*?key: \{\{ \.Values\.voice\.managementTokenKey \}\}/);
  assert.match(rustpbx, /name: RUSTPBX_AMI_ALLOWS/);
  assert.match(rustpbx, /mountPath: \/app\/generated/);
  assert.match(rustpbx, /postStart:[\s\S]*\/ami\/v1\/reload\/trunks/);
  assert.match(rustpbx, /\/bin\/bash[\s\S]*\/dev\/tcp\/127\.0\.0\.1/);
  assert.doesNotMatch(rustpbx, /\bcurl\b|\bwget\b/);
  assert.doesNotMatch(rustpbx, /path: \/health/);
  assert.match(values, /OPC_IVEKIT_VOICE_SECRET_ENV_NAMES: "RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN"/);
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
