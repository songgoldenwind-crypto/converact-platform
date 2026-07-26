import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve('infra/capacity/rustpbx-baseline');

test('RustPBX baseline keeps production authentication and an isolated topology', () => {
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  const template = readFileSync(join(root, 'rustpbx.toml.template'), 'utf8');
  const bootstrap = readFileSync(join(root, 'bootstrap-inbound-trunk.py'), 'utf8');
  const runner = readFileSync(join(root, 'run.sh'), 'utf8');

  assert.match(compose, /RUSTPBX_IMAGE:\?RUSTPBX_IMAGE/);
  assert.match(compose, /KAMAILIO_IMAGE:\?KAMAILIO_IMAGE/);
  assert.match(compose, /POSTGRES_IMAGE:\?POSTGRES_IMAGE/);
  assert.match(compose, /PYTHON_IMAGE:\?PYTHON_IMAGE/);
  assert.match(compose, /CAPACITY_TOOLS_IMAGE:\?CAPACITY_TOOLS_IMAGE/);
  assert.match(compose, /scripts\/capacity\/fixtures\/rustpbx-router\.ts/);
  assert.match(compose, /- node\n\s+- -e\n\s+- fetch\('http:\/\/127\.0\.0\.1:8081\/health'/);
  assert.match(compose, /172\.30\.44\.10/);
  assert.match(compose, /172\.30\.44\.20/);
  assert.match(compose, /nofile:\s*\n\s+soft: 262144\s*\n\s+hard: 262144/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.match(template, /ensure_user = true/);
  assert.match(template, /fallback_to_static = false/);
  assert.match(template, /database_url = "postgresql:\/\/rustpbx_app:/);
  assert.match(template, /max_concurrent = 64/);
  assert.match(template, /channel_capacity = 65536/);
  assert.match(template, /worker_threads = 1/);
  assert.match(template, /persist_to_database = false/);
  assert.doesNotMatch(template, /sqlite/i);
  assert.match(bootstrap, /"allowed_ips": json\.dumps\(\[UAC_IP\]\)/);
  assert.match(bootstrap, /"filters": \{"q": TRUNK_NAME\}/);
  assert.match(bootstrap, /item\.get\("name"\) == TRUNK_NAME/);
  assert.match(bootstrap, /\/ami\/v1\/reload\/trunks/);
  assert.doesNotMatch(bootstrap, /verify\s*=\s*False/);
  assert.match(runner, /WALL_TIMEOUT_SECONDS/);
  assert.match(runner, /docker kill --signal=INT/);
  assert.match(runner, /router_delta/);
  assert.match(runner, /cdr_delta/);
  assert.match(runner, /successful_calls/);
  assert.match(runner, /result\.get\(name\) != expected_value/);
  assert.equal(spawnSync('bash', ['-n', join(root, 'run.sh')]).status, 0);
});

test('RustPBX baseline preparation creates private runtime secrets without leaking them', () => {
  const output = mkdtempSync(join(tmpdir(), 'ivekit-rustpbx-baseline-'));
  const result = spawnSync('python3', [join(root, 'prepare.py'), output], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      RUSTPBX_IMAGE: 'ivekit/rustpbx:0.4.11-ivekit.25-6c49ee76',
      KAMAILIO_IMAGE: 'ivekit/kamailio:6.0.7-ivekit.1',
      POSTGRES_IMAGE: 'postgres@sha256:' + 'a'.repeat(64),
      PYTHON_IMAGE: 'python@sha256:' + 'b'.repeat(64),
      CAPACITY_TOOLS_IMAGE: 'ivekit/capacity-tools:test'
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), realpathSync(output));
  const env = readFileSync(join(output, '.env'), 'utf8');
  const config = readFileSync(join(output, 'rustpbx.toml'), 'utf8');
  assert.equal(statSync(join(output, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(output, 'rustpbx.toml')).mode & 0o777, 0o600);
  assert.doesNotMatch(config, /\{\{[A-Z0-9_]+\}\}/);
  assert.doesNotMatch(result.stdout, /RUSTPBX_(?:DB_PASSWORD|MANAGEMENT_TOKEN|RWI_TOKEN|WEBHOOK_TOKEN)=/);
  assert.match(env, /^COMPOSE_PROJECT_NAME=ivekit-rustpbx-baseline$/m);
  assert.match(env, /^RUSTPBX_IMAGE=ivekit\/rustpbx:0\.4\.11-ivekit\.25-6c49ee76$/m);
  assert.match(env, /^KAMAILIO_IMAGE=ivekit\/kamailio:6\.0\.7-ivekit\.1$/m);
  assert.match(env, /^CAPACITY_TOOLS_IMAGE=ivekit\/capacity-tools:test$/m);
});
