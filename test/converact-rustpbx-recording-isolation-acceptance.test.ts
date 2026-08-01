import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import type { RustPbxRecordingIsolationResult } from
  '../scripts/converact-rustpbx-recording-isolation-acceptance.js';

const SCRIPT_PATH = new URL(
  '../scripts/converact-rustpbx-recording-isolation-acceptance.ts',
  import.meta.url
);
const ADMISSION_FIXTURE_PATH = new URL(
  '../services/converact-service/acceptance/rustpbx-recording-isolation/owner-admission.mjs',
  import.meta.url
);
const COMPOSE_PATH = new URL(
  '../services/converact-service/acceptance/rustpbx-recording-isolation/docker-compose.yml',
  import.meta.url
);

test('RustPBX recording isolation acceptance is a packaged repeatable command', () => {
  assert.equal(existsSync(SCRIPT_PATH), true);
  assert.equal(existsSync(COMPOSE_PATH), true);
  const script = readFileSync(SCRIPT_PATH, 'utf8');
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['rustpbx:recording-isolation-acceptance'],
    'tsx scripts/converact-rustpbx-recording-isolation-acceptance.ts'
  );
  const service = script.match(/const SERVICE = '([^']+)'/)?.[1];
  assert.match(service || '', /^\+?\d{2,32}$/);
  assert.match(
    readFileSync(new URL('../scripts/converact-delivery-bundle.ts', import.meta.url), 'utf8'),
    /converact-rustpbx-recording-isolation-acceptance\.ts/
  );
  const bundle = readFileSync(
    new URL('../scripts/converact-delivery-bundle.ts', import.meta.url),
    'utf8'
  );
  assert.match(bundle, /rustpbx-recording-isolation\/docker-compose\.yml/);
  assert.match(bundle, /rustpbx-recording-isolation\/owner-admission\.mjs/);
  assert.match(bundle, /rustpbx-recording-isolation\/bootstrap-inbound-trunk\.py/);
});

test('RustPBX recording isolation Compose is isolated and injects a shared tmpfs failure', () => {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');

  assert.match(compose, /network_mode:\s*service:rustpbx/);
  assert.match(compose, /recording-spool:\/app\/recording-spool/);
  assert.match(compose, /recording-spool:\/spool/);
  assert.match(compose, /type:\s*tmpfs/);
  assert.match(compose, /device:\s*tmpfs/);
  assert.match(compose, /nofile:\s*\n\s*soft:\s*262144\s*\n\s*hard:\s*262144/);
  assert.match(compose, /IVEKIT_RUSTPBX_ROUTE_SNAPSHOT_FILE/);
  assert.match(compose, /IVEKIT_RUSTPBX_RECORDING_SPOOL_ENABLED/);
  assert.match(compose, /IVEKIT_REGION_ID: isolation-region/);
  assert.match(
    compose,
    /CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_NETWORK:-converact-rustpbx-recording-isolation/
  );
  assert.match(compose, /172\.30\.45\.10/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
});

test('RustPBX recording isolation runtime plan fails closed on mutable inputs', async () => {
  const { createRustPbxRecordingIsolationRuntimePlan } = await import(
    '../scripts/converact-rustpbx-recording-isolation-acceptance.js'
  );
  const valid = {
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_DIR: '/tmp/converact-recording-isolation',
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_COMPOSE_FILE: '/tmp/docker-compose.yml',
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_IMAGE:
      'converact/rustpbx:0.4.11-ivekit.27-6c49ee76',
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_POSTGRES_IMAGE:
      'postgres@sha256:' + 'a'.repeat(64),
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_NODE_IMAGE:
      'node@sha256:' + 'b'.repeat(64),
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_PYTHON_IMAGE:
      'python@sha256:' + 'c'.repeat(64),
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_FAULT_IMAGE:
      'alpine@sha256:' + 'd'.repeat(64),
    CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_SIPP_IMAGE:
      'alpine@sha256:' + 'e'.repeat(64),
    CONVERACT_FABRIC_SIPP_BINARY: '/tmp/sipp'
  };

  assert.deepEqual(createRustPbxRecordingIsolationRuntimePlan(valid), {
    compose_file: '/tmp/docker-compose.yml',
    runtime_directory: '/tmp/converact-recording-isolation',
    result_file: '/tmp/converact-recording-isolation/result.json',
    project_name: 'converact-rustpbx-recording-isolation',
    rustpbx_image: valid.CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_IMAGE,
    postgres_image: valid.CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_POSTGRES_IMAGE,
    node_image: valid.CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_NODE_IMAGE,
    python_image: valid.CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_PYTHON_IMAGE,
    fault_image: valid.CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_FAULT_IMAGE,
    sipp_image: valid.CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_SIPP_IMAGE,
    sipp_binary: '/tmp/sipp',
    network: 'converact-rustpbx-recording-isolation',
    rustpbx_ip: '172.30.45.10',
    uac_ip: '172.30.45.20',
    uas_ip: '172.30.45.21'
  });
  assert.throws(
    () => createRustPbxRecordingIsolationRuntimePlan({
      ...valid,
      CONVERACT_FABRIC_RUSTPBX_RECORDING_ISOLATION_NODE_IMAGE: 'node:latest'
    }),
    /digest/i
  );
});

test('RustPBX owner patch materializes its complete new source file', () => {
  const patch = readFileSync(
    new URL(
      '../infra/converact/rustpbx/patches/rustpbx-ivekit-owner-epoch.patch',
      import.meta.url
    ),
    'utf8'
  );
  const section = patch.match(
    /diff --git a\/src\/ivekit_owner\.rs[\s\S]+?(?=\ndiff --git )/
  )?.[0];
  assert.ok(section);
  const header = section.match(/@@ -0,0 \+1,(\d+) @@/);
  assert.ok(header);
  const body = section.slice(section.indexOf('\n', section.indexOf(header[0])) + 1);
  const materializedLines = body
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;

  assert.equal(Number(header[1]), materializedLines);
  assert.match(section, /\+fn valid_node_identifier/);
  assert.match(section, /\+mod tests \{/);
});

test('RustPBX recording isolation owner fixture accepts standard SIP Call-ID contracts', async () => {
  const { createOwnerAdmissionFixture } = await import(ADMISSION_FIXTURE_PATH.href);
  const fixture = createOwnerAdmissionFixture({
    serviceKey: 'service-key-with-safe-length',
    componentToken: 'component-token-with-safe-length',
    nodeId: 'rustpbx-isolation-1',
    now: () => new Date('2026-07-25T12:00:00.000Z')
  });
  const admitted = fixture.dispatch({
    method: 'POST',
    path: '/inbound-admission',
    headers: { 'x-pbx-key': 'service-key-with-safe-length' },
    body: {
      call_id: '1-24817@172.30.45.20',
      ivekit_owner_node_id: 'rustpbx-isolation-1'
    }
  });

  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.data.accepted, true);
  assert.match(admitted.body.data.call_id, /^vcall-[a-f0-9]{32}$/);
  assert.equal(admitted.body.data.provider_call_id, '1-24817@172.30.45.20');
  assert.match(admitted.body.data.reservation_id, /^reservation-[a-f0-9]{32}$/);
  assert.equal(admitted.body.data.owner_epoch, '4294967297');

  const authorized = fixture.dispatch({
    method: 'POST',
    path: '/v1/authorize',
    headers: { authorization: 'Bearer component-token-with-safe-length' },
    body: {
      reservation_id: admitted.body.data.reservation_id,
      interaction_id: admitted.body.data.call_id,
      owner_epoch: admitted.body.data.owner_epoch,
      operation: 'open'
    }
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body.data, {
    allowed: true,
    component: 'rustpbx',
    node_id: 'rustpbx-isolation-1',
    cell_lease_epoch: 1,
    owner_epoch: '4294967297',
    state_sequence: 1,
    lease_expires_at: '2026-07-25T12:00:30.000Z'
  });
});

test('RustPBX recording isolation owner fixture rejects bad credentials and owner mismatches', async () => {
  const { createOwnerAdmissionFixture } = await import(ADMISSION_FIXTURE_PATH.href);
  const fixture = createOwnerAdmissionFixture({
    serviceKey: 'service-key-with-safe-length',
    componentToken: 'component-token-with-safe-length',
    nodeId: 'rustpbx-isolation-1'
  });

  assert.equal(fixture.dispatch({
    method: 'POST',
    path: '/inbound-admission',
    headers: {},
    body: { call_id: 'call@host', ivekit_owner_node_id: 'rustpbx-isolation-1' }
  }).status, 401);
  assert.equal(fixture.dispatch({
    method: 'POST',
    path: '/inbound-admission',
    headers: { 'x-pbx-key': 'service-key-with-safe-length' },
    body: { call_id: 'call@host', ivekit_owner_node_id: 'other-node' }
  }).status, 409);
  assert.equal(fixture.dispatch({
    method: 'POST',
    path: '/v1/authorize',
    headers: { authorization: 'Bearer wrong-component-token' },
    body: {}
  }).status, 401);
});

test('RustPBX recording isolation requires bidirectional RTP progress in every fault phase', async () => {
  const { assertRustPbxRtpPhaseProgress } = await import(
    '../scripts/converact-rustpbx-recording-isolation-acceptance.js'
  );
  const before = rtpSnapshot(1_000);
  const progressed = rtpSnapshot(2_000);

  assert.doesNotThrow(() => assertRustPbxRtpPhaseProgress(before, progressed, 'during_fault'));
  assert.throws(
    () => assertRustPbxRtpPhaseProgress(
      before,
      { ...progressed, uac_received_packets: before.uac_received_packets },
      'during_fault'
    ),
    /uac_received_packets.*during_fault/i
  );
  assert.throws(
    () => assertRustPbxRtpPhaseProgress(
      before,
      { ...progressed, uas_generated_packets: before.uas_generated_packets },
      'after_write_failure'
    ),
    /uas_generated_packets.*after_write_failure/i
  );
});

test('RustPBX recording isolation snapshots count live RTP and ignore non-RTP control packets', async () => {
  const { createRustPbxRtpPhaseSnapshot } = await import(
    '../scripts/converact-rustpbx-recording-isolation-acceptance.js'
  );
  const uac = [
    'TID: 1 SIPP SUCCESS SEND LOG: 172 0xac 1 [8000000100000001AA]',
    'TID: 1 SIPP SUCCESS RECV LOG: 172 0xac 1 [8000000200000002AA]',
    'TID: 1 SIPP SUCCESS RECV LOG: 32 0x20 2 [0001000C2112A442AA]',
    ''
  ].join('\n');
  const uas = [
    'TID: 2 SIPP SUCCESS SEND LOG: 172 0xac 1 [8000000300000003AA]',
    'TID: 2 SIPP SUCCESS SEND LOG: 172 0xac 2 [8000000400000004AA]',
    'TID: 2 SIPP SUCCESS RECV LOG: 172 0xac 1 [8000000500000005AA]',
    ''
  ].join('\n');

  assert.deepEqual(
    createRustPbxRtpPhaseSnapshot(uac, uas, new Date('2026-07-25T12:00:00.000Z')),
    {
      observed_at: '2026-07-25T12:00:00.000Z',
      uac_generated_packets: 1,
      uac_received_packets: 1,
      uas_generated_packets: 2,
      uas_received_packets: 1
    }
  );
});

test('RustPBX recording isolation evaluator accepts a controlled ENOSPC and clean recovery', async () => {
  const { evaluateRustPbxRecordingIsolationEvidence } = await import(
    '../scripts/converact-rustpbx-recording-isolation-acceptance.js'
  );
  const evidence = validEvidence();

  const result = evaluateRustPbxRecordingIsolationEvidence(evidence);

  assert.equal(result.status, 'passed_controlled_runtime');
  assert.equal(result.media_transport_progress_verified, true);
  assert.equal(result.recording_failure_code, 'local_spool_enospc');
  assert.equal(result.recovery_recording_terminal_status, 'complete');
  assert.equal(result.capacity_claim, 'none');
  assert.doesNotMatch(JSON.stringify(result), /token|password|authorization/i);
});

test('RustPBX recording isolation evaluator fails closed on ambiguous fault evidence', async () => {
  const { evaluateRustPbxRecordingIsolationEvidence } = await import(
    '../scripts/converact-rustpbx-recording-isolation-acceptance.js'
  );

  assert.throws(
    () => evaluateRustPbxRecordingIsolationEvidence({
      ...validEvidence(),
      recorder_write_failure_count: 0
    }),
    /recorder write failure/i
  );
  assert.throws(
    () => evaluateRustPbxRecordingIsolationEvidence({
      ...validEvidence(),
      rustpbx_restart_count: 1
    }),
    /restart/i
  );
  assert.throws(
    () => evaluateRustPbxRecordingIsolationEvidence({
      ...validEvidence(),
      recovery: {
        ...validEvidence().recovery,
        completion_present: false
      }
    }),
    /completion/i
  );
  assert.throws(
    () => evaluateRustPbxRecordingIsolationEvidence({
      ...validEvidence(),
      media_after_write_failure: {
        ...validEvidence().media_after_write_failure,
        uas_received_packets: validEvidence().media_during_fault.uas_received_packets
      }
    }),
    /uas_received_packets.*after_write_failure/i
  );
});

test('RustPBX recording isolation result writer creates a private sanitized artifact', async () => {
  const {
    assertRustPbxRecordingIsolationResultIsSanitized,
    writeRustPbxRecordingIsolationResult
  } = await import('../scripts/converact-rustpbx-recording-isolation-acceptance.js');
  const path = `/tmp/converact-rustpbx-recording-isolation-${process.pid}.json`;

  try {
    const result = evaluateForWriter(await import(
      '../scripts/converact-rustpbx-recording-isolation-acceptance.js'
    ));
    writeRustPbxRecordingIsolationResult(path, result);
    const mode = (await import('node:fs')).statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.doesNotThrow(() => assertRustPbxRecordingIsolationResultIsSanitized(
      JSON.parse(readFileSync(path, 'utf8'))
    ));
  } finally {
    (await import('node:fs')).rmSync(path, { force: true });
  }
});

test('RustPBX recording isolation startup diagnostics redact credentials', async () => {
  const { sanitizeRustPbxRecordingIsolationDiagnostic } = await import(
    '../scripts/converact-rustpbx-recording-isolation-acceptance.js'
  );
  const diagnostic = sanitizeRustPbxRecordingIsolationDiagnostic([
    'database_url=postgres://rustpbx_app:database-secret@postgres/rustpbx',
    'Authorization: Bearer bearer-secret',
    'token=token-secret password=password-secret',
    'configuration rejected at proxy.http_router'
  ].join('\n'));

  assert.doesNotMatch(
    diagnostic,
    /database-secret|bearer-secret|token-secret|password-secret/
  );
  assert.match(diagnostic, /postgres:\/\/rustpbx_app:\[redacted\]@postgres\/rustpbx/);
  assert.match(diagnostic, /configuration rejected at proxy\.http_router/);
});

function rtpSnapshot(base: number) {
  return {
    observed_at: new Date(1_700_000_000_000 + base).toISOString(),
    uac_generated_packets: base,
    uac_received_packets: base + 1,
    uas_generated_packets: base + 2,
    uas_received_packets: base + 3
  };
}

function validEvidence() {
  return {
    run_id: 'rustpbx-recording-isolation-test',
    fault_call_successful: true,
    fault_call_duration_ms: 30_000,
    media_before_fault: rtpSnapshot(1_000),
    media_during_fault: rtpSnapshot(2_000),
    media_after_write_failure: rtpSnapshot(3_000),
    spool_fault: {
      kind: 'enospc' as const,
      available_bytes_before: 7_000_000,
      available_bytes_during: 0,
      filler_removed: true
    },
    recorder_write_failure_count: 1,
    primary_completion_present: false,
    recovery: {
      call_successful: true,
      payload_size_bytes: 96_000,
      manifest_present: true,
      completion_present: true,
      segment_count: 1
    },
    rustpbx_restart_count: 0,
    rustpbx_oom_killed: false
  };
}

function evaluateForWriter(module: {
  evaluateRustPbxRecordingIsolationEvidence(
    input: ReturnType<typeof validEvidence>
  ): RustPbxRecordingIsolationResult;
}): RustPbxRecordingIsolationResult {
  return module.evaluateRustPbxRecordingIsolationEvidence(validEvidence());
}
