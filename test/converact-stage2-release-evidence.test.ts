import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConveractFabricStage2ReleaseEvidence,
  validateConveractFabricStage2ReleaseEvidence
} from '../scripts/converact-stage2-release-evidence.js';

const sourceCommit = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;

function input() {
  return {
    sourceCommit,
    generatedAt: '2026-07-15T00:00:00.000Z',
    imageDigest,
    migrations: [
      { file: '061_ivekit_file_security.sql', sha256: '1'.repeat(64) },
      { file: '062_tinode_file_delivery_operations.sql', sha256: '2'.repeat(64) },
      { file: '063_livekit_media_quality.sql', sha256: '3'.repeat(64) }
    ],
    configurationArtifacts: [
      { profile: 'livekit_turn' as const, path: 'deploy/livekit/env.example', sha256: '4'.repeat(64) },
      { profile: 'livekit_turn' as const, path: 'deploy/livekit/docker-compose.yml', sha256: '5'.repeat(64) },
      { profile: 'livekit_egress' as const, path: 'deploy/livekit/docker-compose.yml', sha256: '5'.repeat(64) },
      { profile: 'livekit_egress' as const, path: 'deploy/livekit/docker-compose.storage.yml', sha256: '6'.repeat(64) },
      { profile: 'file_security' as const, path: 'deploy/application/docker-compose.yml', sha256: '7'.repeat(64) },
      { profile: 'file_security' as const, path: 'deploy/kubernetes/converact/templates/clamav.yaml', sha256: '8'.repeat(64) }
    ]
  };
}

test('stage 2 release evidence binds source, image, required migrations, and configuration profiles', () => {
  const evidence = createConveractFabricStage2ReleaseEvidence(input());

  assert.equal(evidence.source_commit, sourceCommit);
  assert.equal(evidence.application_image_digest, imageDigest);
  assert.deepEqual(evidence.required_migrations.map((entry) => entry.file), [
    '061_ivekit_file_security.sql',
    '062_tinode_file_delivery_operations.sql',
    '063_livekit_media_quality.sql'
  ]);
  assert.deepEqual(Object.keys(evidence.configuration_template_fingerprints), [
    'livekit_turn',
    'livekit_egress',
    'file_security'
  ]);
  assert.match(evidence.release_fingerprint_sha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.secret_values_embedded, false);
  assert.equal(evidence.real_environment_validation, 'not_run');
  assert.doesNotThrow(() => validateConveractFabricStage2ReleaseEvidence(evidence));
});

test('stage 2 release evidence rejects missing migrations and tampering', () => {
  assert.throws(
    () => createConveractFabricStage2ReleaseEvidence({ ...input(), migrations: input().migrations.slice(0, 2) }),
    /063_livekit_media_quality/
  );

  const evidence = createConveractFabricStage2ReleaseEvidence(input());
  assert.throws(
    () => validateConveractFabricStage2ReleaseEvidence({
      ...evidence,
      configuration_template_fingerprints: {
        ...evidence.configuration_template_fingerprints,
        file_security: {
          ...evidence.configuration_template_fingerprints.file_security,
          fingerprint_sha256: 'f'.repeat(64)
        }
      }
    }),
    /fingerprint/i
  );
});
