import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  runVoiceMediaGoal1ControlledAcceptance
} from '../scripts/ivekit-voice-media-goal1-acceptance.js';

const SOURCE_COMMIT = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const CONFIG_HASH = `sha256:${'c'.repeat(64)}`;
const GENERATED_AT = '2026-07-25T12:00:00.000Z';

describe('iveKit voice media Goal 1 controlled acceptance', () => {
  it('writes bounded evidence for every Goal 1 failure and recovery invariant', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'ivekit-media-goal1-'));

    const result = await runVoiceMediaGoal1ControlledAcceptance({
      source_commit: SOURCE_COMMIT,
      image_digest: IMAGE_DIGEST,
      config_hash: CONFIG_HASH,
      generated_at: GENERATED_AT,
      output_dir: outputDir
    });
    const evidence = JSON.parse(readFileSync(result.evidence_file, 'utf8'));

    assert.equal(evidence.schema_version, 1);
    assert.equal(evidence.goal, 'voice-media-control-goal1');
    assert.equal(evidence.environment_class, 'controlled');
    assert.equal(evidence.capacity_claim, 'none');
    assert.equal(evidence.real_rtpengine_forwarding, false);
    assert.equal(evidence.source_commit, SOURCE_COMMIT);
    assert.equal(evidence.image_digest, IMAGE_DIGEST);
    assert.equal(evidence.config_hash, CONFIG_HASH);
    assert.equal(evidence.generated_at, GENERATED_AT);
    assert.equal(
      Object.values(evidence.checks).every((value) => value === true),
      true
    );
    assert.deepEqual(
      evidence.not_run.map((entry: { dependency: string }) => entry.dependency),
      [
        'rtpengine-wire-transport',
        'physical-media-quality',
        'physical-capacity'
      ]
    );
    assert.equal(evidence.observations.command_replay.prepare_side_effects, 1);
    assert.equal(evidence.observations.before_apply.prepare_side_effects, 1);
    assert.equal(evidence.observations.after_apply.prepare_side_effects, 1);
    assert.equal(evidence.observations.outage.forwarded_packets, 500);
    assert.equal(evidence.observations.lifecycle.expired_state, 'expired');
  });

  it('rejects incomplete deployment identity instead of producing ambiguous evidence', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'ivekit-media-goal1-'));

    await assert.rejects(
      runVoiceMediaGoal1ControlledAcceptance({
        source_commit: 'short',
        image_digest: IMAGE_DIGEST,
        config_hash: CONFIG_HASH,
        generated_at: GENERATED_AT,
        output_dir: outputDir
      }),
      /full source commit is required/
    );
  });
});
