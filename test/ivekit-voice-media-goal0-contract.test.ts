import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

const RTPENGINE_COMMIT = '506cfa74386a5373e40fca139a932917f22f0524';
const RTPENGINE_ARCHIVE_SHA256 =
  'a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143';

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function validates(schemaPath: string, documentPath: string): Record<string, any> {
  const schema = json(schemaPath);
  const document = json(documentPath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => !Number.isNaN(Date.parse(value))
  });
  ajv.addFormat('uri', {
    type: 'string',
    validate: (value: string) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }
  });
  const validate = ajv.compile(schema);
  assert.equal(
    validate(document),
    true,
    ajv.errorsText(validate.errors, { separator: '\n' })
  );
  return document;
}

test('Goal 0 pins rtpengine source, archive, license and rollout truthfully', () => {
  const manifest = json('docs/capacity/forks/ivekit-forks-v1.json');
  const rtpengine = manifest.components.find(
    (component: Record<string, any>) => component.component_id === 'rtpengine'
  );

  assert.ok(rtpengine);
  assert.equal(rtpengine.lifecycle, 'planned');
  assert.equal(rtpengine.integration_mode, 'maintained_fork');
  assert.equal(rtpengine.upstream.version, 'mr26.0.1.13');
  assert.equal(rtpengine.upstream.release_ref, 'mr26.0.1.13');
  assert.equal(rtpengine.upstream.commit, RTPENGINE_COMMIT);
  assert.equal(rtpengine.upstream.pin_kind, 'exact_tag');
  assert.equal(rtpengine.upstream.source_identity_complete, true);
  assert.equal(
    rtpengine.upstream.source_archive.sha256,
    RTPENGINE_ARCHIVE_SHA256
  );
  assert.equal(rtpengine.upstream.source_archive.size_bytes, 6_987_926);
  assert.equal(rtpengine.traceability.upstream_license, 'GPL-3.0-only');
  assert.equal(rtpengine.traceability.notice_recorded, true);
  assert.equal(rtpengine.verification.source_identity, 'passed');
  assert.equal(rtpengine.verification.compile, 'not_run');
  assert.equal(rtpengine.verification.integration, 'not_run');
  assert.equal(rtpengine.verification.benchmark, 'not_run');
  assert.equal(rtpengine.release_gate.production_eligible, false);
});

test('Goal 0 source spike records the exact supported media surface and constraints', () => {
  const spike = validates(
    'docs/capacity/schemas/source-capability-spike.schema.json',
    'docs/capacity/forks/rtpengine-mr26-source-spike-v1.json'
  );
  assert.equal(spike.upstream.commit, RTPENGINE_COMMIT);
  assert.equal(spike.upstream.archive_sha256, RTPENGINE_ARCHIVE_SHA256);

  const capabilities = new Map<string, Record<string, any>>(
    spike.capabilities.map((capability: Record<string, any>) => [
      capability.capability_id,
      capability
    ])
  );
  for (const capabilityId of [
    'ng-offer-answer',
    'ng-delete-query',
    'ng-recording-control',
    'ng-forwarding-control',
    'rtp-rtcp-relay',
    'kernel-forwarding',
    'userspace-fallback',
    'ice-bridge',
    'srtp-sdes',
    'dtls-srtp',
    'transcoding',
    't38-pcm',
    'media-forking'
  ]) {
    const capability = capabilities.get(capabilityId);
    assert.ok(capability, capabilityId);
    assert.equal(capability.status, 'source_confirmed', capabilityId);
    assert.ok(capability.evidence.length > 0, capabilityId);
  }

  const pcap = spike.constraints.find(
    (constraint: Record<string, any>) =>
      constraint.constraint_id === 'pcap-recording-disables-kernel-forwarding'
  );
  assert.ok(pcap);
  assert.equal(pcap.effect, 'separate_profile_required');
});

test('Goal 0 VOS-EQ profile is role-specific and generator-invalidating', () => {
  const profile = validates(
    'docs/capacity/schemas/voice-media-profile.schema.json',
    'docs/capacity/profiles/vos-eq-v1-rtp-10k-v1.json'
  );
  assert.equal(profile.profile_id, 'vos-eq-v1-rtp-10k-v1');
  assert.equal(profile.primary_sut.role, 'rtp_fast_path');
  assert.equal(profile.primary_sut.component_id, 'rtpengine');
  assert.equal(profile.workload.active_calls, 10_000);
  assert.equal(profile.workload.rtp_rx_pps, 1_000_000);
  assert.equal(profile.workload.rtp_tx_pps, 1_000_000);
  assert.equal(profile.workload.aggregate_pps, 2_000_000);
  assert.equal(profile.workload.wire_rx_bps, 1_904_000_000);
  assert.equal(profile.workload.wire_tx_bps, 1_904_000_000);
  assert.equal(profile.finalizer.minimum_repetitions, 3);
  assert.equal(profile.finalizer.preserve_all_attempts, true);
  assert.equal(profile.finalizer.invalidate_on_generator_failure, true);
  assert.deepEqual(profile.finalizer.reconciliation_counters, [
    'attempted',
    'connected',
    'failed',
    'active',
    'completed'
  ]);
  assert.equal(profile.claim.status, 'target');
  assert.equal(profile.claim.capacity_claim, 'none');
});

test('Goal 0 metrics contract fixes type, unit, labels, buckets and clock metadata', () => {
  const contract = validates(
    'docs/capacity/schemas/metrics-contract.schema.json',
    'docs/capacity/contracts/voice-media-metrics-v1.json'
  );
  const metrics = new Map<string, Record<string, any>>(
    contract.metrics.map((metric: Record<string, any>) => [
      metric.name,
      metric
    ])
  );

  for (const name of [
    'ivekit_voice_rtp_rx_packets_total',
    'ivekit_voice_rtp_tx_packets_total',
    'ivekit_voice_reservations',
    'ivekit_voice_reservation_reconciliation_total',
    'ivekit_voice_recording_spool_bytes',
    'ivekit_voice_durable_spool_bytes',
    'ivekit_voice_owner_takeover_seconds',
    'ivekit_voice_generator_clock_offset_seconds'
  ]) {
    const metric = metrics.get(name);
    assert.ok(metric, name);
    assert.ok(metric.type);
    assert.ok(metric.unit);
    assert.ok(Array.isArray(metric.labels));
    assert.ok(metric.labels.every((label: string) => ![
      'tenant_id',
      'call_id',
      'phone_number',
      'ip_address'
    ].includes(label)));
  }

  assert.deepEqual(contract.clock.required_metadata, [
    'clock_source',
    'ntp_offset_seconds',
    'captured_at'
  ]);
});

test('Goal 0 authority ADR and failure matrix preserve Cell-local media boundaries', () => {
  const contract = validates(
    'docs/capacity/schemas/voice-media-goal0.schema.json',
    'docs/capacity/contracts/voice-media-goal0-v1.json'
  );
  assert.equal(
    contract.authority.adr_path,
    'docs/adr/ccaas-5-media-authority-and-rtpengine.md'
  );
  assert.equal(contract.authority.logical_media_graph_owner, 'rustpbx');
  assert.equal(contract.authority.wire_transport_owner, 'rtpengine');
  assert.equal(
    contract.authority.recording_manifest_owner,
    'regional_recording_service'
  );
  assert.equal(contract.placement.normal_media_cross_zone, false);
  assert.deepEqual(contract.harness.reconciliation_counters, [
    'attempted',
    'connected',
    'failed',
    'active',
    'completed'
  ]);
  assert.equal(contract.harness.generator_failure_outcome, 'invalid_generator_capacity');
  assert.equal(
    contract.harness.evidence_schema_path,
    'docs/capacity/schemas/voice-media-attempt-evidence.schema.json'
  );
  assert.ok(
    contract.harness.drivers.some(
      (driver: Record<string, any>) =>
        driver.path === 'scripts/capacity/voice-media-attempt-evidence.ts' &&
        driver.role === 'attempt_evaluation' &&
        driver.status === 'implemented'
    )
  );
  assert.ok(
    contract.failure_matrix.some(
      (failure: Record<string, any>) =>
        failure.failure_id === 'object-storage-unavailable' &&
        failure.established_media === 'continue' &&
        failure.new_mandatory_recording === 'reject'
    )
  );

  const adr = readFileSync(contract.authority.adr_path, 'utf8');
  assert.match(adr, /logical media graph/i);
  assert.match(adr, /effective wire SDP/i);
  assert.match(adr, /Region cross-Zone/i);
  assert.match(adr, /supersedes.*RustPBX encoded fork/i);
});
