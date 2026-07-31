import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = 'services/converact-service/acceptance/opentelemetry';

test('OpenTelemetry acceptance is isolated, bounded and server-only', () => {
  for (const file of ['docker-compose.yml', 'collector.yaml', 'backend.mjs', 'probe.ts', 'accept.sh']) {
    assert.equal(existsSync(`${root}/${file}`), true, `missing ${file}`);
  }
  const compose = readFileSync(`${root}/docker-compose.yml`, 'utf8');
  const collector = readFileSync(`${root}/collector.yaml`, 'utf8');
  const script = readFileSync(`${root}/accept.sh`, 'utf8');

  assert.match(compose, /opentelemetry-collector-contrib@sha256:93aad750/);
  assert.match(compose, /127\.0\.0\.1::4318/);
  assert.doesNotMatch(compose, /network_mode:\s*host/);
  assert.match(collector, /memory_limiter:/);
  assert.match(collector, /batch:/);
  assert.match(collector, /otlp_http\/traces:/);
  assert.match(script, /IVEKIT_VALIDATION_SERVER_IP/);
  assert.match(script, /64\.225\.122\.227/);
  assert.match(script, /docker compose[\s\S]*stop collector/);
  assert.match(script, /--mode fail-open/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /led-platform-admin-1/);
  assert.match(script, /led-platform-web-1/);
});
