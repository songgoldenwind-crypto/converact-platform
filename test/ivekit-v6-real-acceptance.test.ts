import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createIveKitV6RealAcceptanceTemplate,
  IVEKIT_V6_REAL_ACCEPTANCE_GROUPS,
  validateIveKitV6RealAcceptanceManifest,
  type IveKitV6RealAcceptanceManifest
} from '../scripts/ivekit-v6-real-acceptance.js';

const SOURCE_COMMIT = 'a'.repeat(40);
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`;

test('V6 template preserves the ordered eight-group matrix as honest not_run', () => {
  const manifest = createIveKitV6RealAcceptanceTemplate({
    source_commit: SOURCE_COMMIT,
    generated_at: '2026-07-16T09:00:00.000Z'
  });
  assert.deepEqual(manifest.groups.map((group) => group.id), IVEKIT_V6_REAL_ACCEPTANCE_GROUPS);
  assert.equal(manifest.groups.every((group) =>
    group.status === 'not_run' && group.run === null && group.checks.length === 0 &&
    group.reason.length > 30 && group.command.length > 20
  ), true);
  validateIveKitV6RealAcceptanceManifest(manifest, {
    base_dir: mkdtempSync(join(tmpdir(), 'ivekit-v6-real-template-')),
    expected_source_commit: SOURCE_COMMIT
  });
});

test('real passed evidence requires source, artifact, environment, run, and independent QA binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-v6-real-evidence-'));
  const manifest = createIveKitV6RealAcceptanceTemplate({
    source_commit: SOURCE_COMMIT,
    generated_at: '2026-07-16T09:00:00.000Z'
  });
  const path = 'evidence/providers/provider-health.json';
  mkdirSync(join(root, 'evidence/providers'), { recursive: true });
  const observation = {
    schema_version: 1,
    real_environment: true,
    controlled: false,
    redacted: true,
    group_id: 'providers',
    check_id: 'provider_health',
    source_commit: SOURCE_COMMIT,
    artifact_digest: ARTIFACT_DIGEST,
    run_id: 'run-provider-20260716',
    environment_id: 'led-staging-provider-1',
    observed_at: '2026-07-16T09:02:00.000Z',
    result: 'passed',
    data: { ocr: 'healthy', asr: 'healthy', translation: 'healthy', quality: 'healthy' }
  };
  const content = `${JSON.stringify(observation, null, 2)}\n`;
  writeFileSync(join(root, path), content);
  manifest.groups[0] = {
    ...manifest.groups[0]!,
    status: 'passed',
    reason_code: '',
    reason: '',
    run: {
      run_id: observation.run_id,
      environment_id: observation.environment_id,
      deployed_source_commit: SOURCE_COMMIT,
      artifact_digest: ARTIFACT_DIGEST,
      started_at: '2026-07-16T09:01:00.000Z',
      finished_at: '2026-07-16T09:03:00.000Z',
      operator: 'operator-li',
      qa_approver: 'qa-wang',
      redaction_confirmed: true
    },
    checks: [{
      id: observation.check_id,
      status: 'passed',
      observation_path: path,
      sha256: createHash('sha256').update(content).digest('hex'),
      size_bytes: Buffer.byteLength(content)
    }]
  };

  validateIveKitV6RealAcceptanceManifest(manifest, {
    base_dir: root,
    expected_source_commit: SOURCE_COMMIT
  });

  const sameApprover = structuredClone(manifest);
  sameApprover.groups[0]!.run!.qa_approver = 'operator-li';
  assert.throws(
    () => validateIveKitV6RealAcceptanceManifest(sameApprover, { base_dir: root }),
    /independent QA/
  );
  const controlled = structuredClone(observation);
  controlled.controlled = true;
  writeFileSync(join(root, path), `${JSON.stringify(controlled, null, 2)}\n`);
  assert.throws(
    () => validateIveKitV6RealAcceptanceManifest(manifest, { base_dir: root }),
    /checksum mismatch|binding mismatch/
  );
});

test('not_run cannot carry fabricated evidence or drifted commands', () => {
  const manifest = createIveKitV6RealAcceptanceTemplate({ source_commit: SOURCE_COMMIT });
  const fabricated = structuredClone(manifest) as IveKitV6RealAcceptanceManifest;
  fabricated.groups[3]!.checks = [{
    id: 'fake', status: 'passed', observation_path: 'evidence/rustdesk_windows/fake.json',
    sha256: 'c'.repeat(64), size_bytes: 1
  }];
  assert.throws(
    () => validateIveKitV6RealAcceptanceManifest(fabricated, {
      base_dir: mkdtempSync(join(tmpdir(), 'ivekit-v6-real-fake-'))
    }),
    /not_run acceptance group is incomplete/
  );
  const drifted = structuredClone(manifest) as IveKitV6RealAcceptanceManifest;
  drifted.groups[7]!.command = 'echo passed';
  assert.throws(
    () => validateIveKitV6RealAcceptanceManifest(drifted, {
      base_dir: mkdtempSync(join(tmpdir(), 'ivekit-v6-real-drift-'))
    }),
    /command drift/
  );
});
