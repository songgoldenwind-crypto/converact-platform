import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const RUSTPBX_COMMIT =
  '6c49ee76baa54fdbf8f98020cc9bee158c7c15de';
const RUSTRTC_COMMIT =
  '166c6d22984429eb6b509920c14fcd69f974f0b3';
const RTPENGINE_COMMIT =
  '506cfa74386a5373e40fca139a932917f22f0524';
const VOICE_MEDIA_MANIFEST = 'services/voice-media-rs/Cargo.toml';
const AUDIO_CODEC_FORK =
  'services/voice-media-rs/vendor/audio-codec-g711-opus';
const AUDIO_CODEC_UPSTREAM_COMMIT =
  'b074337d37be797771b258daacafb87aa833c015';
const AUDIO_CODEC_UPSTREAM_SHA256 =
  'c1affd3ba1faa8ae5c47c98f6c5e36eb321f4cb4567d7a7e1a8f3452fe40d57a';
const G729_GATES = [
  'license_review',
  'patent_legal_review',
  'extraction',
  'dependency_closure',
  'annex_a',
  'annex_b_vad_dtx_cng',
  'annex_b_fmtp_negotiation',
  'annex_b_missing_parameter_default',
  'annex_b_asymmetric_offer_answer',
  'packetization_10ms',
  'packetization_20ms',
  'packetization_30ms',
  'packetization_40ms',
  'packetization_60ms',
  'rtp_encoding_g729_8000',
  'static_payload_type_18',
  'dynamic_payload_type_remap',
  'speech_sid_no_data_framing',
  'sid_no_data',
  'plc',
  'reference_vectors',
  'g711_pairs',
  'opus_pairs',
  'interoperability',
  'quality',
  'allocation',
  'latency',
  'sessions_per_core',
  'supply_chain',
  'production_eligibility'
] as const;

function g729Mode(
  modeId: 'G729A' | 'G729AB',
  annexB: boolean
): Record<string, any> {
  const pairs = [
    `PCMU_TO_${modeId}`,
    `${modeId}_TO_PCMU`,
    `PCMA_TO_${modeId}`,
    `${modeId}_TO_PCMA`,
    `OPUS_TO_${modeId}`,
    `${modeId}_TO_OPUS`
  ];
  return {
    mode_id: modeId,
    annex_b_mode: annexB,
    codec_pairs: pairs.map((pair_id) => ({
      pair_id,
      capacity_profile_id: null,
      verification: 'not_run'
    })),
    independent_peer: { status: 'not_run', identity: null },
    reference_vector_artifact: { status: 'not_run', artifact: null },
    quality_profile: { status: 'not_run', profile_id: null },
    performance_profile: { status: 'not_run', profile_id: null },
    verification: 'not_run'
  };
}

function expectedG729Slice(): Record<string, any> {
  const codec_modes = [
    g729Mode('G729A', false),
    g729Mode('G729AB', true)
  ];
  return {
    slice_id: 'g729-v1',
    codecs: ['PCMU', 'PCMA', 'OPUS', 'G729A', 'G729AB'],
    codec_pairs: codec_modes.flatMap((mode) =>
      mode.codec_pairs.map((pair: Record<string, any>) => pair.pair_id)
    ),
    codec_modes,
    sample_rate_hz: 8000,
    frame_ms: 10,
    samples_per_frame: 80,
    packetization_ms: [10, 20, 30, 40, 60],
    rtp_wire: {
      encoding_name: 'G729',
      clock_rate_hz: 8000,
      static_payload_type: 18,
      dynamic_payload_type_min: 96,
      dynamic_payload_type_max: 127,
      dynamic_remap_scope: 'leg_and_binding_revision'
    },
    payload_framing: {
      speech_frame_octets: 10,
      sid_frame_octets: 2,
      speech_frames_per_packet: [1, 2, 3, 4, 6],
      sid_position: 'zero_or_one_after_zero_or_more_speech_frames',
      no_data_semantics:
        'silence_suppression_no_rtp_packet_not_zero_length_speech_frame'
    },
    annex_b_fmtp_negotiation: {
      status: 'not_run',
      parameter: 'annexb',
      missing_parameter_default: 'yes',
      asymmetric_offer_answer_rule: 'explicit_no_wins',
      g729a_expected_value: 'no',
      g729ab_expected_value: 'yes'
    },
    capacity_profile_id: null,
    verification: 'not_run',
    runtime_enabled: false,
    legal_boundary: {
      status: 'not_run',
      blocks: [
        'production_distribution',
        'runtime_enablement',
        'production_eligibility'
      ],
      does_not_block: [
        'engineering_implementation',
        'source_extraction',
        'compilation',
        'testing'
      ],
      external_legal_conclusion_required: true
    },
    acceptance_gates: Object.fromEntries(
      G729_GATES.map((gate) => [gate, 'not_run'])
    )
  };
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function validator(schemaPath: string): ReturnType<Ajv2020['compile']> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) &&
        new Date(parsed).toISOString() === value;
    }
  });
  return ajv.compile(json(schemaPath));
}

function validated(
  schemaPath: string,
  documentPath: string
): Record<string, any> {
  const document = json(documentPath);
  const validate = validator(schemaPath);
  assert.equal(
    validate(document),
    true,
    validate.errors?.map((error) =>
      `${error.instancePath || '/'} ${error.message}`
    ).join('\n')
  );
  return document;
}

function contract(): Record<string, any> {
  return validated(
    'docs/capacity/schemas/voice-media-goal4.schema.json',
    'docs/capacity/contracts/voice-media-goal4-v1.json'
  );
}

function profile(): Record<string, any> {
  return validated(
    'docs/capacity/schemas/voice-media-processing-profile.schema.json',
    'docs/capacity/profiles/vos-eq-v3-g711-opus-1k-v1.json'
  );
}

test('Goal 4 freezes the processing source and authority boundary', () => {
  const document = contract();
  assert.deepEqual(document.sources, {
    rustpbx: {
      repository: 'https://github.com/restsend/rustpbx',
      commit: RUSTPBX_COMMIT
    },
    rustrtc: {
      repository: 'https://github.com/restsend/rustrtc',
      commit: RUSTRTC_COMMIT
    },
    rtpengine: {
      repository: 'https://github.com/sipwise/rtpengine',
      commit: RTPENGINE_COMMIT
    },
    audio_codec: {
      crate: 'audio-codec',
      version: '0.3.40',
      integration: 'local_path_fork',
      path: AUDIO_CODEC_FORK,
      upstream_repository: 'https://github.com/restsend/audio-codec',
      upstream_commit: AUDIO_CODEC_UPSTREAM_COMMIT,
      upstream_crate_sha256: AUDIO_CODEC_UPSTREAM_SHA256,
      upstream_crate_bytes: 24377,
      license: 'MIT',
      retained_modules: ['pcmu', 'pcma', 'opus', 'resampler'],
      removed_modules: ['g722', 'g729', 'telephone_event'],
      g729_source_authority: 'rvoip_g729_candidate_only',
      g729_runtime_enabled: false
    },
    processing_module: {
      path: 'services/voice-media-rs',
      version: '0.2.0',
      production_topology: 'embedded_library',
      diagnostic_binary: true,
      control_interface: 'direct_rust_adapter'
    },
    rvoip_g729_candidate: {
      manifest: 'docs/capacity/forks/rvoip-g729-source-candidate-v1.json',
      candidate_id: 'rvoip-g729-codec-core-v1',
      repository: 'https://github.com/eisenzopf/rvoip',
      commit: '4ced02b7f6e73041c848f1765dc2bcf7588796f0',
      tree: '74dabd314841d99e1a87dbdaca6050fc4e8ed923',
      archive_sha256: '16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e',
      archive_bytes: 8594565,
      source_set_sha256: 'bbc645b365a3b0d86fd2c05881d7911d65b880b695b1483dba856903bae223ad'
    }
  });
  assert.equal(document.authority.call_dialog_owner, 'rustpbx');
  assert.equal(document.authority.logical_media_graph_owner, 'rustpbx');
  assert.equal(document.authority.media_plan_owner, 'rustpbx');
  assert.equal(
    document.authority.edge_binding_authority,
    'rustpbx_media_engine_facade'
  );
  assert.equal(document.authority.writer_scope, 'directed_media_edge');
  assert.equal(document.authority.fast_path_owner, 'rtpengine');
  assert.equal(document.authority.processing_owner, 'voice-media-rs');
  assert.equal(
    document.authority.command_authority,
    'rustpbx_media_engine_facade'
  );
  assert.equal(document.authority.packet_path_remote_dependency, false);
  assert.equal(
    document.authority.ordinary_relay_enters_processing_backend,
    false
  );
});

test('Goal 4 freezes the first directed codec-pair slice', () => {
  const document = contract();
  const slice = document.codec_slices.find(
    (entry: Record<string, any>) => entry.slice_id === 'g711-opus-v1'
  );
  assert.ok(slice);
  assert.deepEqual(slice.codecs, ['PCMU', 'PCMA', 'OPUS']);
  assert.deepEqual(slice.packetization_ms, [20]);
  assert.deepEqual(slice.codec_pairs, [
    'PCMU_TO_PCMA',
    'PCMA_TO_PCMU',
    'PCMU_TO_OPUS',
    'OPUS_TO_PCMU',
    'PCMA_TO_OPUS',
    'OPUS_TO_PCMA'
  ]);
  assert.equal(slice.capacity_profile_id, 'vos-eq-v3-g711-opus-1k-v1');
  assert.equal(slice.verification, 'not_run');
});

test('Goal 4 makes every realtime queue and codec slot bounded', () => {
  const runtime = contract().processing_runtime;
  assert.equal(runtime.production_process_scope, 'unified_rustpbx');
  assert.equal(runtime.control_transport, 'in_process');
  assert.deepEqual(runtime.edge_command_identity_fields, [
    'media_plan_id',
    'media_plan_revision',
    'edge_id',
    'edge_generation',
    'binding_revision',
    'binding_group_id',
    'binding_group_generation',
    'flow_selector',
    'backend_id',
    'writer_fence'
  ]);
  assert.equal(runtime.worker_shards_fixed, true);
  assert.equal(runtime.control_and_media_cpu_budgets_isolated, true);
  assert.equal(runtime.per_edge_writer_fenced, true);
  assert.equal(runtime.active_backend_handoff_overlap, false);
  assert.equal(
    runtime.edge_logical_release_scope,
    'directed_media_edge_generation_detach'
  );
  assert.equal(
    runtime.physical_release_scope,
    'backend_binding_group_generation'
  );
  assert.equal(runtime.physical_release_requires_zero_live_member_refs, true);
  assert.equal(runtime.inbound_handoff_grace_bounded, true);
  assert.equal(runtime.codec_pair_slots_bounded, true);
  assert.equal(runtime.rtp_receive_queue_bounded, true);
  assert.equal(runtime.jitter_buffer_bounded, true);
  assert.equal(runtime.playback_queue_bounded, true);
  assert.equal(runtime.event_queue_bounded, true);
  assert.equal(runtime.unknown_codec_fail_closed, true);
  assert.equal(runtime.cross_pair_slot_borrowing, false);
  const document = contract();
  assert.equal(
    document.binding_group_model.packet_flow_lookup_complexity,
    'O(1)'
  );
  assert.equal(
    document.binding_group_model.packet_flow_lookup_scans_group_members,
    false
  );
  assert.equal(
    document.binding_group_model.edge_binding_cardinality,
    'each_edge_generation_binding_maps_to_exactly_one_group_flow'
  );
  assert.equal(
    document.binding_group_model.reverse_mapping_rule,
    'group_member_set_exactly_matches_forward_edge_bindings'
  );
  assert.equal(
    document.binding_group_model.orphan_edge_or_group_members_allowed,
    false
  );
  assert.ok(
    document.binding_group_model.group_identity_fields.includes(
      'membership_digest'
    )
  );
  assert.ok(
    document.binding_group_model.wire_transport_bundle_fields.includes(
      'effective_sdp_views'
    )
  );
  assert.equal(
    document.binding_group_model.security_persistence_rule,
    'raw_srtp_keys_forbidden_persist_references_states_and_digests_only'
  );
  assert.equal(
    document.dtmf_event_authority.owner,
    'rustpbx_leg_dtmf_event_authority'
  );
  assert.deepEqual(
    document.dtmf_event_authority.sources_in_precedence_order,
    [
      'negotiated_rfc4733',
      'explicitly_accepted_sip_info',
      'in_band_detector'
    ]
  );
  assert.equal(
    document.dtmf_event_authority.business_side_effect_limit_per_canonical_event,
    1
  );
  assert.equal(
    document.failure_classification
      .ordinary_rtpengine_edge_on_unified_process_loss,
    'continue_degraded'
  );
  assert.equal(
    document.failure_classification
      .embedded_edge_on_unified_process_loss,
    'interrupt_visible'
  );
  assert.ok(
    Object.values(document.failure_isolation_gates)
      .every((status) => status === 'not_run')
  );
});

test('Goal 4 metric labels are bounded and reject interaction identity', () => {
  const metrics = contract().metrics;
  assert.deepEqual(metrics.allowed_labels, [
    'codec_pair',
    'direction',
    'profile',
    'result',
    'failure_stage',
    'runtime_mode'
  ]);
  for (const forbidden of [
    'tenant_id',
    'call_id',
    'leg_id',
    'reservation_id',
    'phone_number',
    'ssrc'
  ]) {
    assert.ok(metrics.forbidden_labels.includes(forbidden), forbidden);
    assert.ok(!metrics.allowed_labels.includes(forbidden), forbidden);
  }
});

test('Goal 4 profile binds co-resident Unified RustPBX and 1K processing target', () => {
  const document = profile();
  assert.equal(
    document.primary_sut.role,
    'unified_control_and_embedded_processing'
  );
  assert.equal(document.primary_sut.component_id, 'unified-rustpbx');
  assert.equal(
    document.production_topology.deployment_profile_id,
    'CARRIER-CELL-V1'
  );
  assert.equal(document.production_topology.voice_media_co_resident, true);
  assert.equal(
    document.production_topology.cpu_partition
      .sip_call_control_reserved_cores +
      document.production_topology.cpu_partition.embedded_media_max_cores +
      document.production_topology.cpu_partition.os_irq_reserved_cores,
    document.production_topology.cpu_partition.total_physical_cores
  );
  assert.equal(
    document.production_topology.intrinsic_microbench.production_authorizing,
    false
  );
  assert.equal(
    document.source_identity.media_plan_compiler_revision,
    'target-r3-not-run'
  );
  assert.equal(
    document.source_identity.backend_selector_revision,
    'carrier-cell-v1-target-r3-not-run'
  );
  assert.equal(
    document.source_identity.backend_mix_id,
    'rtpengine-ordinary-plus-embedded-processing-v2'
  );
  assert.equal(document.workload.active_processing_sessions, 1_000);
  assert.equal(document.workload.rtp_legs, 2_000);
  assert.equal(document.workload.packetization_ms, 20);
  assert.equal(document.workload.transcoding, true);
  assert.deepEqual(document.workload.backend_mix, {
    ordinary_edge_backend: 'rtpengine',
    decode_required_edge_backend: 'embedded_voice_media_rs',
    selector_revision: 'carrier-cell-v1-target-r3-not-run',
    profile_results_transferable_to_other_mix: false
  });
  assert.equal(document.generator.separate_from_sut, true);
  assert.equal(document.generator.minimum_nodes, 2);
  assert.equal(document.generator.maximum_cpu_utilization_ratio, 0.7);
  assert.equal(document.thresholds.processing_latency_p99_ms, 10);
  assert.equal(document.thresholds.sip_setup_latency_p99_ms, 250);
  assert.equal(document.thresholds.sip_timer_lag_p99_ms, 10);
  assert.equal(document.thresholds.server_packet_loss_ratio, 0.001);
  assert.equal(document.thresholds.unexpected_ordinary_relay_termination_count, 0);
});

test('Goal 4 failure matrix isolates ordinary relay from processing failures', () => {
  const failures = new Map<string, Record<string, any>>(
    contract().failure_matrix.map((entry: Record<string, any>) => [
      entry.failure_id,
      entry
    ])
  );
  for (const id of [
    'processing-capacity-exhausted',
    'processing-control-unavailable',
    'processing-worker-restart',
    'unified-rustpbx-process-unavailable',
    'postgres-unavailable',
    'nats-unavailable',
    'recorder-unavailable',
    'object-storage-unavailable'
  ]) {
    assert.ok(failures.has(id), id);
    assert.ok(
      ['continue', 'continue_degraded']
        .includes(failures.get(id)?.ordinary_relay),
      id
    );
  }
  assert.equal(
    failures.get('processing-capacity-exhausted')?.new_processing_admission,
    'reject'
  );
  assert.equal(
    failures.get('unified-rustpbx-process-unavailable')
      ?.established_processing,
    'interrupt_visible'
  );
  assert.equal(
    failures.get('unified-rustpbx-process-unavailable')?.ordinary_relay,
    'continue_degraded'
  );
});

test('Goal 4 starts with no functional or capacity claim', () => {
  const document = contract();
  for (const [key, value] of Object.entries(document.verification)) {
    assert.equal(value, 'not_run', key);
  }
  assert.deepEqual(document.claim, {
    functional: 'not_run',
    production: 'not_run',
    benchmark: 'not_run',
    capacity_claim: 'none',
    production_eligible: false
  });
  assert.equal(profile().claim.capacity_claim, 'none');
});

test('Goal 4 binds the pinned G.729 source candidate without promoting it', () => {
  const manifestPath = 'docs/capacity/forks/rvoip-g729-source-candidate-v1.json';
  assert.ok(existsSync(manifestPath), `missing required artifact: ${manifestPath}`);
  if (!existsSync(manifestPath)) return;
  const document = contract();
  const candidate = json(manifestPath);
  const bound = document.sources.rvoip_g729_candidate;
  assert.deepEqual(bound, { manifest: manifestPath, candidate_id: 'rvoip-g729-codec-core-v1', repository: 'https://github.com/eisenzopf/rvoip', commit: '4ced02b7f6e73041c848f1765dc2bcf7588796f0', tree: '74dabd314841d99e1a87dbdaca6050fc4e8ed923', archive_sha256: '16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e', archive_bytes: 8594565, source_set_sha256: 'bbc645b365a3b0d86fd2c05881d7911d65b880b695b1483dba856903bae223ad' });
  assert.equal(bound.candidate_id, candidate.candidate_id); assert.equal(bound.repository, candidate.source.repository); assert.equal(bound.commit, candidate.source.commit); assert.equal(bound.tree, candidate.source.tree); assert.equal(bound.archive_sha256, candidate.source.archive.sha256); assert.equal(bound.archive_bytes, candidate.source.archive.bytes); assert.equal(bound.source_set_sha256, candidate.source_set_sha256);
  const slice = document.codec_slices.find((entry: Record<string, any>) => entry.slice_id === 'g729-v1'); assert.ok(slice);
  assert.deepEqual(slice, expectedG729Slice());
  for (const [gate, status] of Object.entries(candidate.gates)) {
    assert.equal(slice.acceptance_gates[gate], status, gate);
  }
  for (const [key, value] of Object.entries(document.verification)) assert.equal(value, 'not_run', key);
  assert.deepEqual(candidate.claim, { capacity_claim: 'none', production_eligible: false, runtime_enabled: false });
  assert.deepEqual(document.claim, { functional: 'not_run', production: 'not_run', benchmark: 'not_run', capacity_claim: 'none', production_eligible: false });
});

test('Goal 4 schema rejects every G.729 or no-claim promotion attack', () => {
  const validate = validator(
    'docs/capacity/schemas/voice-media-goal4.schema.json'
  );
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ['missing G729 pair', value => {
      const slice = value.codec_slices.find(
        (entry: Record<string, any>) => entry.slice_id === 'g729-v1'
      );
      slice.codec_pairs.pop();
    }],
    ['merged mode pair evidence', value => {
      const slice = value.codec_slices.find(
        (entry: Record<string, any>) => entry.slice_id === 'g729-v1'
      );
      slice.codec_modes[1].codec_pairs[0].capacity_profile_id = 'merged-v1';
    }],
    ['G729 gate promotion', value => {
      const slice = value.codec_slices.find(
        (entry: Record<string, any>) => entry.slice_id === 'g729-v1'
      );
      slice.acceptance_gates.annex_b_fmtp_negotiation = 'controlled_pass';
    }],
    ['G729 verification promotion', value => {
      const slice = value.codec_slices.find(
        (entry: Record<string, any>) => entry.slice_id === 'g729-v1'
      );
      slice.verification = 'controlled_pass';
    }],
    ['G729 runtime enablement', value => {
      const slice = value.codec_slices.find(
        (entry: Record<string, any>) => entry.slice_id === 'g729-v1'
      );
      slice.runtime_enabled = true;
    }],
    ['global verification promotion', value => {
      value.verification.schema = 'controlled_pass';
    }],
    ['functional claim promotion', value => {
      value.claim.functional = 'functional_pass';
    }],
    ['capacity claim promotion', value => {
      value.claim.capacity_claim = '1k';
    }]
  ];
  for (const [label, mutate] of cases) {
    const fixture = structuredClone(contract());
    mutate(fixture);
    assert.equal(validate(fixture), false, label);
  }
});

test('Goal 4 normal, development, and build graphs exclude g729-sys', () => {
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  assert.equal(rustc.status, 0, rustc.stderr);
  const host = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
  assert.ok(host, rustc.stdout);
  const metadata = spawnSync('cargo', [
    'metadata',
    '--locked',
    '--all-features',
    '--filter-platform',
    host,
    '--format-version',
    '1',
    '--manifest-path',
    VOICE_MEDIA_MANIFEST
  ], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  const graph = JSON.parse(metadata.stdout) as Record<string, any>;
  const packageNames = graph.packages.map(
    (entry: Record<string, any>) => entry.name
  );
  assert.ok(!packageNames.includes('g729-sys'), packageNames.join('\n'));
  assert.doesNotMatch(
    readFileSync('services/voice-media-rs/Cargo.lock', 'utf8'),
    /^name = "g729-sys"$/m,
    'locked all-target package universe must exclude g729-sys'
  );

  const codec = graph.packages.find(
    (entry: Record<string, any>) => entry.name === 'audio-codec'
  );
  assert.ok(codec, 'audio-codec package missing from Cargo metadata');
  assert.equal(codec.version, '0.3.40');
  assert.equal(codec.source, null);
  assert.ok(
    codec.manifest_path.endsWith(`${AUDIO_CODEC_FORK}/Cargo.toml`),
    codec.manifest_path
  );
  assert.deepEqual(
    codec.dependencies.map((entry: Record<string, any>) => entry.name).sort(),
    ['opus-rs']
  );

  for (const edges of ['normal', 'dev', 'build']) {
    const tree = spawnSync('cargo', [
      'tree',
      '--locked',
      '--all-features',
      '--edges',
      edges,
      '--manifest-path',
      VOICE_MEDIA_MANIFEST
    ], { encoding: 'utf8' });
    assert.equal(tree.status, 0, tree.stderr);
    assert.doesNotMatch(tree.stdout, /\bg729-sys\b/, edges);
  }

  const inverse = spawnSync('cargo', [
    'tree',
    '--locked',
    '--all-features',
    '--invert',
    'g729-sys',
    '--manifest-path',
    VOICE_MEDIA_MANIFEST
  ], { encoding: 'utf8' });
  assert.notEqual(inverse.status, 0, inverse.stdout);
  assert.match(inverse.stderr, /did not match any packages/i);

  for (const path of [
    `${AUDIO_CODEC_FORK}/LICENSE`,
    `${AUDIO_CODEC_FORK}/UPSTREAM.md`
  ]) {
    assert.ok(existsSync(path), path);
  }
  const provenance = readFileSync(`${AUDIO_CODEC_FORK}/UPSTREAM.md`, 'utf8');
  assert.match(provenance, new RegExp(AUDIO_CODEC_UPSTREAM_COMMIT));
  assert.match(provenance, new RegExp(AUDIO_CODEC_UPSTREAM_SHA256));
  assert.match(provenance, /not (?:a|the) G\.729 implementation source/i);
  const compatibilitySurface = readFileSync(
    `${AUDIO_CODEC_FORK}/src/lib.rs`,
    'utf8'
  );
  assert.doesNotMatch(
    compatibilitySurface,
    /G729|g729|bytes_to_samples|samples_to_bytes|create_opus_/,
    'local compatibility surface must expose only current consumers'
  );
});

test('Goal 4 fork registry pins the minimal audio-codec compatibility fork', () => {
  const registry = json('docs/capacity/forks/ivekit-forks-v1.json');
  const fork = registry.components.find(
    (entry: Record<string, any>) =>
      entry.component_id === 'audio-codec-g711-opus'
  );
  assert.ok(fork, 'audio-codec compatibility fork is not registered');
  assert.equal(fork.lifecycle, 'active_engineering');
  assert.equal(fork.integration_mode, 'maintained_fork');
  assert.deepEqual(fork.upstream, {
    repository: 'https://github.com/restsend/audio-codec',
    version: '0.3.40',
    pin_kind: 'exact_commit',
    commit: AUDIO_CODEC_UPSTREAM_COMMIT,
    source_identity_complete: true,
    source_archive: {
      url: 'https://static.crates.io/crates/audio-codec/audio-codec-0.3.40.crate',
      sha256: AUDIO_CODEC_UPSTREAM_SHA256,
      size_bytes: 24377
    }
  });
  assert.deepEqual(fork.verification.evidence_paths, [
    `${AUDIO_CODEC_FORK}/LICENSE`,
    `${AUDIO_CODEC_FORK}/UPSTREAM.md`,
    `${AUDIO_CODEC_FORK}/src`,
    'services/voice-media-rs/Cargo.lock',
    'test/ivekit-voice-media-goal4-contract.test.ts'
  ]);
  assert.equal(fork.release_gate.production_eligible, false);
  assert.equal(fork.traceability.upstream_license, 'MIT');
  assert.equal(fork.traceability.notice_recorded, true);
});
