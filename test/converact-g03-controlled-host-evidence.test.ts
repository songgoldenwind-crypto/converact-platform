import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const GOAL_ROOT = 'architecture-foundation/execution/goal-03';
const EVIDENCE_ROOT = join(
  GOAL_ROOT,
  'evidence/raw/host-campaign-b63383b-ivekit53-01',
);
const SOURCE_COMMIT = 'b63383bda16bcd9d311c9ce5e0761877d474797b';
const IMAGE_ID =
  'sha256:14e51e4f51388c8811e1472426a01840e061ad2ddf639caebe6b0eca4a206eaf';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('G03 admits exact .53 latency, wire, interoperability and long-call evidence only', () => {
  const index = readJson<{
    production_eligible: boolean;
    entries: Array<{
      evidence_id: string;
      status: string;
      evidence_uris: string[];
      source_commit: string | null;
      raw_output_sha256: string | null;
    }>;
  }>(join(GOAL_ROOT, 'evidence-index-v1.json'));
  assert.equal(index.production_eligible, false);

  for (const evidenceId of [
    'G03-E06-TRYING',
    'G03-E07-WIRE',
    'G03-E11-INTEROP',
    'G03-E12-LONG-CALL',
  ]) {
    const entry = index.entries.find((candidate) => candidate.evidence_id === evidenceId);
    assert.equal(entry?.status, 'verified_controlled', evidenceId);
    assert.equal(entry?.source_commit, SOURCE_COMMIT, evidenceId);
    assert.ok(entry?.evidence_uris.length, evidenceId);
    for (const uri of entry?.evidence_uris ?? []) {
      assert.equal(existsSync(uri), true, uri);
    }
    assert.equal(sha256(entry!.evidence_uris[0]!), entry?.raw_output_sha256, evidenceId);
  }

  for (const evidenceId of [
    'G03-E10-FAULT',
    'G03-E13-PERFORMANCE',
    'G03-E15-REVIEW',
    'G03-E16-NATIVE-AUTHORITY',
  ]) {
    const entry = index.entries.find((candidate) => candidate.evidence_id === evidenceId);
    assert.equal(entry?.status, 'not_run', evidenceId);
    assert.deepEqual(entry?.evidence_uris, [], evidenceId);
    assert.equal(entry?.source_commit, null, evidenceId);
    assert.equal(entry?.raw_output_sha256, null, evidenceId);
  }
});

test('G03 .53 long call crosses two hours without failure, retransmission, restart or residue', () => {
  const directory = join(EVIDENCE_ROOT, 'long-call-2h-b63383b-v1');
  const summary = readJson<any>(join(directory, 'summary.json'));
  assert.equal(summary.status, 'passed');
  assert.equal(summary.source_commit, SOURCE_COMMIT);
  assert.equal(summary.patchset, 'ivekit.53');
  assert.equal(summary.runner_exit_code, 0);
  assert.equal(summary.suite_status, 'passed');
  assert.ok(summary.duration_ms >= 7_200_000, summary.duration_ms);
  for (const side of [summary.uac, summary.uas]) {
    assert.equal(side.successful_calls, 1);
    assert.equal(side.failed_calls, 0);
    assert.equal(side.retransmissions, 0);
  }
  assert.equal(summary.router_request_delta, 1);
  assert.equal(summary.cdr_request_delta, 1);
  assert.equal(summary.rustpbx_restart_delta, 0);
  assert.equal(summary.router_restart_delta, 0);
  assert.deepEqual(summary.residual_long_call_containers, []);
  assert.deepEqual(summary.failed_checks, []);
  assert.equal(
    readFileSync(join(directory, 'secret-scan-status.txt'), 'utf8').trim(),
    'passed: generated runtime secrets absent',
  );
  for (const side of ['uac', 'uas']) {
    const warning = readFileSync(
      join(directory, `long-call-2h-${side}-errors.log`),
      'utf8',
    );
    assert.match(
      warning,
      /^The following events occurred:\n2026-08-09\s+09:00:32\.[0-9]+\s+[0-9.]+: Failed to delete FD from epoll, errno = 1 \(Operation not permitted\)\n$/u,
      `${side}: only the reviewed SIPp exit-cleanup warning is admitted`,
    );
  }

  const hostEvidence = join(EVIDENCE_ROOT, 'host-evidence');
  assert.equal(
    readFileSync(join(hostEvidence, 'preexisting-containers-after.txt'), 'utf8'),
    readFileSync(join(hostEvidence, 'preexisting-containers-before.txt'), 'utf8'),
  );
  assert.equal(existsSync(join(hostEvidence, 'preexisting-container-drift.diff')), false);
  const networkAfter = readJson<Array<{ Containers: Record<string, unknown> }>>(
    join(hostEvidence, 'network-after.json'),
  );
  assert.deepEqual(networkAfter[0]?.Containers, {});
});

test('G03 .53 latency and wire reports preserve the exact measured boundary', () => {
  const latency = readJson<any>(join(EVIDENCE_ROOT, 'sip-latency-b63383b-v1/report.json'));
  assert.equal(latency.status, 'passed');
  assert.equal(latency.identity.source_commit, SOURCE_COMMIT);
  assert.equal(latency.identity.patchset, 'ivekit.53');
  assert.deepEqual(latency.ownership, {
    trying_invites: 100,
    trying_responses: 100,
    trying_response_retransmissions: 0,
    one_trying_per_invite: true,
    overload_retry_after_verified: true,
  });
  assert.deepEqual(latency.measurements.trying, {
    rtd_no: 'g03_trying',
    sample_count: 100,
    p50_ms: 0,
    p95_ms: 1,
    p99_ms: 1,
    max_ms: 1,
    raw_csv_sha256: 'e06fa6a5f7edac5db9fe5e4857733a38f7d62ba0f3dce0fafb3e60d4063926d9',
  });

  const wire = readJson<any>(join(EVIDENCE_ROOT, 'wire-differential-b63383b-v1/report.json'));
  assert.equal(wire.status, 'passed');
  assert.equal(wire.identity.source_commit, SOURCE_COMMIT);
  assert.equal(wire.identity.current_patchset, 'ivekit.53');
  assert.deepEqual(wire.summary, {
    total_cases: 22,
    current_matches_contract: 22,
    unchanged_accepted_semantics: 18,
    security_tightenings: 4,
    unexplained_differences: 0,
  });
  assert.equal(
    sha256(join(EVIDENCE_ROOT, 'wire-differential-b63383b-v1/REMOTE-SHA256SUMS')),
    '8747be5059733f0b0dc96594bf3d6e217da21c6836a28d5994d62a140983304b',
  );
});

test('G03 SIPp and Asterisk evidence is exact and leaves no active peer channel', () => {
  const summary = readJson<any>(join(EVIDENCE_ROOT, 'interoperability-summary.json'));
  assert.equal(summary.status, 'passed');
  assert.equal(summary.source_commit, SOURCE_COMMIT);
  assert.equal(summary.rustpbx_image_id, IMAGE_ID);
  assert.equal(summary.sipp.scenario_count, 10);
  assert.equal(summary.sipp.call_count, 19);
  assert.equal(summary.sipp.failed_scenarios, 0);
  assert.equal(summary.asterisk.version, '20.6.0');
  assert.equal(summary.asterisk.successful_calls, 1);
  assert.equal(summary.asterisk.failed_calls, 0);
  assert.equal(summary.asterisk.active_channels_after, 0);
  assert.equal(summary.asterisk.rustpbx_restart_delta, 0);
  assert.equal(summary.asterisk.router_restart_delta, 0);
  assert.equal(
    sha256(join(EVIDENCE_ROOT, 'sipp-short-b63383b-v1/report.json')),
    summary.sipp.report_sha256,
  );
  assert.equal(
    readFileSync(join(EVIDENCE_ROOT, 'real-asterisk-peer-b63383b-v1/asterisk-channels-after.txt'), 'utf8'),
    '',
  );
});

test('G03 2-vCPU capacity baseline stays partial and excludes oversized message traces', () => {
  const summary = readJson<any>(join(EVIDENCE_ROOT, 'capacity-summary.json'));
  assert.equal(summary.campaign_status, 'passed_controlled_baseline');
  assert.equal(summary.evidence_gate_status, 'partial_not_promoted');
  assert.equal(summary.source_commit, SOURCE_COMMIT);
  assert.equal(summary.host_logical_cpu_count, 2);
  assert.deepEqual(summary.steps.map((step: any) => step.target_cps), [50, 100, 200, 1000]);
  assert.deepEqual(summary.steps.map((step: any) => step.failed_calls), [0, 0, 0, 0]);
  assert.deepEqual(summary.steps.map((step: any) => step.retransmissions), [0, 0, 0, 0]);
  assert.match(summary.promotion_decision, /G03-E13 remains not_run/u);

  for (const step of summary.steps) {
    const directory = join(
      EVIDENCE_ROOT,
      'sip-capacity-b63383b-v1',
      `q${step.target_cps}-${step.duration_seconds}s-b63383b-v1`,
    );
    const rawSummary = join(directory, 'summary.json');
    assert.equal(sha256(rawSummary), step.summary_sha256, rawSummary);
    assert.equal(existsSync(join(directory, 'messages.log')), false, directory);
    assert.match(
      readFileSync(join(directory, 'REMOTE-SHA256SUMS'), 'utf8'),
      /\.\/messages\.log/u,
      directory,
    );
    assert.equal(
      readFileSync(join(directory, 'secret-scan-status.txt'), 'utf8').trim(),
      'passed: generated runtime secrets absent',
      directory,
    );
  }
});

test('G03 exact image provenance binds the admitted host reports', () => {
  const images = readJson<any[]>(join(EVIDENCE_ROOT, 'build-evidence/image-inspect.json'));
  assert.equal(images.length, 1);
  assert.equal(images[0].Id, IMAGE_ID);
  assert.equal(images[0].Config.Labels['org.opencontainers.image.revision'], SOURCE_COMMIT);
  assert.equal(images[0].Config.Labels['io.ivekit.rustpbx.patchset'], 'ivekit.53');
  assert.equal(
    images[0].Config.Labels['io.ivekit.rustpbx.patch-set-sha256'],
    '6e2a5181e788f824002b9a2e2d90fb6c851891275b07c67570b47f427b94b1e6',
  );
});
