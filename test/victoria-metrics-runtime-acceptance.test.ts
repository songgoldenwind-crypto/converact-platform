import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = 'services/converact-service/acceptance/victoria-metrics';

test('VictoriaMetrics acceptance covers WAL recovery and backup restore on the server', () => {
  for (const file of ['docker-compose.yml', 'prometheus.yml', 'source.mjs', 'probe.mjs', 'accept.sh']) {
    assert.equal(existsSync(`${root}/${file}`), true, `missing ${file}`);
  }
  const compose = readFileSync(`${root}/docker-compose.yml`, 'utf8');
  const prometheus = readFileSync(`${root}/prometheus.yml`, 'utf8');
  const script = readFileSync(`${root}/accept.sh`, 'utf8');

  assert.match(compose, /victoria-metrics@sha256:407013e902f9/);
  assert.match(compose, /prom\/prometheus@sha256:69f524141883/);
  assert.match(compose, /vmbackup@sha256:1d01f330d98d/);
  assert.match(compose, /vmrestore@sha256:9a35e0b371f7/);
  assert.match(compose, /restore:[\s\S]*network_mode: none/);
  assert.equal((compose.match(/user: "1000:1000"/g) || []).length, 3);
  assert.equal((compose.match(/read_only: true/g) || []).length, 3);
  assert.doesNotMatch(compose, /privileged: true/);
  assert.doesNotMatch(compose, /network_mode:\s*host/);
  assert.match(prometheus, /remote_write:/);
  assert.match(prometheus, /victoria-metrics:8428\/api\/v1\/write/);
  assert.match(script, /CONVERACT_FABRIC_VALIDATION_SERVER_IP/);
  assert.match(script, /docker compose[\s\S]*stop victoria-metrics/);
  assert.match(script, /run --rm --no-deps backup/);
  assert.match(script, /run --rm --no-deps restore/);
  assert.match(script, /led-platform-admin-1/);
  assert.match(script, /led-platform-web-1/);
  assert.match(script, /trap cleanup EXIT/);
});
