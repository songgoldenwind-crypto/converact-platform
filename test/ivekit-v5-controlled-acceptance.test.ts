import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadControlledAcceptancePackage } from '../scripts/ivekit-delivery-bundle.js';
import { runIveKitV5ControlledAcceptance } from '../scripts/ivekit-v5-controlled-acceptance.js';

test('V5 controlled acceptance binds shared domain events to a signed durable inbox flow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-v5-controlled-'));
  const sourceCommit = 'a'.repeat(40);
  try {
    const result = await runIveKitV5ControlledAcceptance({
      source_commit: sourceCommit,
      output_dir: root,
      generated_at: '2026-07-15T20:00:00.000Z'
    });
    const evidence = JSON.parse(readFileSync(result.evidence_file, 'utf8')) as any;
    assert.equal(evidence.foundation_version, 'V5');
    assert.equal(evidence.bridge_summary.projected, 7);
    assert.equal(evidence.webhook.duplicate_rejected, true);
    assert.equal(evidence.real_environment_evidence, false);
    assert.equal(Object.values(evidence.checks).every(Boolean), true);
    const loaded = loadControlledAcceptancePackage(root, sourceCommit);
    assert.equal(loaded.statuses.full_chain, 'passed');
    assert.equal(loaded.evidence[0].path, 'full-chain.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
