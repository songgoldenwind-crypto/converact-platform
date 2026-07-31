import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runnerPath = new URL(
  '../infra/capacity/homer-maintenance/run.sh',
  import.meta.url
);
const senderPath = new URL(
  '../infra/capacity/homer-maintenance/send-hep3.py',
  import.meta.url
);
const evidencePath = new URL(
  '../docs/evidence/wave1-homer-retention-compaction-server-validation-2026-07-25.json',
  import.meta.url
);

test('HOMER maintenance runner isolates catalog data and proves retention', () => {
  const source = readFileSync(runnerPath, 'utf8');

  assert.match(source, /docker network create/);
  assert.match(source, /POSTGRES_IMAGE_ID/);
  assert.match(source, /HOMER_IMAGE_ID/);
  assert.match(source, /--timestamp-offset-seconds/);
  assert.match(source, /-3456000/);
  assert.match(source, /compaction-retention-days/);
  assert.match(source, /compaction-force/);
  assert.match(source, /compaction-expire-older-than/);
  assert.match(source, /old_rows_after/);
  assert.match(source, /fresh_rows_after/);
  assert.match(source, /idempotent/);
  assert.match(source, /secret-scan\.txt/);
  assert.match(source, /secret_scan_passed/);
  assert.match(source, /"\$EXPIRE_OLDER_THAN"/);
  assert.match(source, /trap cleanup EXIT INT TERM/);
  assert.match(source, /sensitive_inputs_removed/);
  assert.match(source, /capacity_claim/);
  assert.match(source, /controlled_server_isolated_catalog/);
  assert.doesNotMatch(source, /ivekit-rustpbx-baseline/);
});

test('HOMER maintenance runner removes credentials and validates bounded input', () => {
  const source = readFileSync(runnerPath, 'utf8');

  assert.match(source, /chmod 600/);
  assert.match(source, /rm -f.*postgres\.env.*homer\.env/s);
  assert.match(source, /sanitize_artifacts/);
  assert.match(source, /bounded_integer RETENTION_DAYS/);
  assert.match(source, /bounded_integer OLD_PACKET_COUNT/);
  assert.match(source, /bounded_integer FRESH_PACKET_COUNT/);
  assert.match(source, /docker inspect.*Image/s);
  assert.match(source, /docker ps.*label=ivekit\.validation/s);
});

test('HEPv3 fixture self-test validates timestamp and correlation chunks', () => {
  const output = execFileSync(
    'python3',
    [senderPath.pathname, '--self-test'],
    { encoding: 'utf8' }
  ).trim();

  assert.equal(output, 'HEPv3 self-test passed');
});

test('HOMER maintenance evidence is source-bound and preserves only current rows', () => {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    status: string;
    capacity_claim: string;
    production_capacity_evidence: boolean;
    source: { runner_sha256: string; hep_sender_sha256: string; homer_image_id: string };
    rows: Record<string, number>;
    checks: Record<string, boolean>;
    test_resources_remaining: number;
  };
  const digest = (path: URL) =>
    createHash('sha256').update(readFileSync(path)).digest('hex');

  assert.equal(evidence.status, 'controlled_pass');
  assert.equal(evidence.capacity_claim, 'none');
  assert.equal(evidence.production_capacity_evidence, false);
  assert.equal(evidence.source.runner_sha256, digest(runnerPath));
  assert.equal(evidence.source.hep_sender_sha256, digest(senderPath));
  assert.equal(
    evidence.source.homer_image_id,
    'sha256:d062461067849bbec3d4b84473f309d7e3b216bb29284d4124fc9960f361e389'
  );
  assert.deepEqual(evidence.rows, {
    fresh_after: 200,
    fresh_after_idempotent: 200,
    fresh_before: 200,
    old_after: 0,
    old_after_idempotent: 0,
    old_before: 200
  });
  assert.equal(Object.values(evidence.checks).every(Boolean), true);
  assert.equal(evidence.test_resources_remaining, 0);
});
