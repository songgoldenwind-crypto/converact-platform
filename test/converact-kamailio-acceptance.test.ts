import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  KAMAILIO_ACCEPTANCE_SCENARIOS,
  buildKamailioAcceptanceReport,
  scenarioContractSha256
} from '../scripts/converact-kamailio-acceptance.js';

test('Kamailio controlled acceptance covers routing, affinity, failover, drain and trust boundaries', () => {
  assert.deepEqual(KAMAILIO_ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id), [
    'weighted-distribution',
    'dialog-affinity',
    'retry-transport',
    'retry-503',
    'no-retry-486',
    'drain-removes-new-call',
    'node-down-up',
    'stale-snapshot-fail-closed',
    'forged-header-sanitized',
    'dmq-public-rejected',
    'webphone-register-refresh',
    'webphone-cross-edge-delivery'
  ]);
  for (const scenario of KAMAILIO_ACCEPTANCE_SCENARIOS) {
    assert.ok(scenario.assertions.length >= 2, scenario.id);
    if (scenario.driver === 'sipp') {
      assert.match(scenario.sipp_scenario!, /^[a-z0-9-]+\.xml$/);
      const xml = readFileSync(
        `services/converact-service/acceptance/kamailio-sip-edge/scenarios/${scenario.sipp_scenario}`,
        'utf8'
      );
      assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" \?>/);
      assert.match(xml, /<scenario name="Converact Fabric Kamailio/);
    } else {
      assert.match(scenario.webphone_mode!, /^(register-refresh|cross-edge-delivery)$/);
    }
  }
  const retry503 = KAMAILIO_ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === 'retry-503');
  assert.equal(retry503?.sipp_scenario, 'invite-bye-affinity-uac.xml');
  assert.deepEqual(retry503?.assertions, [
    'first_candidate_returned_503',
    'second_candidate_answered',
    'single_dialog_confirmed',
    'failover_counter_incremented'
  ]);
  assert.match(scenarioContractSha256(), /^[a-f0-9]{64}$/);
});

test('Kamailio acceptance report cannot promote missing or unbound evidence', (t) => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'converact-kamailio-acceptance-'));
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const base = {
    source_commit: 'a'.repeat(40),
    kamailio_image: `registry.example.test/kamailio@sha256:${'b'.repeat(64)}`,
    rustpbx_image: `registry.example.test/rustpbx@sha256:${'c'.repeat(64)}`,
    environment_id: 'controlled-compose-a',
    generated_at: '2026-07-21T12:00:00.000Z',
    artifact_root: artifactRoot
  };
  const observations = KAMAILIO_ACCEPTANCE_SCENARIOS.map((scenario, index) => {
    const artifactPath = `${scenario.id}/sipp-statistics.csv`;
    const content = Buffer.from(`scenario=${scenario.id};index=${index}\n`);
    mkdirSync(dirname(join(artifactRoot, artifactPath)), { recursive: true });
    writeFileSync(join(artifactRoot, artifactPath), content);
    return {
      scenario_id: scenario.id,
      status: 'passed' as const,
      started_at: `2026-07-21T12:00:${String(index).padStart(2, '0')}.000Z`,
      completed_at: `2026-07-21T12:01:${String(index).padStart(2, '0')}.000Z`,
      assertions: Object.fromEntries(scenario.assertions.map((name) => [name, true])),
      artifacts: [{
        path: artifactPath,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex')
      }]
    };
  });

  const passed = buildKamailioAcceptanceReport({ ...base, observations });
  assert.equal(passed.status, 'ready_for_review');
  assert.equal(passed.scenarios.every((scenario) => scenario.status === 'passed'), true);

  const missing = buildKamailioAcceptanceReport({
    ...base,
    observations: observations.slice(0, -1)
  });
  assert.equal(missing.status, 'not_run');
  assert.equal(missing.scenarios.at(-1)?.status, 'not_run');

  assert.throws(() => buildKamailioAcceptanceReport({
    ...base,
    observations: observations.map((entry, index) => index === 0
      ? { ...entry, assertions: { ...entry.assertions, snapshot_fresh: false } }
      : entry)
  }), /assertion/i);
  assert.throws(() => buildKamailioAcceptanceReport({
    ...base,
    observations: observations.map((entry, index) => index === 1
      ? { ...entry, artifacts: [{ ...entry.artifacts[0]!, sha256: 'not-a-hash' }] }
      : entry)
  }), /sha256/i);
  assert.throws(() => buildKamailioAcceptanceReport({
    ...base,
    observations: observations.map((entry, index) => index === 0
      ? { ...entry, artifacts: [{ ...observations[1]!.artifacts[0]! }] }
      : entry)
  }), /artifact path/i);

  writeFileSync(
    join(artifactRoot, observations[0]!.artifacts[0]!.path),
    'tampered evidence with different bytes\n'
  );
  assert.throws(
    () => buildKamailioAcceptanceReport({ ...base, observations }),
    /artifact (?:size|sha256)/i
  );
});

test('Kamailio acceptance documentation preserves physical capacity as a separate gate', () => {
  const readme = readFileSync(
    'services/converact-service/acceptance/kamailio-sip-edge/README.md',
    'utf8'
  );
  assert.match(readme, /Cell admission.*authority/i);
  assert.match(readme, /SIPp/i);
  assert.match(readme, /not_run/);
  assert.match(readme, /不.*10 万并发|不.*容量结论/);
});
