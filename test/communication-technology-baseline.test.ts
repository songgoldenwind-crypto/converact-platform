import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateTechnologyBaseline,
  verifyCommunicationTechnologyBaseline
} from '../scripts/lib/communication-technology-baseline.js';

test('communication technology baseline records upgrades, replacements and additions', async () => {
  const result = await verifyCommunicationTechnologyBaseline(process.cwd());

  assert.equal(result.baseline_id, 'ivekit-communication-technology-2026-07');
  assert.ok(result.decision_count >= 30);
  assert.ok((result.action_counts.upgrade ?? 0) > 0);
  assert.ok((result.action_counts.replace ?? 0) > 0);
  assert.ok((result.action_counts.add ?? 0) > 0);
  assert.equal(result.node_runtime, '24.x LTS');
  assert.equal(result.nodemailer, '9.0.3');
  assert.equal(result.homer_hep_connector, true);
  assert.equal(result.python_dependency_lock, true);
  assert.equal(result.realtime_voice_pipeline, true);
  assert.equal(result.sip_exporter_profile, true);
});

test('technology baseline rejects duplicate decisions', async () => {
  const baseline = JSON.parse(
    await readFile(
      'docs/architecture/communication-technology-baseline-v1.json',
      'utf8'
    )
  ) as { decisions: unknown[] };
  baseline.decisions.push(baseline.decisions[0]);

  assert.throws(
    () => validateTechnologyBaseline(baseline),
    /duplicate technology decision/
  );
});

test('technology baseline records the implemented PostgreSQL HOMER fork truthfully', async () => {
  const baseline = JSON.parse(
    await readFile(
      'docs/architecture/communication-technology-baseline-v1.json',
      'utf8'
    )
  ) as { decisions: Array<{ id: string; current: string; target: string; gates: string[] }> };
  const homer = baseline.decisions.find((decision) => decision.id === 'homer');

  assert.ok(homer);
  assert.match(homer.current, /PostgreSQL DuckLake/);
  assert.match(homer.current, /runtime evidence pending/);
  assert.match(homer.target, /11\.0\.297-ivekit\.1/);
  assert.ok(homer.gates.some((gate) => /Go 1\.26/.test(gate)));
});

test('technology baseline records controlled Valkey failover without claiming cutover', async () => {
  const baseline = JSON.parse(
    await readFile(
      'docs/architecture/communication-technology-baseline-v1.json',
      'utf8'
    )
  ) as { decisions: Array<{ id: string; current: string; rollout: string; gates: string[] }> };
  const valkey = baseline.decisions.find((decision) => decision.id === 'redis-to-valkey');

  assert.ok(valkey);
  assert.match(valkey.current, /controlled.*failover.*passed/i);
  assert.match(valkey.rollout, /controlled-failover-passed/);
  assert.ok(valkey.gates.some((gate) => /target Kubernetes.*not_run/i.test(gate)));
  assert.ok(valkey.gates.some((gate) => /LiveKit.*not_run/i.test(gate)));
});

test('technology baseline selects the exact rtpengine source without claiming runtime proof', async () => {
  const baseline = validateTechnologyBaseline(JSON.parse(
    await readFile(
      'docs/architecture/communication-technology-baseline-v1.json',
      'utf8'
    )
  ));
  const rtpengine = baseline.decisions.find((decision) => decision.id === 'rtpengine');

  assert.ok(rtpengine);
  assert.equal(rtpengine.action, 'add');
  assert.match(rtpengine.target, /506cfa74386a5373e40fca139a932917f22f0524/);
  assert.match(rtpengine.current, /benchmark not run/);
  assert.match(rtpengine.rollout, /implementation-not-run/);
});

test('old Wave 3 candidates remain outside the reset RTC and external-provider wave', async () => {
  const baseline = JSON.parse(
    await readFile(
      'docs/architecture/communication-technology-baseline-v1.json',
      'utf8'
    )
  ) as { decisions: Array<{ id: string; rollout: string }> };
  const decisions = new Map(
    baseline.decisions.map((decision) => [decision.id, decision])
  );
  const retiredWaveThree = [
    'paddleocr',
    'sherpa-onnx',
    'llm-serving',
    'clickhouse',
    'gateway-api-envoy',
    'cilium-hubble'
  ];

  for (const id of retiredWaveThree) {
    const decision = decisions.get(id);
    assert.ok(decision, `missing technology decision ${id}`);
    assert.doesNotMatch(
      decision.rollout,
      /wave-3/i,
      `${id} must not return to the reset Wave 3`
    );
  }

  assert.match(decisions.get('external-intelligence-providers')?.rollout ?? '', /wave-3/i);
  assert.match(decisions.get('realtime-voice-pipeline')?.rollout ?? '', /wave-3/i);
});

test('reset Wave 3 production defaults use dormant external providers, not self-hosted runtimes', async () => {
  const [rootEnv, productionEnv, compose, values, deployment] = await Promise.all([
    readFile('.env.example', 'utf8'),
    readFile('infra/env.example', 'utf8'),
    readFile('infra/docker-compose.production.yml', 'utf8'),
    readFile('infra/k8s/values.yaml', 'utf8'),
    readFile('infra/k8s/templates/opc-deployment.yaml', 'utf8')
  ]);

  for (const env of [rootEnv, productionEnv]) {
    assert.match(env, /^CONVERACT_OCR_PROVIDER_MODE=third_party$/m);
    assert.match(env, /^CONVERACT_ASR_PROVIDER_MODE=third_party$/m);
    assert.match(env, /^CONVERACT_QUALITY_REVIEW_PROVIDER_MODE=third_party$/m);
  }

  for (const variable of ['OCR', 'ASR', 'QUALITY_REVIEW']) {
    assert.match(
      compose,
      new RegExp(
        `CONVERACT_${variable}_PROVIDER_MODE: \\$\\{CONVERACT_${variable}_PROVIDER_MODE:-third_party\\}`
      )
    );
  }
  assert.match(values, /^  ocrProviderMode: third_party$/m);
  assert.match(values, /^  asrProviderMode: third_party$/m);
  assert.match(values, /^  providerMode: third_party$/m);
  assert.match(deployment, /ocrProviderMode \| default "third_party"/);
  assert.match(deployment, /asrProviderMode \| default "third_party"/);
  assert.match(deployment, /qualityReview\.providerMode \| default "third_party"/);
  assert.match(values, /attachmentProcessing:[\s\S]*?worker:\n\s+enabled: "0"/);
  assert.match(values, /qualityReview:[\s\S]*?worker:\n\s+enabled: "0"/);
});
