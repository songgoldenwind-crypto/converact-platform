import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const R4_PATH =
  'docs/capacity/contracts/unified-voice-foundation-r4-v1.json';
const RVOIP_PATH =
  'docs/capacity/contracts/rvoip-capability-integration-v1.json';
const GOAL4_PATH =
  'docs/capacity/contracts/voice-media-goal4-v1.json';

type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(',')}}`;
}

function projectedDigest(
  document: Record<string, any>,
  omittedTopLevelKey: string
): string {
  const projection = structuredClone(document);
  delete projection[omittedTopLevelKey];
  return createHash('sha256')
    .update(canonicalJson(projection as Json))
    .digest('hex');
}

function validator(schemaPath: string): ReturnType<Ajv2020['compile']> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false
  });
  ajv.addKeyword({
    keyword: 'x-ivekit-invariants',
    schemaType: 'array',
    valid: true
  });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === value;
    }
  });
  ajv.addFormat('uuid', {
    type: 'string',
    validate: (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(value)
  });
  return ajv.compile(json(schemaPath));
}

test('R4, rvoip and Goal 4 bind one another by revision and projected digest', () => {
  const r4 = json(R4_PATH);
  const rvoip = json(RVOIP_PATH);
  const goal4 = json(GOAL4_PATH);

  assert.equal(r4.revision, 4);
  assert.equal(rvoip.revision, 6);
  assert.equal(goal4.revision, 6);
  assert.equal(
    r4.authority_bindings.digest_projection,
    'rfc8785_jcs_without_top_level_authority_binding'
  );

  const expectedR4Digest = projectedDigest(r4, 'authority_bindings');
  const expectedRvoipDigest = projectedDigest(rvoip, 'foundation_authority');
  const expectedGoal4Digest = projectedDigest(goal4, 'foundation_authority');

  assert.deepEqual(r4.authority_bindings.rvoip, {
    path: RVOIP_PATH,
    contract_id: 'rvoip-capability-integration-v1',
    revision: 6,
    content_sha256: expectedRvoipDigest
  });
  assert.deepEqual(r4.authority_bindings.voice_media_goal4, {
    path: GOAL4_PATH,
    contract_id: 'voice-media-goal4-v1',
    revision: 6,
    content_sha256: expectedGoal4Digest
  });

  for (const subordinate of [rvoip, goal4]) {
    assert.deepEqual(subordinate.foundation_authority, {
      path: R4_PATH,
      contract_id: 'unified-voice-foundation-r4-v1',
      revision: 4,
      digest_projection:
        'rfc8785_jcs_without_top_level_authority_binding',
      content_sha256: expectedR4Digest
    });
  }
});

test('Goal 4 exposes one G729 wire codec and two internal processing modes', () => {
  const goal4 = json(GOAL4_PATH);
  const slice = goal4.codec_slices.find(
    (entry: Record<string, any>) => entry.slice_id === 'g729-v1'
  );

  assert.ok(slice);
  assert.deepEqual(slice.codecs, ['PCMU', 'PCMA', 'OPUS', 'G729']);
  assert.equal(slice.external_codec_id, 'G729/8000');
  assert.deepEqual(
    slice.internal_processing_modes.map(
      (mode: Record<string, any>) => mode.mode_id
    ),
    ['G729A', 'G729AB']
  );
  assert.equal(slice.codec_modes, undefined);
  assert.deepEqual(slice.rtp_wire, {
    encoding_name: 'G729',
    clock_rate_hz: 8000,
    static_payload_type: 18,
    dynamic_payload_type_min: 96,
    dynamic_payload_type_max: 127,
    dynamic_remap_scope: 'leg_and_binding_revision'
  });

  const rvoip = json(RVOIP_PATH);
  for (const id of [
    'g729a_mandatory_mode_identity',
    'g729ab_mandatory_mode_identity'
  ]) {
    const capability = rvoip.capabilities.find(
      (entry: Record<string, any>) => entry.capability_id === id
    );
    assert.ok(capability, id);
    assert.match(capability.next_gate, /internal (processing )?mode/i);
    assert.doesNotMatch(capability.next_gate, /distinct .*registry/i);
  }
  const omittedAnnexB = rvoip.capabilities.find(
    (entry: Record<string, any>) =>
      entry.capability_id === 'g729_annex_b_missing_defaults_yes'
  );
  assert.ok(omittedAnnexB);
  assert.doesNotMatch(omittedAnnexB.next_gate, /merging .*registry/i);
});

test('capacity vector accepts the isolated Voice-LiveKit bridge dimensions', () => {
  const validate = validator(
    'docs/capacity/schemas/capacity-vector.schema.json'
  );
  const sample: Record<string, any> = {
    schema_version: '1.1.0',
    sample_id: '11111111-1111-4111-8111-111111111111',
    sequence: 1,
    observed_at: '2026-07-30T00:00:00.000Z',
    expires_at: '2026-07-30T00:00:30.000Z',
    scope: {
      type: 'node',
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      node_id: 'node-a',
      owner_epoch: 1
    },
    profile_id: 'voice-livekit-bridge-v1',
    component: 'rustpbx',
    admission: {
      state: 'rejecting',
      accepts_new_interactions: false,
      accepts_existing_owner_traffic: true,
      limiting_dimensions: ['voice_livekit_bridge.bridge_generations'],
      reason_codes: ['capacity_exhausted']
    },
    dimensions: {
      voice_livekit_bridge: Object.fromEntries(
        [
          ['bridge_generations', 'count'],
          ['directed_bridge_edges', 'count'],
          ['livekit_sip_participants', 'count'],
          ['bridge_cps', 'per_second'],
          ['switch_attempts', 'per_second'],
          ['switch_gap_p99_ms', 'milliseconds'],
          ['switch_loss_packets_p99', 'packets'],
          ['decode_slots', 'count'],
          ['encode_slots', 'count'],
          ['resample_slots', 'count'],
          ['transcode_slots', 'count'],
          ['recording_roles', 'count'],
          ['handoff_reconciliation_cps', 'per_second']
        ].map(([name, unit]) => [name, {
          unit,
          safe_capacity: 0,
          used: 0,
          reserved: 0,
          confidence: 'unknown',
          source: 'unknown'
        }])
      )
    },
    resources: {
      cpu_cores: 1,
      cpu_utilization_ratio: 0,
      memory_bytes: 0,
      memory_utilization_ratio: 0,
      nic_ingress_mbps: 0,
      nic_egress_mbps: 0,
      open_file_descriptors: 0
    },
    evidence: {
      status: 'not_run',
      workload_profile_id: 'voice-livekit-bridge-v1',
      bridge_included: true,
      results_inheritable: false,
      forbidden_inheritance_sources: [
        'ordinary_rtp',
        'livekit_only',
        'optional_bridge_excluded',
        'another_path'
      ]
    }
  };

  assert.equal(
    validate(sample),
    true,
    validate.errors?.map((error) =>
      `${error.instancePath || '/'} ${error.message}`
    ).join('\n')
  );

  const oldProducerSample: Record<string, any> = structuredClone(sample);
  oldProducerSample.schema_version = '1.0.0';
  oldProducerSample.profile_id = 'ordinary-voice-relay-v1';
  oldProducerSample.admission.limiting_dimensions = ['voice.rtp_legs'];
  oldProducerSample.dimensions = {
    voice: {
      rtp_legs: {
        unit: 'count',
        safe_capacity: 0,
        used: 0,
        reserved: 0,
        confidence: 'unknown',
        source: 'unknown'
      }
    }
  };
  delete oldProducerSample.evidence;
  assert.equal(
    validate(oldProducerSample),
    true,
    validate.errors?.map((error) =>
      `${error.instancePath || '/'} ${error.message}`
    ).join('\n')
  );

  const unknownBridgeDimension = structuredClone(sample);
  unknownBridgeDimension.dimensions.voice_livekit_bridge.unknown_dimension = {
    unit: 'count',
    safe_capacity: 0,
    used: 0,
    reserved: 0,
    confidence: 'unknown',
    source: 'unknown'
  };
  assert.equal(validate(unknownBridgeDimension), false);

  const wrongProfile = structuredClone(sample);
  wrongProfile.profile_id = 'ordinary-voice-relay-v1';
  assert.equal(validate(wrongProfile), false);

  const inheritedEvidence = structuredClone(sample);
  inheritedEvidence.evidence.results_inheritable = true;
  assert.equal(validate(inheritedEvidence), false);

  const oldVersionBridge = structuredClone(sample);
  oldVersionBridge.schema_version = '1.0.0';
  assert.equal(validate(oldVersionBridge), false);

  const missingBridgeDimension = structuredClone(sample);
  delete missingBridgeDimension.dimensions.voice_livekit_bridge
    .handoff_reconciliation_cps;
  assert.equal(validate(missingBridgeDimension), false);

  const unverifiedPositiveCapacity = structuredClone(sample);
  unverifiedPositiveCapacity.dimensions.voice_livekit_bridge
    .bridge_generations.safe_capacity = 1;
  assert.equal(validate(unverifiedPositiveCapacity), false);

  const verifiedWithoutBundle = structuredClone(sample);
  verifiedWithoutBundle.evidence.status = 'verified';
  assert.equal(validate(verifiedWithoutBundle), false);

  const wrongGapUnit = structuredClone(sample);
  wrongGapUnit.dimensions.voice_livekit_bridge.switch_gap_p99_ms.unit =
    'count';
  assert.equal(validate(wrongGapUnit), false);

  const wrongBridgeCountUnit = structuredClone(sample);
  wrongBridgeCountUnit.dimensions.voice_livekit_bridge
    .bridge_generations.unit = 'milliseconds';
  assert.equal(validate(wrongBridgeCountUnit), false);
});
