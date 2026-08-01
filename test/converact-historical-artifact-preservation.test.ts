import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const freezeCommit = '532350f34c9191092f62d9a1e89287de06f6c083';

const immutableHistoricalArtifacts = [
  {
    source: 'docs/ivekit-v3-completion-audit.md',
    target: 'docs/converact-fabric-v3-completion-audit.md',
  },
  {
    source: 'docs/ivekit-voice-foundation-v1-design.md',
    target: 'docs/converact-fabric-voice-foundation-v1-design.md',
  },
  {
    source: 'docs/design/2026-07-25-ivekit-voice-media-control-goal1-implementation-plan.md',
    target: 'docs/design/2026-07-25-converact-fabric-voice-media-control-goal1-implementation-plan.md',
  },
  {
    source: 'docs/design/2026-07-26-ivekit-rtpengine-goal2-implementation-plan.md',
    target: 'docs/design/2026-07-26-converact-fabric-rtpengine-goal2-implementation-plan.md',
  },
  {
    source: 'docs/design/2026-07-26-ivekit-rustpbx-rtpengine-goal3-implementation-plan.md',
    target: 'docs/design/2026-07-26-converact-fabric-rustpbx-rtpengine-goal3-implementation-plan.md',
  },
  {
    source: 'docs/superpowers/specs/2026-07-11-ivekit-production-bootstrap-design.md',
    target: 'docs/superpowers/specs/2026-07-11-ivekit-production-bootstrap-design.md',
  },
] as const;

test('renamed historical artifacts preserve their frozen bytes', () => {
  for (const artifact of immutableHistoricalArtifacts) {
    const frozen = execFileSync('git', [
      'show',
      `${freezeCommit}:${artifact.source}`,
    ]);
    assert.deepEqual(
      readFileSync(artifact.target),
      frozen,
      `${artifact.target} rewrites frozen historical content`,
    );
  }
});
