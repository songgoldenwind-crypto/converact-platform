import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { renderRustPbxConfig } from '../scripts/render-rustpbx-config.js';

const STANDALONE_COMPOSE = new URL('../infra/ivekit/docker-compose.yml', import.meta.url);
const VOICE_COMPOSE = new URL('../infra/ivekit/docker-compose.voice.yml', import.meta.url);
const PRODUCTION_COMPOSE = new URL('../infra/docker-compose.production.yml', import.meta.url);
const STANDALONE_BOOTSTRAP = new URL('../infra/ivekit/init-postgres-runtime-role.sh', import.meta.url);
const CHECKED_IN_CONFIG = new URL('../config/rustpbx.docker.toml', import.meta.url);
const HELM_VALUES = new URL('../infra/k8s/values.yaml', import.meta.url);
const HELM_SECRETS = new URL('../infra/k8s/templates/secrets.yaml', import.meta.url);
const HELM_OPC = new URL('../infra/k8s/templates/opc-deployment.yaml', import.meta.url);
const HELM_RUSTPBX = new URL('../infra/k8s/templates/rustpbx-deployment.yaml', import.meta.url);

const SECRET_VALUES = {
  RUSTPBX_DATABASE_URL: 'postgresql://rustpbx_app:database-secret@postgres:5432/rustpbx',
  RUSTPBX_IMAGE: 'ghcr.io/restsend/rustpbx:0.4.10',
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
});

test('RustPBX renderer emits a usable config and a secret-free summary', () => {
  const rendered = renderRustPbxConfig(SECRET_VALUES);

  assert.match(rendered.config, /database_url = "postgresql:\/\/rustpbx_app:database-secret@postgres:5432\/rustpbx"/);
  assert.match(rendered.config, /rtp_start_port = 20000/);
  assert.match(rendered.config, /udp_port = 5060/);
  assert.match(rendered.config, /\[\[rwi\.tokens\]\]/);
  assert.match(rendered.config, /X-PBX-Key = "webhook-secret-value"/);
  assert.doesNotMatch(rendered.config, /sqlite/i);

  const summary = JSON.stringify(rendered.summary);
  for (const secret of ['database-secret', 'rwi-secret-value', 'webhook-secret-value']) {
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
  assert.match(voice, /render-rustpbx-config\.ts/);
  assert.match(voice, /rustpbx-runtime-config:\/app\/config/);
  assert.match(voice, /RUSTPBX_DATABASE_URL: postgresql:\/\/rustpbx_app@postgres:5432\/rustpbx/);
  assert.match(voice, /RUSTPBX_DB_PASSWORD/);
  assert.match(voice, /expose:\s*\n\s*- "8080"/);
  assert.match(voice, /\$\{RUSTPBX_SIP_PORT:-5060\}:5060\/udp/);
  assert.match(voice, /\$\{RUSTPBX_RTP_START_PORT:-20000\}-\$\{RUSTPBX_RTP_END_PORT:-20100\}:20000-20100\/udp/);
  assert.doesNotMatch(serviceBlock(voice, 'opc'), /RUSTPBX_DB_PASSWORD/);
  assert.doesNotMatch(serviceBlock(core, 'opc'), /RUSTPBX_DB_PASSWORD/);
  assert.doesNotMatch(voice, /sqlite/i);
});

test('production compose has no floating or SQLite RustPBX deployment', () => {
  const compose = readFileSync(PRODUCTION_COMPOSE, 'utf8');
  const rustpbx = serviceBlock(compose, 'rustpbx');
  const opc = serviceBlock(compose, 'opc');

  assert.match(rustpbx, /image: \$\{RUSTPBX_IMAGE:\?RUSTPBX_IMAGE is required\}/);
  assert.match(rustpbx, /profiles: \["voice"\]/);
  assert.match(rustpbx, /rustpbx-runtime-config:\/app\/config/);
  assert.match(rustpbx, /postgres-bootstrap:\s*\n\s+condition: service_completed_successfully/);
  assert.doesNotMatch(rustpbx, /:latest/);
  assert.doesNotMatch(rustpbx, /sqlite/i);
  assert.doesNotMatch(opc, /RUSTPBX_DB_PASSWORD/);
});

test('checked-in RustPBX config is secret-free and cannot start production', () => {
  const config = readFileSync(CHECKED_IN_CONFIG, 'utf8');

  assert.doesNotMatch(config, /sqlite/i);
  assert.doesNotMatch(config, /dev-(?:pbx-key|rwi-token)/i);
  assert.match(config, /__RUSTPBX_DATABASE_URL_REQUIRED__/);
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
  assert.match(values, /tag: "0\.4\.10"/);
  assert.match(values, /database:\s*\n\s+username: rustpbx_app\s*\n\s+name: rustpbx/);
  assert.match(secrets, /rustpbx-database-url:/);
  assert.match(secrets, /rustpbx-rwi-token:/);
  assert.match(secrets, /rustpbx-webhook-token:/);
  assert.match(secrets, /ivekit-voice-address-key:/);
  assert.match(rustpbx, /^\{\{- if \.Values\.voice\.enabled \}\}/);
  assert.match(rustpbx, /image: "\{\{ \.Values\.voice\.image\.repository \}\}:\{\{ \.Values\.voice\.image\.tag \}\}"/);
  assert.match(rustpbx, /kind: PodDisruptionBudget/);
  assert.match(rustpbx, /readinessProbe:/);
  assert.match(rustpbx, /livenessProbe:/);
  assert.match(rustpbx, /securityContext:/);
  assert.match(rustpbx, /resources:/);
  assert.match(rustpbx, /name: management/);
  assert.match(rustpbx, /clusterIP: None/);
  assert.match(rustpbx, /name: sip-udp/);
  assert.match(rustpbx, /name: rtp-/);
  assert.doesNotMatch(opc, /rustpbx-database-url/);
  assert.doesNotMatch(opc, /RUSTPBX_DB_PASSWORD/);
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
