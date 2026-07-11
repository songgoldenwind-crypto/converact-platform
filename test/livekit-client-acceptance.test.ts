import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS,
  LIVEKIT_ACCEPTANCE_DETAIL_REQUIREMENTS,
  createLiveKitClientAcceptanceTemplate,
  renderLiveKitClientAcceptanceRunbook,
  runLiveKitClientAcceptance,
  validateLiveKitClientAcceptancePaths,
  writeLiveKitClientAcceptanceTemplate
} from '../scripts/livekit-client-acceptance.js';

test('LiveKit client acceptance passes a complete real-environment report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-pass-'));
  const reportFile = join(dir, 'report.json');
  const outputFile = join(dir, 'result.json');
  try {
    writeFileSync(reportFile, `${JSON.stringify(completeReport(dir), null, 2)}\n`);
    const result = runLiveKitClientAcceptance(validatorConfig(dir, reportFile, outputFile));

    assert.equal(result.ok, true);
    assert.equal(result.environment_id, 'led-staging-sfo2');
    assert.equal(result.summary.required_checks, LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS.length);
    assert.equal(result.summary.passed_checks, LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS.length);
    assert.equal(result.summary.failed, 0);
    assert.deepEqual(result.failures, []);
    assert.equal(JSON.parse(readFileSync(outputFile, 'utf8')).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance rejects missing failed empty placeholder and secret evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-evidence-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    delete report.checks.network.ice_tcp_fallback;
    report.checks.media.two_browser_audio = { passed: false, evidence: 'audio missing' };
    report.checks.media.two_browser_video = { passed: true, evidence: '' };
    report.checks.media.screen_share = { passed: true, evidence: 'replace-with-screen-evidence' };
    report.checks.media.customer_browser_join = {
      passed: true,
      evidence: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature'
    };
    writeFileSync(reportFile, `${JSON.stringify(report)}\n`);

    const result = runLiveKitClientAcceptance(validatorConfig(dir, reportFile));
    assert.equal(result.ok, false);
    for (const id of [
      'network.ice_tcp_fallback',
      'media.two_browser_audio',
      'media.two_browser_video',
      'media.screen_share',
      'media.customer_browser_join'
    ]) {
      assert.equal(result.failures.some((failure) => failure.id === id), true, id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance rejects non-real sources invalid identity and unmet performance targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-invalid-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    report.source = 'local_fake';
    report.environment_id = 'replace-with-environment-id';
    report.deployed_commit = 'short-sha';
    report.checked_at = 'not-a-date';
    report.versions.server = '';
    report.performance.observed_concurrent_rooms = 4;
    report.performance.target_concurrent_rooms = 5;
    report.performance.join_p95_ms = 1800;
    report.performance.target_max_join_p95_ms = 1500;
    report.performance.packet_loss_pct = 3;
    report.performance.target_max_packet_loss_pct = 1;
    report.performance.passed = false;
    writeFileSync(reportFile, `${JSON.stringify(report)}\n`);

    const result = runLiveKitClientAcceptance(validatorConfig(dir, reportFile));
    assert.equal(result.ok, false);
    for (const id of [
      'report.source',
      'report.environment_id',
      'report.deployed_commit',
      'report.checked_at',
      'versions.server',
      'performance.observed_concurrent_rooms',
      'performance.join_p95_ms',
      'performance.packet_loss_pct',
      'performance.passed'
    ]) {
      assert.equal(result.failures.some((failure) => failure.id === id), true, id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance rejects generic prose and recursively scans report secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-forgery-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    report.checks.network.ice_udp_selected.evidence = 'Captured real environment evidence in artifact EV-123';
    report.notes = {
      hidden: 'LIVEKIT_API_SECRET=must-not-appear',
      cookie: 'Cookie: session=must-not-appear'
    };
    writeFileSync(reportFile, `${JSON.stringify(report)}\n`);

    const result = runLiveKitClientAcceptance(validatorConfig(dir, reportFile));
    assert.equal(result.ok, false);
    assert.equal(result.failures.some((failure) => failure.id === 'network.ice_udp_selected'), true);
    assert.equal(result.failures.some((failure) => failure.id === 'report.secret_scan'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance rejects invalid evidence hashes and zero join latency targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-hash-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    report.checks.media.screen_share.evidence.sha256 = '0'.repeat(64);
    report.performance.target_max_join_p95_ms = 0;
    report.performance.join_p95_ms = 0;
    writeFileSync(reportFile, `${JSON.stringify(report)}\n`);

    const result = runLiveKitClientAcceptance(validatorConfig(dir, reportFile));
    assert.equal(result.ok, false);
    assert.equal(result.failures.some((failure) => failure.id === 'media.screen_share'), true);
    assert.equal(result.failures.some((failure) => failure.id === 'performance.target_max_join_p95_ms'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance rejects invalid QA signatures and secrets inside JSON evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-signature-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    report.qa_attestation.signature_base64 = Buffer.alloc(64).toString('base64');
    const evidenceRef = report.checks.network.ice_udp_selected.evidence;
    const evidenceDocument = JSON.parse(readFileSync(evidenceRef.artifact_file, 'utf8')) as any;
    evidenceDocument.details.OPC_MEDIA_API_TOKEN = 'must-not-appear';
    const content = `${JSON.stringify(evidenceDocument, null, 2)}\n`;
    writeFileSync(evidenceRef.artifact_file, content);
    const updatedHash = createHash('sha256').update(content).digest('hex');
    for (const checkId of LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS) {
      readPath(report.checks, checkId).evidence.sha256 = updatedHash;
    }
    report.performance.evidence.sha256 = updatedHash;
    writeFileSync(reportFile, `${JSON.stringify(report)}\n`);

    const result = runLiveKitClientAcceptance(validatorConfig(dir, reportFile));
    assert.equal(result.ok, false);
    assert.equal(result.failures.some((failure) => failure.id === 'qa_attestation.signature'), true);
    assert.equal(result.failures.some((failure) => failure.reason.includes('credential-like')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance rejects generic details duplicate artifacts and untrusted QA keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-details-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    const first = report.checks.deployment.media_workloads_healthy.evidence;
    const artifactDocument = JSON.parse(readFileSync(first.artifact_file, 'utf8')) as any;
    artifactDocument.details = { ok: true };
    const content = `${JSON.stringify(artifactDocument, null, 2)}\n`;
    writeFileSync(first.artifact_file, content);
    first.sha256 = createHash('sha256').update(content).digest('hex');
    report.checks.deployment.versions_match.evidence = first;
    writeFileSync(reportFile, `${JSON.stringify(report)}\n`);
    const config = validatorConfig(dir, reportFile);
    config.qaPublicKeyFingerprint = '0'.repeat(64);

    const result = runLiveKitClientAcceptance(config);
    assert.equal(result.ok, false);
    assert.equal(result.failures.some((failure) => failure.id === 'deployment.media_workloads_healthy' && failure.reason.includes('details')), true);
    assert.equal(result.failures.some((failure) => failure.id === 'deployment.versions_match'), true);
    assert.equal(result.failures.some((failure) => failure.id === 'qa_attestation.public_key'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance rejects colliding template report and output paths', () => {
  assert.throws(
    () => validateLiveKitClientAcceptancePaths('/tmp/report.json', '/tmp/report.json', undefined),
    /template and report files must differ/
  );
  assert.throws(
    () => validateLiveKitClientAcceptancePaths(undefined, '/tmp/report.json', '/tmp/report.json'),
    /report and output files must differ/
  );
});

test('LiveKit client acceptance template is intentionally incomplete and covers every required check', () => {
  const template = createLiveKitClientAcceptanceTemplate({
    environmentId: 'replace-with-environment-id',
    deploymentMode: 'standalone-vm',
    deployedCommit: 'replace-with-40-char-git-sha',
    operator: 'replace-with-operator',
    checkedAt: '',
    runId: 'replace-with-run-id',
    deploymentFingerprint: 'replace-with-deployment-fingerprint',
    runStartedAt: ''
  }) as any;

  assert.equal(template.source, 'real_environment');
  for (const checkId of LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS) {
    const check = readPath(template.checks, checkId);
    assert.equal(check?.passed, false, checkId);
    assert.equal(typeof check?.evidence, 'object');
    assert.match(check?.evidence?.artifact_file || '', /replace-with/);
  }
  assert.equal(template.performance.passed, false);
});

test('LiveKit client acceptance writes its template and runbook documents every evidence group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-client-acceptance-template-'));
  const templateFile = join(dir, 'template.json');
  try {
    const write = writeLiveKitClientAcceptanceTemplate({
      templateFile,
      environmentId: 'replace-with-environment-id',
      deploymentMode: 'standalone-vm',
      deployedCommit: 'replace-with-40-char-git-sha',
      operator: 'replace-with-operator',
      checkedAt: '',
      runId: 'replace-with-run-id',
      deploymentFingerprint: 'replace-with-deployment-fingerprint',
      runStartedAt: ''
    });
    const runbook = renderLiveKitClientAcceptanceRunbook();

    assert.equal(write.templateFile, templateFile);
    assert.equal(JSON.parse(readFileSync(templateFile, 'utf8')).schema_version, 1);
    for (const heading of [
      'Deployment',
      'Network And ICE',
      'Media',
      'Recording',
      'Lifecycle And Isolation',
      'LED Integration',
      'Resilience And Performance',
      'SIP',
      'Final Evidence'
    ]) {
      assert.match(runbook, new RegExp(`## ${heading}`));
    }
    assert.match(runbook, /npm run livekit:evidence-pack/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit client acceptance is exposed through package scripts', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['livekit:client-acceptance'], 'tsx scripts/livekit-client-acceptance.ts');
});

function completeReport(dir: string): Record<string, unknown> {
  const runId = 'lk-run-20260711-001';
  const environmentId = 'led-staging-sfo2';
  const deployedCommit = 'a'.repeat(40);
  const deploymentFingerprint = 'b'.repeat(64);
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const capturedAt = new Date(Date.now() - 90_000).toISOString();
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const signedAt = new Date(Date.now() - 30_000).toISOString();
  const context = { runId, environmentId, deployedCommit, deploymentFingerprint, startedAt };
  const qaArtifactFile = join(dir, 'qa-attestation.json');
  const checks: Record<string, unknown> = {};
  const evidenceHashes: string[] = [];
  for (const [index, checkId] of LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS.entries()) {
    const evidence = writeEvidenceArtifact(dir, `check-${index + 1}.json`, checkId, context, capturedAt);
    evidenceHashes.push(evidence.sha256);
    writePath(checks, checkId, { passed: true, evidence });
  }
  const performanceEvidence = writeEvidenceArtifact(dir, 'performance.json', 'performance', context, capturedAt);
  evidenceHashes.push(performanceEvidence.sha256);
  writeFileSync(join(dir, 'preflight.json'), '{"kind":"preflight"}\n');
  writeFileSync(join(dir, 'server-evidence.json'), '{"kind":"server"}\n');
  writeFileSync(join(dir, 'readiness.json'), '{"kind":"readiness"}\n');
  const reportPayload = {
    schema_version: 1,
    source: 'real_environment',
    run_id: runId,
    run_started_at: startedAt,
    environment_id: environmentId,
    deployment_mode: 'standalone-vm',
    deployed_commit: deployedCommit,
    deployment_fingerprint: deploymentFingerprint,
    operator: 'qa@example.com',
    checked_at: checkedAt,
    versions: {
      server: 'v1.13.3',
      egress: 'v1.13.0',
      sip: 'v1.6.0',
      redis: '7.4.9',
      edge: 'caddyl4:v2.11.3'
    },
    checks,
    performance: {
      target_concurrent_rooms: 5,
      observed_concurrent_rooms: 5,
      target_participants_per_room: 4,
      observed_participants_per_room: 4,
      target_max_join_p95_ms: 1500,
      join_p95_ms: 900,
      target_max_packet_loss_pct: 1,
      packet_loss_pct: 0.2,
      target_max_error_rate_pct: 1,
      error_rate_pct: 0,
      passed: true,
      evidence: performanceEvidence
    }
  };
  const qaArtifactDocument = {
    schema_version: 1,
    kind: 'livekit_qa_attestation',
    run_id: runId,
    environment_id: environmentId,
    deployed_commit: deployedCommit,
    deployment_fingerprint: deploymentFingerprint,
    deployment_mode: 'standalone-vm',
    run_started_at: startedAt,
    captured_at: signedAt,
    tool: 'qa-ed25519',
    approver: 'qa-approver@example.com',
    signed_at: signedAt,
    decision: 'approved_for_customer_review',
    inputs: {
      preflight_report_sha256: fileSha(join(dir, 'preflight.json')),
      server_evidence_sha256: fileSha(join(dir, 'server-evidence.json')),
      readiness_report_sha256: fileSha(join(dir, 'readiness.json')),
      client_evidence_sha256: evidenceHashes.sort(),
      client_report_payload_sha256: canonicalSha(reportPayload)
    }
  };
  const qaContent = Buffer.from(`${JSON.stringify(qaArtifactDocument, null, 2)}\n`);
  writeFileSync(qaArtifactFile, qaContent);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(dir, 'qa-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const qaEvidence = {
    artifact_file: qaArtifactFile,
    sha256: createHash('sha256').update(qaContent).digest('hex'),
    captured_at: signedAt,
    tool: 'qa-ed25519',
    run_id: runId
  };
  return {
    ...reportPayload,
    qa_attestation: {
      approver: 'qa-approver@example.com',
      signed_at: signedAt,
      evidence: qaEvidence,
      signature_base64: sign(null, qaContent, privateKey).toString('base64')
    }
  };
}

function writeEvidenceArtifact(
  dir: string,
  filename: string,
  checkId: string,
  context: {
    runId: string;
    environmentId: string;
    deployedCommit: string;
    deploymentFingerprint: string;
    startedAt: string;
  },
  capturedAt: string
): { artifact_file: string; sha256: string; captured_at: string; tool: string; run_id: string } {
  const artifactFile = join(dir, filename);
  const document = {
    schema_version: 1,
    kind: 'livekit_acceptance_evidence',
    run_id: context.runId,
    environment_id: context.environmentId,
    deployed_commit: context.deployedCommit,
    deployment_fingerprint: context.deploymentFingerprint,
    deployment_mode: 'standalone-vm',
    run_started_at: context.startedAt,
    captured_at: capturedAt,
    tool: 'playwright-webrtc-internals',
    check_id: checkId,
    details: detailFixture(checkId)
  };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(artifactFile, content);
  return {
    artifact_file: artifactFile,
    sha256: createHash('sha256').update(content).digest('hex'),
    captured_at: capturedAt,
    tool: 'playwright-webrtc-internals',
    run_id: context.runId
  };
}

function detailFixture(checkId: string): Record<string, unknown> {
  const details = Object.fromEntries(
    (LIVEKIT_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId] || []).map((key) => [key, detailValue(key)])
  );
  if (checkId === 'network.ice_udp_selected') Object.assign(details, { transport: 'udp', candidate_type: 'srflx' });
  if (checkId === 'network.ice_tcp_fallback') Object.assign(details, { transport: 'tcp', candidate_type: 'host' });
  if (checkId === 'network.turn_udp_forced_relay') Object.assign(details, { transport: 'udp', candidate_type: 'relay' });
  if (checkId === 'network.turn_tls_forced_relay') Object.assign(details, { transport: 'tls', candidate_type: 'relay' });
  if (checkId === 'recording.egress_completed') details.status = 'complete';
  return details;
}

function detailValue(key: string): unknown {
  if (/(participants|workloads|replicas|reconnected)/.test(key)) return ['observed-value'];
  if (/(size_bytes|count|rooms)$/.test(key)) return 1;
  if (key.includes('versions')) return { server: 'v1.13.3' };
  return `observed-${key}`;
}

function fileSha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function canonicalSha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validatorConfig(dir: string, reportFile: string, outputFile?: string) {
  const publicKey = readFileSync(join(dir, 'qa-public.pem'), 'utf8');
  return {
    reportFile,
    ...(outputFile ? { outputFile } : {}),
    qaPublicKeyFile: join(dir, 'qa-public.pem'),
    qaPublicKeyFingerprint: createHash('sha256').update(publicKey).digest('hex'),
    preflightReportFile: join(dir, 'preflight.json'),
    serverEvidenceFile: join(dir, 'server-evidence.json'),
    readinessReportFile: join(dir, 'readiness.json')
  };
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ||= {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

function readPath(target: Record<string, unknown>, path: string): any {
  return path.split('.').reduce<any>((current, part) => current?.[part], target);
}
