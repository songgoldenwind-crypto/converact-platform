import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS,
  VOICE_REQUIRED_ACCEPTANCE_CHECKS,
  createIveKitVoiceAcceptanceTemplate,
  renderIveKitVoiceAcceptanceRunbook,
  runIveKitVoiceAcceptance,
  runIveKitVoiceAcceptanceFromEnv,
  writeIveKitVoiceAcceptanceTemplate
} from '../scripts/ivekit-voice-acceptance.js';

test('Voice acceptance passes a complete source-bound real environment report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ivekit-voice-acceptance-'));
  try {
    const reportFile = join(dir, 'report.json');
    writeFileSync(reportFile, `${JSON.stringify(completeReport(dir), null, 2)}\n`);

    const result = runIveKitVoiceAcceptance({ reportFile });

    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.status, 'ready_for_review');
    assert.equal(result.summary.required_checks, VOICE_REQUIRED_ACCEPTANCE_CHECKS.length);
    assert.equal(result.summary.passed_checks, VOICE_REQUIRED_ACCEPTANCE_CHECKS.length);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.real_environment_evidence, true);
    assert.equal(result.automatically_updates_delivery_acceptance, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Voice acceptance template is incomplete and covers every required data-plane check', () => {
  const template = createIveKitVoiceAcceptanceTemplate({
    runId: 'voice-run-template',
    environmentId: 'voice-staging',
    deploymentMode: 'standalone-helm',
    deployedCommit: 'a'.repeat(40),
    deploymentFingerprint: 'b'.repeat(64),
    operator: 'operator-1',
    qaApprover: 'qa-1',
    runStartedAt: '2026-07-14T00:00:00.000Z',
    checkedAt: '2026-07-14T00:20:00.000Z'
  }) as { checks: Record<string, { passed: boolean; evidence: { artifact_file: string } }> };

  assert.ok(VOICE_REQUIRED_ACCEPTANCE_CHECKS.length >= 40);
  assert.deepEqual(Object.keys(template.checks), [...VOICE_REQUIRED_ACCEPTANCE_CHECKS]);
  for (const checkId of VOICE_REQUIRED_ACCEPTANCE_CHECKS) {
    assert.equal(template.checks[checkId]?.passed, false, checkId);
    assert.match(template.checks[checkId]?.evidence.artifact_file || '', /^evidence\//);
    assert.ok((VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId] || []).length >= 2, checkId);
  }
});

test('Voice acceptance writes a template and a runbook for every capability group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ivekit-voice-template-'));
  try {
    const templateFile = join(dir, 'voice-template.json');
    const result = writeIveKitVoiceAcceptanceTemplate({
      templateFile,
      runId: 'voice-run-template',
      environmentId: 'voice-staging',
      deploymentMode: 'standalone-compose',
      deployedCommit: 'a'.repeat(40),
      deploymentFingerprint: 'b'.repeat(64),
      operator: 'operator-1',
      qaApprover: 'qa-1',
      runStartedAt: '2026-07-14T00:00:00.000Z',
      checkedAt: '2026-07-14T00:20:00.000Z'
    });
    const runbook = renderIveKitVoiceAcceptanceRunbook();

    assert.equal(result.checks, VOICE_REQUIRED_ACCEPTANCE_CHECKS.length);
    assert.equal(JSON.parse(readFileSync(templateFile, 'utf8')).source, 'real_voice_environment');
    for (const heading of [
      'Deployment', 'SIP And PSTN', 'WebPhone And RTP', 'Call Control', 'Recording',
      'IVR', 'Realtime Voice AI', 'LiveKit SIP Bridge', 'Contact Center',
      'Resilience And Isolation', 'Performance And Governance', 'Validation'
    ]) assert.match(runbook, new RegExp(`## ${heading}`));
    assert.match(runbook, /OPC_IVEKIT_VOICE_ACCEPTANCE_REPORT_FILE/);
    assert.match(runbook, /ready_for_review/);
    assert.match(runbook, /does not change.*not_run/is);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Voice acceptance rejects controlled evidence and missing real observations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ivekit-voice-controlled-'));
  try {
    const report = completeReport(dir);
    const checkId = 'webphone.bidirectional_rtp_audio';
    const evidence = report.checks[checkId].evidence;
    const artifact = join(dir, evidence.artifact_file);
    const document = JSON.parse(readFileSync(artifact, 'utf8'));
    document.source = 'controlled_e2e';
    document.tool = 'Playwright mock WebRTC engine';
    writeFileSync(artifact, `${JSON.stringify(document, null, 2)}\n`);
    evidence.sha256 = sha256(artifact);
    evidence.tool = document.tool;
    const reportFile = join(dir, 'report.json');
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    const result = runIveKitVoiceAcceptance({ reportFile });

    assert.equal(result.ok, false);
    assert.equal(result.failures.some((failure) => failure.id === checkId), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Voice acceptance rejects incomplete, duplicated, secret-bearing, or escaped evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ivekit-voice-invalid-'));
  try {
    const report = completeReport(dir);
    const incompleteId = 'recording.object_checksum_playback';
    const incomplete = report.checks[incompleteId].evidence;
    const incompleteFile = join(dir, incomplete.artifact_file);
    const document = JSON.parse(readFileSync(incompleteFile, 'utf8'));
    delete document.observation.object_sha256;
    document.observation.authorization = 'Bearer secret-token-value-that-must-not-ship';
    writeFileSync(incompleteFile, `${JSON.stringify(document, null, 2)}\n`);
    incomplete.sha256 = sha256(incompleteFile);

    report.checks['control.hold_resume'].evidence = {
      ...report.checks['control.dtmf'].evidence
    };
    report.checks['deployment.rustpbx_health_preflight'].evidence.artifact_file = '../outside.json';
    const reportFile = join(dir, 'report.json');
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    const result = runIveKitVoiceAcceptance({ reportFile });
    const ids = result.failures.map((failure) => failure.id);

    assert.equal(result.ok, false);
    assert.ok(ids.includes(incompleteId));
    assert.ok(ids.includes('control.hold_resume'));
    assert.ok(ids.includes('deployment.rustpbx_health_preflight'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Voice acceptance rejects an evidence directory symlink that escapes the report root', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-voice-parent-symlink-'));
  const reportDir = join(root, 'report');
  mkdirSync(reportDir);
  try {
    const report = completeReport(reportDir);
    const externalEvidence = join(root, 'external-evidence');
    renameSync(join(reportDir, 'evidence'), externalEvidence);
    symlinkSync(externalEvidence, join(reportDir, 'evidence'), 'dir');
    const reportFile = join(reportDir, 'report.json');
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    const result = runIveKitVoiceAcceptance({ reportFile });

    assert.equal(result.ok, false);
    assert.equal(result.failures.some((failure) =>
      failure.reason === 'evidence real path must remain inside the report directory'
    ), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Voice acceptance enforces capability, performance, source, and QA semantics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ivekit-voice-semantics-'));
  try {
    const report = completeReport(dir);
    mutateObservation(dir, report, 'deployment.image_and_source_binding', (observation) => {
      observation.source_commit = 'f'.repeat(40);
    });
    mutateObservation(dir, report, 'control.unsupported_actions_fail_closed', (observation) => {
      observation.actions = ['park'];
      observation.http_status_code = 200;
    });
    mutateObservation(dir, report, 'performance.call_setup_and_concurrency', (observation) => {
      observation.concurrent_calls = 0;
      observation.error_rate_pct = 101;
    });
    mutateObservation(dir, report, 'governance.independent_qa_review', (observation) => {
      observation.qa_approver = 'someone-else';
      observation.redaction_reviewed = false;
    });
    const reportFile = join(dir, 'report.json');
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    const result = runIveKitVoiceAcceptance({ reportFile });
    const ids = new Set(result.failures.map((failure) => failure.id));

    assert.ok(ids.has('deployment.image_and_source_binding'));
    assert.ok(ids.has('control.unsupported_actions_fail_closed'));
    assert.ok(ids.has('performance.call_setup_and_concurrency'));
    assert.ok(ids.has('governance.independent_qa_review'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Voice acceptance reports not_run without a real report', () => {
  assert.deepEqual(runIveKitVoiceAcceptanceFromEnv({}), {
    ok: false,
    status: 'not_run',
    missing_environment: ['OPC_IVEKIT_VOICE_ACCEPTANCE_REPORT_FILE']
  });
});

function completeReport(dir: string) {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const capturedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const runStartedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const context = {
    run_id: 'voice-run-20260714',
    environment_id: 'voice-staging-sfo2',
    deployed_commit: 'a'.repeat(40),
    deployment_fingerprint: 'b'.repeat(64),
    captured_at: capturedAt,
    operator: 'voice-operator-1'
  };
  const checks = Object.fromEntries(VOICE_REQUIRED_ACCEPTANCE_CHECKS.map((checkId) => [
    checkId,
    {
      passed: true,
      evidence: writeEvidence(dir, checkId, context)
    }
  ])) as Record<string, { passed: boolean; evidence: ReturnType<typeof writeEvidence> }>;
  return {
    schema_version: 1,
    source: 'real_voice_environment',
    status: 'completed',
    run_id: context.run_id,
    run_started_at: runStartedAt,
    environment_id: context.environment_id,
    deployment_mode: 'standalone-helm',
    deployed_commit: context.deployed_commit,
    deployment_fingerprint: context.deployment_fingerprint,
    operator: context.operator,
    qa_approver: 'voice-qa-1',
    checked_at: checkedAt,
    versions: {
      ivekit_image: `registry.voice.internal/ivekit/service@sha256:${'c'.repeat(64)}`,
      rustpbx_image: `ghcr.io/songgoldenwind-crypto/opc-rustpbx@sha256:${'d'.repeat(64)}`,
      rustpbx: '0.4.11',
      postgres: '16.14',
      livekit_sip: '1.6.0',
      browser: 'Chrome 140.0.0',
      sip_test_tool: 'SIPp 3.7.7'
    },
    checks
  };
}

function writeEvidence(
  dir: string,
  checkId: string,
  context: {
    run_id: string;
    environment_id: string;
    deployed_commit: string;
    deployment_fingerprint: string;
    captured_at: string;
    operator: string;
  }
) {
  const evidenceDir = join(dir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const artifactFile = `evidence/${checkId.replaceAll('.', '-')}.json`;
  const file = join(dir, artifactFile);
  const observation = Object.fromEntries(
    VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId].map((field) => [field, detailValue(field, context)])
  );
  if (checkId === 'control.unsupported_actions_fail_closed') {
    observation.actions = ['dtmf', 'park', 'pickup', 'supervisor'];
    observation.http_status_code = 501;
  }
  if (checkId === 'contact_center.supervisor_capability_truth') {
    observation.requested_modes = ['listen', 'whisper', 'barge', 'takeover'];
    observation.effective_modes = [];
  }
  if (checkId === 'isolation.cross_tenant_rls_denied') observation.denial_status_code = 403;
  if (checkId === 'governance.independent_qa_review') observation.qa_approver = 'voice-qa-1';
  const document = {
    schema_version: 1,
    source: 'real_voice_environment',
    check_id: checkId,
    ...context,
    tool: 'SIPp, browser WebRTC internals, PostgreSQL and physical audio observation',
    observation
  };
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return {
    artifact_file: artifactFile,
    sha256: sha256(file),
    captured_at: context.captured_at,
    tool: document.tool,
    run_id: context.run_id
  };
}

function detailValue(
  field: string,
  context: { deployed_commit: string; captured_at: string }
): unknown {
  if (field === 'source_commit') return context.deployed_commit;
  if (/(?:observed|verified|healthy|audible|visible|denied|recovered|reclaimed|idempotent|matched|forced|registered|connected|persisted|passed|ready|accepted|audited|reviewed|interrupted)$/.test(field)) return true;
  if (/(?:count|bytes|ms|pct|calls|attempts|seconds|status_code|revision)$/.test(field)) return 1;
  if (/(?:participants|codecs|candidate_pair|events|actions|modes|nodes|artifacts)$/.test(field)) return ['observed-value'];
  if (field.includes('sha256') || field.includes('digest') || field.includes('fingerprint')) return 'e'.repeat(64);
  if (field.endsWith('_at')) return context.captured_at;
  return `observed-${field.replaceAll('_', '-')}`;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function mutateObservation(
  dir: string,
  report: ReturnType<typeof completeReport>,
  checkId: string,
  mutate: (observation: Record<string, unknown>) => void
): void {
  const evidence = report.checks[checkId].evidence;
  const artifact = join(dir, evidence.artifact_file);
  const document = JSON.parse(readFileSync(artifact, 'utf8')) as {
    observation: Record<string, unknown>;
  };
  mutate(document.observation);
  writeFileSync(artifact, `${JSON.stringify(document, null, 2)}\n`);
  evidence.sha256 = sha256(artifact);
}
