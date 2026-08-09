import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-cdr-mtls-noop.patch';

test('RustPBX CDR transport uses mTLS and a no-op legacy sink', () => {
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  const patch = readFileSync(patchPath, 'utf8');
  const compose = readFileSync('infra/converact/docker-compose.voice.yml', 'utf8');
  const serviceCompose = readFileSync(
    'services/converact-service/docker-compose.voice.yml',
    'utf8'
  );
  const converactHelm = readFileSync('infra/k8s/templates/converact-deployment.yaml', 'utf8');
  const rustPbxHelm = readFileSync(
    'infra/k8s/templates/rustpbx-deployment.yaml',
    'utf8'
  );
  const serviceConveractHelm = readFileSync(
    'services/converact-service/helm/converact/templates/deployment.yaml',
    'utf8'
  );
  const serviceRustPbxHelm = readFileSync(
    'services/converact-service/helm/converact/templates/rustpbx-deployment.yaml',
    'utf8'
  );

  assert.equal(spawnSync('git', ['apply', '--numstat', patchPath]).status, 0);
  assert.match(build, /rustpbx-ivekit-cdr-mtls-noop\.patch/);
  assert.match(build, /PATCHSET="ivekit\.57"/);
  assert.match(
    build,
    /rustpbx-ivekit-dual-leg-cdr\.patch"[\s\S]*rustpbx-ivekit-cdr-mtls-noop\.patch"[\s\S]*rustpbx-ivekit-media-tracing\.patch"/
  );
  assert.match(patch, /CallRecordStorageConfig::Noop/);
  assert.match(patch, /IVEKIT_RUSTPBX_CDR_TLS_IDENTITY_FILE/);
  assert.match(patch, /IVEKIT_RUSTPBX_CDR_TLS_CA_FILE/);
  assert.match(patch, /Identity::from_pem/);
  assert.match(patch, /Certificate::from_pem/);
  assert.match(patch, /tls_certs_only\(\[ca\]\)/);
  assert.doesNotMatch(patch, /add_root_certificate/);
  assert.doesNotMatch(patch, /tls_built_in_root_certs/);
  assert.match(patch, /permissions\(\)\.mode\(\) & 0o037/);
  assert.doesNotMatch(patch, /permissions\(\)\.mode\(\) & 0o077/);
  assert.match(
    patch,
    /--- a\/src\/callrecord\/storage\.rs[\s\S]*Some\(CallRecordStorageConfig::Noop\) => Ok\(None\)/
  );
  assert.match(
    patch,
    /--- a\/src\/console\/handlers\/setting\.rs[\s\S]*Some\(CallRecordStorageConfig::Noop\)[\s\S]*CallRecordStorageConfig::Noop => Some/
  );
  assert.match(patch, /production_cdr_requires_mtls_files/);
  assert.match(compose, /CONVERACT_FABRIC_INTERNAL_TLS_PORT: "3443"/);
  assert.match(compose, /IVEKIT_RUSTPBX_CDR_TLS_IDENTITY_FILE:/);
  assert.match(compose, /IVEKIT_RUSTPBX_CDR_TLS_CA_FILE:/);
  assert.match(
    compose,
    /RUSTPBX_CDR_ENDPOINT:\?RUSTPBX_CDR_ENDPOINT is required/
  );
  assert.match(
    compose,
    /source: rustpbx-cdr-client-identity[\s\S]{0,100}mode: 0400/
  );
  assert.match(
    compose,
    /source: rustpbx-cdr-server-key[\s\S]{0,100}mode: 0400/
  );
  assert.match(
    serviceCompose,
    /source: rustpbx-cdr-client-identity-b[\s\S]{0,100}mode: 0400/
  );
  assert.match(
    serviceCompose,
    /source: rustpbx-cdr-server-key[\s\S]{0,100}mode: 0400/
  );
  for (const template of [converactHelm, serviceConveractHelm]) {
    assert.match(template, /CONVERACT_FABRIC_INTERNAL_TLS_PORT/);
    assert.match(template, /CONVERACT_FABRIC_INTERNAL_TLS_CLIENT_CA_FILE/);
    assert.match(template, /name: internal-tls/);
  }
  for (const template of [rustPbxHelm, serviceRustPbxHelm]) {
    assert.match(template, /IVEKIT_RUSTPBX_CDR_TLS_IDENTITY_FILE/);
    assert.match(template, /IVEKIT_RUSTPBX_CDR_TLS_CA_FILE/);
    assert.match(template, /clientIdentityKey/);
    assert.match(template, /defaultMode: 0440/);
  }
});
