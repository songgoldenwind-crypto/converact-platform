import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  runConveractFabricProviderGovernanceAcceptance
} from '../scripts/converact-provider-governance-acceptance.js';

test('controlled Provider acceptance covers protocol and governance failure modes', async () => {
  const report = await runConveractFabricProviderGovernanceAcceptance();

  assert.equal(report.status, 'passed');
  assert.equal(report.verification_scope, 'controlled_provider_and_in_memory_governance');
  assert.equal(report.real_vendor_evidence, false);
  assert.deepEqual(report.checks.map((check) => check.name), [
    'success',
    'rate_limited_429',
    'transient_5xx',
    'timeout',
    'terminal_no_failover',
    'quota',
    'circuit_open',
    'half_open_recovery',
    'failover'
  ]);
  assert.equal(report.checks.every((check) => check.status === 'passed'), true);
  assert.doesNotMatch(
    JSON.stringify(report),
    /controlled-provider-token|private source|https?:\/\/|authorization|base_url/i
  );

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(
    pkg.scripts['converact:provider-governance-acceptance'],
    'node --import tsx scripts/converact-provider-governance-acceptance.ts'
  );
});
