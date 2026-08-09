import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderRustPbxConfig } from '../src/agent-runtime/converact/voice/rustpbx-config.js';

const ENV = {
  RUSTPBX_DATABASE_URL: 'postgresql://rustpbx_app:database-secret@postgres:5432/rustpbx',
  RUSTPBX_IMAGE: `ghcr.io/example/converact-rustpbx@sha256:${'a'.repeat(64)}`,
  RUSTPBX_AMI_ALLOWS: '127.0.0.1,10.30.0.0/16',
  RUSTPBX_MANAGEMENT_TOKEN: 'management-secret-value',
  RUSTPBX_RWI_TOKEN: 'rwi-secret-value',
  RUSTPBX_WEBHOOK_TOKEN: 'webhook-secret-value',
  CONVERACT_FABRIC_WEBPHONE_ENABLED: '1',
  CONVERACT_FABRIC_WEBPHONE_JWT_SECRET: 'webphone-jwt-secret-value-that-is-at-least-32-bytes',
  CONVERACT_FABRIC_WEBPHONE_JWT_ISSUER: 'converact',
  CONVERACT_FABRIC_WEBPHONE_JWT_AUDIENCE: 'rustpbx-webphone',
  RUSTPBX_ROUTER_URL: 'http://ivekit-api:3000/api/ivekit/voice/providers/profile/router',
  RUSTPBX_CDR_WEBHOOK_URL: 'http://ivekit-api:3000/api/ivekit/voice/providers/profile/cdrs',
  RUSTPBX_SIP_PORT: '5060',
  RUSTPBX_RTP_START_PORT: '20000',
  RUSTPBX_RTP_END_PORT: '20100'
} satisfies NodeJS.ProcessEnv;

test('RustPBX uses the shared PostgreSQL locator for multi-node WebPhone registration', () => {
  const config = renderRustPbxConfig(ENV).config;

  assert.match(config, /\[proxy\.locator\]\s*\ntype = "database"\s*\nurl = "postgresql:\/\/rustpbx_app:database-secret@postgres:5432\/rustpbx"/);
  assert.match(config, /sip_header_name = "X-Auth-Token"/);
  assert.doesNotMatch(config, /\[proxy\.locator\][\s\S]{0,100}type = "memory"/);
});

test('RustPBX patch binds JWT subject to SIP and registrar identities', async () => {
  const [patch, build] = await Promise.all([
    readFile(new URL(
      '../infra/converact/rustpbx/patches/rustpbx-ivekit-webphone-edge-auth.patch',
      import.meta.url
    ), 'utf8'),
    readFile(new URL('../infra/converact/rustpbx/build.sh', import.meta.url), 'utf8')
  ]);

  assert.match(patch, /jwt_auth_backend\.rs/);
  assert.match(patch, /from_header/);
  assert.match(patch, /user_id/);
  assert.match(patch, /JWT subject does not match SIP From identity/);
  assert.doesNotMatch(patch, /user\.username != tx_user\.username/);
  assert.match(patch, /registrar\.rs/);
  assert.match(patch, /cookie\.get_user\(\)/);
  assert.match(patch, /registered_aor\.user\(\)/);
  assert.match(patch, /Authenticated user does not match REGISTER To identity/);
  assert.doesNotMatch(
    patch,
    /token_subject\s*=|sip_from\s*=|authenticated_user\s*=|register_to\s*=/
  );
  assert.match(build, /rustpbx-ivekit-webphone-edge-auth\.patch/);
  assert.match(build, /PATCHSET="ivekit\.60"/);
});
