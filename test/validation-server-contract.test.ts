import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const contractPath = 'scripts/lib/converact-validation-server.sh';
const runbookPath = 'docs/deployment/converact-validation-server.md';
const acceptanceScripts = [
  'services/converact-service/acceptance/valkey-sentinel/accept.sh',
  'services/converact-service/acceptance/opentelemetry/accept.sh',
  'services/converact-service/acceptance/victoria-metrics/accept.sh',
];

function source(path: string): string {
  assert.equal(existsSync(path), true, `${path} is missing`);
  return readFileSync(path, 'utf8');
}

test('future validation runs use the canonical non-production SSH target', () => {
  source(contractPath);
  const values = execFileSync(
    '/bin/sh',
    [
      '-c',
      '. "$1"; printf "%s\\n%s\\n%s\\n" "$CONVERACT_VALIDATION_SERVER_IP" "$CONVERACT_VALIDATION_SSH_USER" "$CONVERACT_VALIDATION_SSH_TARGET"',
      'validation-server-contract',
      contractPath,
    ],
    { encoding: 'utf8' },
  ).trim().split('\n');

  assert.deepEqual(values, ['101.42.7.139', 'ubuntu', 'ubuntu@101.42.7.139']);
});

test('server-gated acceptance scripts consume one validation-server authority', () => {
  for (const path of acceptanceScripts) {
    const script = source(path);
    assert.match(script, /scripts\/lib\/converact-validation-server\.sh/u, path);
    assert.match(script, /EXPECTED_SERVER_IP=["']?\$CONVERACT_VALIDATION_SERVER_IP["']?/u, path);
    assert.match(script, /assert_container_baseline/u, path);
    assert.doesNotMatch(script, /64\.225\.122\.227/u, path);
    assert.doesNotMatch(script, /led-platform-/u, path);
  }
});

test('validation runbook separates the new target from immutable historical evidence', () => {
  const runbook = source(runbookPath);
  assert.match(runbook, /ssh ubuntu@101\.42\.7\.139/u);
  assert.match(runbook, /non-production/u);
  assert.match(runbook, /历史证据/u);
  assert.match(runbook, /不得.*替换/u);
  assert.match(source('README.md'), /converact-validation-server\.md/u);
});

test('active validation guidance points future runs at the canonical target', () => {
  const valkeyRunbook = source('docs/deployment/valkey-sentinel-migration.md');
  const waveThreePlan = source('docs/converact-fabric-wave3-rtc-external-intelligence-implementation-plan.md');

  assert.match(valkeyRunbook, /Future validation target:.*101\.42\.7\.139/u);
  assert.match(valkeyRunbook, /Historical evidence server:.*64\.225\.122\.227/u);
  assert.match(waveThreePlan, /101\.42\.7\.139/u);
  assert.doesNotMatch(waveThreePlan, /64\.225\.122\.227/u);
});
