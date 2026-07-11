import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS,
  LIVEKIT_ACCEPTANCE_DETAIL_REQUIREMENTS,
  runLiveKitClientAcceptance
} from '../scripts/livekit-client-acceptance.js';
import {
  buildLiveKitEvidencePack,
  renderLiveKitEvidencePack,
  writeLiveKitEvidencePack,
  type LiveKitEvidencePackConfig
} from '../scripts/livekit-evidence-pack.js';

test('LiveKit evidence pack marks complete real evidence ready for customer review', () => {
  const fixture = createCompleteFixture();
  try {
    const pack = buildLiveKitEvidencePack(fixture.config);
    const markdown = renderLiveKitEvidencePack(pack);

    assert.equal(pack.ok, true);
    assert.equal(pack.status, 'ready_for_customer_review');
    assert.deepEqual(pack.missing_required, []);
    assert.equal(pack.preflight?.ok, true);
    assert.equal(pack.server_evidence?.ok, true);
    assert.deepEqual(pack.readiness?.missing_targets, []);
    assert.equal(pack.client_acceptance?.ok, true);
    assert.equal(pack.artifacts.every((artifact) => artifact.status === 'present'), true);
    assert.equal(pack.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256 || '')), true);
    assert.match(markdown, /Status: `ready_for_customer_review`/);
    assert.equal(pack.artifacts.every((artifact) => markdown.includes(artifact.sha256 || 'missing')), true);
    assert.equal(markdown.includes('real environment evidence for network.ice_udp_selected'), false);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack reports a missing required artifact without claiming readiness', () => {
  const fixture = createCompleteFixture();
  try {
    const config = structuredClone(fixture.config);
    config.artifacts.serverEvidenceFile = join(fixture.dir, 'missing-server-evidence.json');
    const pack = buildLiveKitEvidencePack(config);

    assert.equal(pack.ok, false);
    assert.equal(pack.status, 'incomplete');
    assert.equal(pack.missing_required.includes('server_evidence'), true);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack rejects failed reports and missing readiness targets', () => {
  const fixture = createCompleteFixture();
  try {
    writeJson(fixture.files.preflight, { ok: false, checks: [{ id: 'livekit_public_wss', status: 'fail' }] });
    writeJson(fixture.files.serverEvidence, {
      ok: false,
      summary: { signal_tls_valid: false },
      checks: [{ id: 'signal_tls', status: 'fail' }]
    });
    writeJson(fixture.files.readiness, {
      schema_version: 1,
      ok: true,
      steps: [{ target: 'media', ok: true, exit_code: 0 }]
    });
    const client = JSON.parse(readFileSync(fixture.files.clientReport, 'utf8')) as any;
    client.source = 'local_fake';
    writeJson(fixture.files.clientReport, client);

    const pack = buildLiveKitEvidencePack(fixture.config);
    for (const key of [
      'preflight_report_failed',
      'server_evidence_failed',
      'readiness_required_targets_missing',
      'client_acceptance_failed'
    ]) {
      assert.equal(pack.missing_required.includes(key), true, key);
    }
    assert.deepEqual(pack.readiness?.missing_targets.sort(), [
      'agent-browser',
      'customer-browser',
      'sip-volte',
      'web-assist-browser'
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack fails closed for missing ok wrong schema and contradictory checks', () => {
  const fixture = createCompleteFixture();
  try {
    writeJson(fixture.files.preflight, {
      schema_version: 1,
      acceptance: fixture.acceptance,
      checks: [{ id: 'livekit_public_wss', status: 'fail' }]
    });
    writeJson(fixture.files.serverEvidence, {
      schema_version: 2,
      ok: true,
      acceptance: fixture.acceptance,
      summary: Object.fromEntries([
        'signal_dns_resolved', 'turn_dns_resolved', 'signal_tls_valid', 'turn_tls_valid',
        'signal_health_reachable', 'internal_health_reachable', 'rtc_tcp_reachable',
        'turn_udp_probe_sent', 'rtc_udp_probe_sent'
      ].map((key) => [key, true])),
      checks: [{ id: 'signal_tls', status: 'fail' }]
    });
    const clientResult = JSON.parse(readFileSync(fixture.files.clientResult, 'utf8')) as any;
    delete clientResult.ok;
    writeJson(fixture.files.clientResult, clientResult);

    const pack = buildLiveKitEvidencePack(fixture.config);
    assert.equal(pack.ok, false);
    assert.equal(pack.missing_required.includes('preflight_report_invalid'), true);
    assert.equal(pack.missing_required.includes('server_evidence_invalid'), true);
    assert.equal(pack.missing_required.includes('client_acceptance_result_invalid'), true);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack rejects artifacts from another acceptance run', () => {
  const fixture = createCompleteFixture();
  try {
    const readiness = JSON.parse(readFileSync(fixture.files.readiness, 'utf8')) as any;
    readiness.acceptance.run_id = 'lk-another-run-999';
    writeJson(fixture.files.readiness, readiness);

    const pack = buildLiveKitEvidencePack(fixture.config);
    assert.equal(pack.ok, false);
    assert.equal(pack.missing_required.includes('acceptance_metadata_mismatch'), true);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack rejects incomplete preflight and readiness persisted schemas', () => {
  const fixture = createCompleteFixture();
  try {
    const preflight = JSON.parse(readFileSync(fixture.files.preflight, 'utf8')) as any;
    preflight.checks = preflight.checks.filter((check: any) => check.id !== 'livekit_api_secret');
    writeJson(fixture.files.preflight, preflight);
    const readiness = JSON.parse(readFileSync(fixture.files.readiness, 'utf8')) as any;
    delete readiness.steps[0].stdout_sha256;
    writeJson(fixture.files.readiness, readiness);

    const pack = buildLiveKitEvidencePack(fixture.config);
    assert.equal(pack.ok, false);
    assert.equal(pack.missing_required.includes('preflight_report_invalid'), true);
    assert.equal(pack.missing_required.includes('readiness_report_invalid'), true);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack binds expected metadata current time and deployment mode', () => {
  const fixture = createCompleteFixture();
  try {
    const config = structuredClone(fixture.config);
    config.expectedAcceptance!.started_at = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    config.expectedDeploymentMode = 'external';

    const pack = buildLiveKitEvidencePack(config);
    assert.equal(pack.ok, false);
    assert.equal(pack.missing_required.includes('acceptance_metadata_mismatch'), true);
    assert.equal(pack.missing_required.includes('acceptance_time_window_invalid'), true);
    assert.equal(pack.missing_required.includes('acceptance_metadata_invalid'), true);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack rejects missing fixed preflight targets and secrets in required artifacts', () => {
  const fixture = createCompleteFixture();
  try {
    const preflight = JSON.parse(readFileSync(fixture.files.preflight, 'utf8')) as any;
    preflight.summary.targets = ['media'];
    writeJson(fixture.files.preflight, preflight);
    const server = JSON.parse(readFileSync(fixture.files.serverEvidence, 'utf8')) as any;
    server['livekit-api-secret'] = 'must-not-appear';
    writeJson(fixture.files.serverEvidence, server);

    const pack = buildLiveKitEvidencePack(fixture.config);
    assert.equal(pack.ok, false);
    assert.equal(pack.missing_required.includes('preflight_report_invalid'), true);
    assert.equal(pack.missing_required.includes('server_evidence_unsafe_or_invalid'), true);
  } finally {
    fixture.cleanup();
  }
});

test('LiveKit evidence pack writer always writes an incomplete artifact for missing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-evidence-incomplete-'));
  const outputFile = join(dir, 'evidence-pack.md');
  try {
    const result = writeLiveKitEvidencePack({
      outputFile,
      title: 'LiveKit incomplete evidence',
      artifacts: {}
    });
    const markdown = readFileSync(outputFile, 'utf8');

    assert.equal(result.ok, false);
    assert.equal(result.status, 'incomplete');
    assert.match(markdown, /Status: `incomplete`/);
    assert.match(markdown, /preflight_report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit evidence pack is exposed through package scripts', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['livekit:evidence-pack'], 'tsx scripts/livekit-evidence-pack.ts');
});

function createCompleteFixture(): {
  dir: string;
  files: Record<string, string>;
  config: LiveKitEvidencePackConfig;
  acceptance: Record<string, string>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-evidence-complete-'));
  const files = {
    envChecklist: join(dir, 'env-checklist.md'),
    preflight: join(dir, 'preflight.json'),
    serverEvidence: join(dir, 'server-evidence.json'),
    readiness: join(dir, 'readiness.json'),
    clientReport: join(dir, 'client-acceptance.json'),
    clientResult: join(dir, 'client-acceptance-result.json'),
    serverRunbook: join(dir, 'server-runbook.md'),
    clientRunbook: join(dir, 'client-runbook.md'),
    output: join(dir, 'evidence-pack.md')
  };
  const acceptance = {
    run_id: 'lk-run-20260711-001',
    environment_id: 'led-staging-sfo2',
    deployed_commit: 'b'.repeat(40),
    deployment_fingerprint: 'c'.repeat(64),
    started_at: new Date(Date.now() - 120_000).toISOString(),
    deployment_mode: 'standalone-vm' as const
  };
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const preflightIds = [
    'livekit_internal_url', 'livekit_public_url', 'livekit_public_wss', 'livekit_deployment_mode',
    'livekit_signal_domain', 'livekit_turn_domain', 'livekit_acme_email', 'livekit_server_image_tag',
    'livekit_egress_image_tag', 'livekit_sip_image_tag', 'livekit_caddyl4_image_tag', 'livekit_redis_image_tag',
    'livekit_api_key', 'livekit_api_secret', 'opc_base_url', 'media_api_token', 'media_invite_secret',
    'media_smoke_tenant', 'minio_access_key', 'minio_secret_key', 'media_recording_retention_days',
    'media_recording_http_timeout', 'media_recording_object_timeout', 'media_recording_object_poll_interval',
    'agent_browser_frontend_url', 'agent_browser_agent_a_token', 'agent_browser_agent_a_user_id',
    'agent_browser_agent_a_seat_id', 'agent_browser_agent_b_token', 'agent_browser_agent_b_user_id',
    'agent_browser_agent_b_seat_id', 'customer_browser_frontend_url', 'customer_browser_url_or_room',
    'customer_browser_tenant', 'web_assist_frontend_url', 'web_assist_customer_url',
    'web_assist_engineer_token', 'web_assist_engineer_user_id', 'web_assist_tenant',
    'sip_bridge_target', 'rustpbx_livekit_trunk', 'rustpbx_rwi_url', 'rustpbx_rwi_token'
  ];
  writeFileSync(files.envChecklist, '# Env Checklist\n\nAll production values reviewed.\n');
  writeJson(files.preflight, {
    schema_version: 1,
    ok: true,
    checked_at: checkedAt,
    acceptance,
    summary: {
      deploymentMode: 'standalone-vm',
      targets: ['media', 'agent-browser', 'customer-browser', 'web-assist-browser', 'sip-volte']
    },
    checks: preflightIds.map((id) => ({ id, status: 'pass' }))
  });
  writeJson(files.serverEvidence, {
    schema_version: 1,
    ok: true,
    checked_at: checkedAt,
    acceptance,
    topology: 'standalone-vm',
    summary: {
      signal_dns_resolved: true,
      turn_dns_resolved: true,
      signal_tls_valid: true,
      turn_tls_valid: true,
      signal_health_reachable: true,
      internal_health_reachable: true,
      rtc_tcp_reachable: true,
      turn_udp_probe_sent: true,
      rtc_udp_probe_sent: true
    },
    checks: [
      'signal_dns', 'turn_dns', 'signal_tls', 'turn_tls', 'signal_health',
      'internal_health', 'rtc_tcp', 'turn_udp_probe_sent', 'rtc_udp_probe_sent'
    ].map((id) => ({ id, status: 'pass' }))
  });
  writeJson(files.readiness, {
    schema_version: 1,
    ok: true,
    checked_at: checkedAt,
    acceptance,
    steps: ['media', 'agent-browser', 'customer-browser', 'web-assist-browser', 'sip-volte']
      .map((target) => ({
        target,
        command: `npm run smoke:${target}`,
        ok: true,
        exit_code: 0,
        duration_ms: 100,
        stdout_present: true,
        stdout_sha256: 'd'.repeat(64),
        stderr_present: false,
        stderr_sha256: createHash('sha256').update('').digest('hex'),
        error_summary: ''
      }))
  });
  const clientReport = completeClientReport(dir, acceptance);
  writeJson(files.clientReport, clientReport);
  const qaPublicKey = readFileSync(join(dir, 'qa-public.pem'), 'utf8');
  const qaPublicKeyFingerprint = createHash('sha256').update(qaPublicKey).digest('hex');
  writeJson(files.clientResult, runLiveKitClientAcceptance({
    reportFile: files.clientReport,
    qaPublicKeyFile: join(dir, 'qa-public.pem'),
    qaPublicKeyFingerprint,
    preflightReportFile: files.preflight,
    serverEvidenceFile: files.serverEvidence,
    readinessReportFile: files.readiness
  }));
  writeFileSync(files.serverRunbook, '# Server Runbook\n\nExecuted on the real environment.\n');
  writeFileSync(files.clientRunbook, '# Client Runbook\n\nExecuted with real browsers.\n');

  return {
    dir,
    files,
    acceptance,
    config: {
      outputFile: files.output,
      title: 'LiveKit customer evidence',
      expectedAcceptance: acceptance,
      expectedDeploymentMode: 'standalone-vm',
      qaPublicKeyFile: join(dir, 'qa-public.pem'),
      qaPublicKeyFingerprint,
      artifacts: {
        envChecklistFile: files.envChecklist,
        preflightReportFile: files.preflight,
        serverEvidenceFile: files.serverEvidence,
        readinessReportFile: files.readiness,
        clientAcceptanceReportFile: files.clientReport,
        clientAcceptanceResultFile: files.clientResult,
        serverRunbookFile: files.serverRunbook,
        clientRunbookFile: files.clientRunbook
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function completeClientReport(dir: string, acceptance: Record<string, string>): any {
  const capturedAt = new Date(Date.parse(acceptance.started_at) + 30_000).toISOString();
  const checkedAt = new Date(Date.parse(acceptance.started_at) + 60_000).toISOString();
  const signedAt = new Date(Date.parse(acceptance.started_at) + 90_000).toISOString();
  const checks: Record<string, unknown> = {};
  const evidenceHashes: string[] = [];
  for (const [index, checkId] of LIVEKIT_REQUIRED_ACCEPTANCE_CHECKS.entries()) {
    const evidence = writePackEvidenceArtifact(dir, `pack-check-${index + 1}.json`, checkId, acceptance, capturedAt);
    evidenceHashes.push(evidence.sha256);
    setPath(checks, checkId, {
      passed: true,
      evidence
    });
  }
  const performanceEvidence = writePackEvidenceArtifact(dir, 'pack-performance.json', 'performance', acceptance, capturedAt);
  evidenceHashes.push(performanceEvidence.sha256);
  const reportPayload = {
    schema_version: 1,
    source: 'real_environment',
    run_id: acceptance.run_id,
    run_started_at: acceptance.started_at,
    environment_id: acceptance.environment_id,
    deployment_mode: acceptance.deployment_mode,
    deployed_commit: acceptance.deployed_commit,
    deployment_fingerprint: acceptance.deployment_fingerprint,
    operator: 'qa@example.com',
    checked_at: checkedAt,
    versions: {
      server: 'v1.13.3', egress: 'v1.13.0', sip: 'v1.6.0', redis: '7.4.9', edge: 'caddyl4:v2.11.3'
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
  const qaArtifactFile = join(dir, 'qa-attestation.json');
  const qaArtifactDocument = {
    schema_version: 1,
    kind: 'livekit_qa_attestation',
    run_id: acceptance.run_id,
    environment_id: acceptance.environment_id,
    deployed_commit: acceptance.deployed_commit,
    deployment_fingerprint: acceptance.deployment_fingerprint,
    deployment_mode: acceptance.deployment_mode,
    run_started_at: acceptance.started_at,
    captured_at: signedAt,
    tool: 'qa-ed25519',
    approver: 'qa-approver@example.com',
    signed_at: signedAt,
    decision: 'approved_for_customer_review',
    inputs: {
      preflight_report_sha256: fileSha256(join(dir, 'preflight.json')),
      server_evidence_sha256: fileSha256(join(dir, 'server-evidence.json')),
      readiness_report_sha256: fileSha256(join(dir, 'readiness.json')),
      client_evidence_sha256: evidenceHashes.sort(),
      client_report_payload_sha256: canonicalSha256(reportPayload)
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
    run_id: acceptance.run_id
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

function writePackEvidenceArtifact(
  dir: string,
  filename: string,
  checkId: string,
  acceptance: Record<string, string>,
  capturedAt: string
): { artifact_file: string; sha256: string; captured_at: string; tool: string; run_id: string } {
  const artifactFile = join(dir, filename);
  const document = {
    schema_version: 1,
    kind: 'livekit_acceptance_evidence',
    source: 'real_environment',
    run_id: acceptance.run_id,
    environment_id: acceptance.environment_id,
    deployed_commit: acceptance.deployed_commit,
    deployment_fingerprint: acceptance.deployment_fingerprint,
    deployment_mode: acceptance.deployment_mode,
    run_started_at: acceptance.started_at,
    captured_at: capturedAt,
    tool: 'playwright-webrtc-internals',
    check_id: checkId,
    details: packDetailFixture(checkId)
  };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(artifactFile, content);
  return {
    artifact_file: artifactFile,
    sha256: createHash('sha256').update(content).digest('hex'),
    captured_at: capturedAt,
    tool: 'playwright-webrtc-internals',
    run_id: acceptance.run_id
  };
}

function packDetailFixture(checkId: string): Record<string, unknown> {
  const details = Object.fromEntries(
    (LIVEKIT_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId] || []).map((key) => [key, packDetailValue(key)])
  );
  if (checkId === 'network.ice_udp_selected') Object.assign(details, { transport: 'udp', candidate_type: 'srflx' });
  if (checkId === 'network.ice_tcp_fallback') Object.assign(details, { transport: 'tcp', candidate_type: 'host' });
  if (checkId === 'network.turn_udp_forced_relay') Object.assign(details, { transport: 'udp', candidate_type: 'relay' });
  if (checkId === 'network.turn_tls_forced_relay') Object.assign(details, { transport: 'tls', candidate_type: 'relay' });
  if (checkId === 'recording.egress_completed') details.status = 'complete';
  return details;
}

function packDetailValue(key: string): unknown {
  if (/(participants|workloads|replicas|reconnected)/.test(key)) return ['observed-value'];
  if (/(size_bytes|count|rooms)$/.test(key)) return 1;
  if (key.includes('versions')) return { server: 'v1.13.3' };
  return `observed-${key}`;
}

function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function canonicalSha256(value: unknown): string {
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

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ||= {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
