import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(path, 'utf8');

test('standalone image and package expose guarded backup and restore operations', () => {
  const dockerfile = read('services/ivekit-service/Dockerfile');
  const packageJson = JSON.parse(read('services/ivekit-service/package.json'));
  const compose = read('services/ivekit-service/docker-compose.yml');
  assert.match(dockerfile, /postgresql-client/);
  assert.equal(packageJson.scripts.backup, 'node dist/ivekit-backup.js');
  assert.equal(packageJson.scripts.restore, 'node dist/ivekit-restore.js');
  assert.match(compose, /profiles: \["operations"\]/);
  assert.match(compose, /dist\/ivekit-backup\.js/);
  assert.match(compose, /OPC_IVEKIT_BACKUP_HOST_DIR/);
});

test('Helm supports autoscaling, failure-domain spread, graceful termination and serialized backups', () => {
  const values = read('services/ivekit-service/helm/ivekit/values.yaml');
  const deployment = read('services/ivekit-service/helm/ivekit/templates/deployment.yaml');
  const hpa = read('services/ivekit-service/helm/ivekit/templates/hpa.yaml');
  const backup = read('services/ivekit-service/helm/ivekit/templates/backup-cronjob.yaml');
  assert.match(values, /autoscaling:\n  enabled: false\n  minReplicas: 2/);
  assert.match(deployment, /topologySpreadConstraints:/);
  assert.match(deployment, /terminationGracePeriodSeconds:/);
  assert.match(deployment, /preStop:/);
  assert.match(hpa, /apiVersion: autoscaling\/v2/);
  assert.match(hpa, /stabilizationWindowSeconds: 300/);
  assert.match(backup, /kind: CronJob/);
  assert.match(backup, /concurrencyPolicy:/);
  assert.match(backup, /adminDatabaseUrlKey/);
  assert.match(backup, /backup\.persistence\.existingClaim is required/);
});

test('backup runbook preserves dry-run default and names external secret recovery boundary', () => {
  const runbook = read('docs/ivekit-backup-restore-runbook.md');
  assert.match(runbook, /恢复默认只校验备份/);
  assert.match(runbook, /RESTORE:<backup-id>/);
  assert.match(runbook, /RustDesk `id_ed25519` 私钥/);
  assert.match(runbook, /任一目标非空时，在第一个 `pg_restore` 前整体终止/);
  assert.match(runbook, /真实 OCR\/ASR\/翻译供应商效果/);
});
