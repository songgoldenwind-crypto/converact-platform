import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

const contractPath =
  "docs/capacity/contracts/unified-voice-foundation-r4-v1.json";
const schemaPath =
  "docs/capacity/schemas/unified-voice-foundation-r4.schema.json";

type JsonObject = Record<string, unknown>;

interface UnifiedVoiceFoundationContract extends JsonObject {
  schema_version: string;
  contract_id: string;
  revision: number;
  status: string;
  binding_objective: JsonObject;
  implementation_plan: JsonObject;
  authority_bindings: JsonObject;
  source_identity: JsonObject;
  claim_boundary: JsonObject;
  architecture_profile: JsonObject;
  authority_matrix: JsonObject;
  receipt_facts: JsonObject;
  wire_freeze: JsonObject;
  sip_transaction_policy: JsonObject;
  backend_capability_sets: JsonObject[];
  media_graph_compiler: JsonObject;
  rtpengine_atomic_lifecycle: JsonObject;
  recovery_matrix: JsonObject[];
  durable_store_slo: JsonObject;
  edge_to_core_policy: JsonObject;
  rolling_schema_rules: JsonObject;
  clocks: JsonObject;
  migration_drain: JsonObject;
  single_process_failure_scope: JsonObject;
  g729: JsonObject;
  dtmf: JsonObject;
  media_protocol_invariants: JsonObject;
  livekit_handoff: JsonObject;
  capacity_demand: JsonObject;
  small_conference: JsonObject;
  security: JsonObject;
  quality: JsonObject;
  current_target_eligibility: JsonObject[];
  phase_gates: JsonObject[];
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function object(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function validator(): ValidateFunction<UnifiedVoiceFoundationContract> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  const schema = json(schemaPath);
  object(schema, "schema");
  return ajv.compile<UnifiedVoiceFoundationContract>(schema);
}

function contract(): UnifiedVoiceFoundationContract {
  const value = json(contractPath);
  const validate = validator();
  if (!validate(value)) {
    assert.fail(
      validate.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("\n"),
    );
  }
  return value;
}

function namedValues(
  value: unknown,
  key: string,
  output: unknown[] = [],
): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) namedValues(entry, key, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [name, entry] of Object.entries(value)) {
    if (name === key) output.push(entry);
    namedValues(entry, key, output);
  }
  return output;
}

function rejectMutation(
  label: string,
  mutate: (value: UnifiedVoiceFoundationContract) => void,
): void {
  const value = structuredClone(contract());
  mutate(value);
  const validate = validator();
  assert.equal(
    validate(value),
    false,
    `${label} must be rejected by the schema`,
  );
}

function assertUniqueSemanticKeys(
  rows: JsonObject[],
  key: string,
  label: string,
): void {
  const values = rows.map((row) => row[key]);
  assert.ok(
    values.every((value) => typeof value === "string"),
    `${label}.${key} must be strings`,
  );
  assert.equal(
    new Set(values).size,
    values.length,
    `${label}.${key} must be unique`,
  );
}

type JsonPath = Array<string | number>;

function valueAtPath(root: unknown, path: JsonPath): unknown {
  let cursor = root as any;
  for (const segment of path) cursor = cursor[segment];
  return cursor as unknown;
}

function leafPaths(value: unknown, prefix: JsonPath = []): JsonPath[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      leafPaths(entry, [...prefix, index]),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry, [...prefix, key]),
    );
  }
  return [prefix];
}

function objectPaths(value: unknown, prefix: JsonPath = []): JsonPath[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      objectPaths(entry, [...prefix, index]),
    );
  }
  if (value === null || typeof value !== "object") return [];
  return [
    prefix,
    ...Object.entries(value).flatMap(([key, entry]) =>
      objectPaths(entry, [...prefix, key]),
    ),
  ];
}

function mutateLeaf(root: unknown, path: JsonPath): void {
  assert.ok(path.length > 0);
  const parent = valueAtPath(root, path.slice(0, -1)) as any;
  const key = path.at(-1) as string | number;
  const current = parent[key] as unknown;
  parent[key] =
    typeof current === "boolean"
      ? !current
      : typeof current === "number"
        ? current + 1
        : typeof current === "string"
          ? `${current}__invalid_mutation`
          : "__invalid_mutation";
}

test("Revision 4 authoritative schema and contract exist and validate", () => {
  assert.ok(existsSync(schemaPath), `missing ${schemaPath}`);
  assert.ok(existsSync(contractPath), `missing ${contractPath}`);
  const schema = json(schemaPath);
  object(schema, "schema");
  assert.equal(
    schema.$id,
    "https://opc.local/schemas/unified-voice-foundation-r4.schema.json",
  );
  const validate = validator();
  const value = json(contractPath);
  assert.equal(
    validate(value),
    true,
    validate.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("\n"),
  );
});

test("Revision 4 schema is closed at the contract and nested policy boundaries", () => {
  const validate = validator();
  const topLevelDrift = structuredClone(contract()) as JsonObject;
  topLevelDrift.unreviewed_extension = true;
  assert.equal(validate(topLevelDrift), false, "top-level drift must fail");

  const nestedDrift = structuredClone(contract());
  nestedDrift.receipt_facts.unreviewed_extension = true;
  assert.equal(validate(nestedDrift), false, "nested drift must fail");
});

test("Revision 4 rejects unknown fields at every nested object boundary", () => {
  const baseline = contract();
  const validate = validator();
  for (const path of objectPaths(baseline)) {
    const fixture = structuredClone(baseline);
    const target = valueAtPath(fixture, path);
    object(target, `contract/${path.join("/") || "<root>"}`);
    target.__unknown_contract_field = true;
    assert.equal(
      validate(fixture),
      false,
      `contract/${path.join("/") || "<root>"} must reject unknown fields`,
    );
  }
});

test("Revision 4 freezes source identity and all production claims closed", () => {
  const value = contract();
  assert.deepEqual(value.source_identity, {
    repository_head: "4cefaa5eb85a91e60e228b04062de11b65153198",
    branch: "codex/ivekit-v5-shared-foundation",
    canonical_plan:
      "docs/superpowers/plans/2026-07-29-unified-voice-foundation-r4.md",
    canonical_design:
      "docs/design/rvoip-opc-communication-foundation-integration-design.md",
    canonical_adr:
      "docs/adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md",
    livekit_handoff_adr: "docs/adr/ccaas-8-voice-livekit-bridge-handoff.md",
    rvoip_contract:
      "docs/capacity/contracts/rvoip-capability-integration-v1.json",
    voice_media_goal4_contract:
      "docs/capacity/contracts/voice-media-goal4-v1.json",
    rvoip_capability_count: 198,
    rvoip_replacement_gate_count: 14,
  });
  assert.deepEqual(value.claim_boundary, {
    capacity_claim: "none",
    physical_result_status: "not_run",
    production_result_status: "not_run",
    production_eligible: false,
    runtime_enablement: false,
    upstream_claim_authorizes_ivekit: false,
    local_microbenchmark_authorizes_production: false,
    borrowed_evidence_allowed: false,
    results_inheritable: false,
  });
  assert.ok(namedValues(value, "production_eligible").length > 5);
  assert.ok(
    namedValues(value, "production_eligible").every((entry) => entry === false),
  );
  assert.ok(
    namedValues(value, "physical_result_status").every(
      (entry) => entry === "not_run",
    ),
  );
  assert.ok(
    namedValues(value, "production_result_status").every(
      (entry) => entry === "not_run",
    ),
  );
});

test("Revision 4 freezes one authority per irreversible domain", () => {
  const authority = contract().authority_matrix;
  assert.equal(
    (authority.telephony_business as JsonObject).owner,
    "unified_rustpbx_call_core",
  );
  assert.equal((authority.room_webrtc as JsonObject).owner, "livekit");
  assert.equal(
    (authority.recording_manifest as JsonObject).owner,
    "region_recording_plane",
  );
  assert.equal(
    (authority.billing_rating as JsonObject).owner,
    "opc_ivekit_billing",
  );
  assert.equal(
    (authority.directed_media_edge_generation as JsonObject).owner,
    "rustpbx_media_engine_facade",
  );
  assert.equal(authority.livekit_sip_role, "executor_not_authority");
});

test("Revision 4 freezes honest receipts and wire construction order", () => {
  const value = contract();
  assert.deepEqual(value.receipt_facts.levels, [
    "durable_decision",
    "send_attempted",
    "transport_accepted",
    "transport_completed",
    "protocol_observed",
    "failed",
    "unknown",
  ]);
  assert.equal(value.receipt_facts.network_exactly_once, false);
  assert.equal(value.receipt_facts.query_scope, "local_durable_facts");
  assert.equal(
    value.receipt_facts.transport_acceptance_proves_peer_receipt,
    false,
  );
  assert.equal(
    value.receipt_facts.transport_completion_proves_peer_receipt,
    false,
  );
  assert.equal(
    value.receipt_facts.retransmission_rule,
    "same_transaction_identity_and_wire_bytes_hash",
  );
  assert.deepEqual(value.wire_freeze.ordered_stages, [
    "semantic_intent",
    "route_transport_local_endpoint_binding",
    "transaction_visible_fields_and_wire_bytes_hash_freeze",
    "durable_decision",
    "transmission",
  ]);
  for (const bindingFact of [
    "rfc3263_candidate",
    "route_set",
    "via_branch",
    "authorization_identity",
    "canonical_wire_bytes",
    "wire_bytes_hash",
  ]) {
    assert.ok(
      (value.wire_freeze.binding_facts as string[]).includes(bindingFact),
      bindingFact,
    );
  }
  assert.equal(value.wire_freeze.dns_connect_are_preparatory, true);
  assert.equal(value.wire_freeze.preparatory_actions_emit_sip, false);
  assert.equal(value.wire_freeze.post_decision_wire_mutation, "forbidden");
  assert.equal(
    value.sip_transaction_policy.non_2xx_ack_owner,
    "transaction_runtime",
  );
  assert.equal(
    value.sip_transaction_policy.ack_2xx_owner,
    "uac_core_protocol_dialog",
  );
  assert.equal(value.sip_transaction_policy.cancel_correlation_required, true);
  assert.equal(
    value.sip_transaction_policy.prack_match_rule,
    "exact_rseq_rack_early_dialog_and_transaction",
  );
  assert.equal(
    value.sip_transaction_policy.late_response_rule,
    "protocol_facts_only_no_business_state_resurrection",
  );
});

test("Revision 4 keeps backend eligibility fail closed and RTPengine atomicity unavailable", () => {
  const value = contract();
  assert.deepEqual(
    value.backend_capability_sets.map((entry) => entry.backend_id),
    [
      "embedded_voice_media",
      "livekit_sip_bridge",
      "rtpengine_ordinary",
      "rust_native_fast_path",
    ],
  );
  for (const backend of value.backend_capability_sets) {
    assert.equal(
      backend.eligibility_status,
      "not_run",
      backend.backend_id as string,
    );
    assert.equal(
      backend.production_eligible,
      false,
      backend.backend_id as string,
    );
    assert.ok(Array.isArray(backend.capabilities));
    assert.ok((backend.capabilities as unknown[]).length > 0);
  }
  assert.equal(value.rtpengine_atomic_lifecycle.required_target, true);
  assert.equal(
    value.rtpengine_atomic_lifecycle.current_availability,
    "unavailable",
  );
  assert.equal(
    value.rtpengine_atomic_lifecycle.required_patch_id,
    "rtpengine-ivekit-atomic-binding-lifecycle-v1",
  );
  assert.equal(
    value.rtpengine_atomic_lifecycle.active_migration_enabled,
    false,
  );
  assert.ok(
    (value.rtpengine_atomic_lifecycle.operations as JsonObject[]).every(
      (operation) => operation.status === "not_run",
    ),
  );
});

test("Revision 4 recovery is confirmed and quiescent only", () => {
  const rows = contract().recovery_matrix;
  assert.deepEqual(
    rows.map((row) => row.state_id),
    [
      "active_invite_transaction",
      "active_non_invite_transaction",
      "active_timers",
      "confirmed_quiescent_dialog",
      "dead_tcp_tls_flow",
      "dns_connection_attempt",
      "early_dialog",
      "pending_2xx_ack",
      "pending_prack_rseq_rack",
      "unknown_effect",
    ],
  );
  const confirmed = rows.find(
    (row) => row.state_id === "confirmed_quiescent_dialog",
  );
  assert.equal(confirmed?.target_policy, "restore");
  assert.equal(confirmed?.verification_status, "not_run");
  for (const row of rows.filter((entry) => entry !== confirmed)) {
    assert.equal(row.target_policy, "fail_closed_or_protocol_restart");
    assert.equal(row.lossless_restore_claim, false);
  }
  assert.ok(rows.every((row) => row.persist_runtime_instant === false));
  assert.ok(rows.every((row) => row.cross_adapter_restore === false));
});

test("Revision 4 freezes durable-store, Edge-to-Core, schema and clock policies", () => {
  const value = contract();
  assert.equal(
    value.durable_store_slo.authority,
    "postgresql_region_durable_store",
  );
  assert.equal(value.durable_store_slo.transaction_p99_budget_ms, 20);
  assert.equal(value.durable_store_slo.pool_size_ceiling, 256);
  assert.equal(value.durable_store_slo.queue_depth_ceiling, 1024);
  assert.equal(value.durable_store_slo.retry_attempt_ceiling, 3);
  assert.equal(
    value.durable_store_slo.existing_call_policy,
    "bounded_repair_no_unbounded_queue",
  );
  assert.equal(
    value.edge_to_core_policy.forwarding_mode,
    "raw_bytes_with_trusted_metadata",
  );
  assert.equal(value.edge_to_core_policy.raw_bytes_retained, true);
  assert.equal(value.edge_to_core_policy.canonical_bytes_hash_required, true);
  assert.equal(
    value.edge_to_core_policy.smuggling_ambiguity_policy,
    "reject_fail_closed",
  );
  assert.equal(
    value.rolling_schema_rules.compatibility_window,
    "n_and_n_plus_1",
  );
  assert.ok(
    (value.rolling_schema_rules.versioned_artifacts as string[]).includes(
      "effect_wal",
    ),
  );
  assert.ok(
    (value.rolling_schema_rules.versioned_artifacts as string[]).includes(
      "capacity_vector",
    ),
  );
  assert.equal(
    value.rolling_schema_rules.writer_rule,
    "oldest_live_reader_first",
  );
  assert.deepEqual(value.rolling_schema_rules.capacity_vector_rollout, {
    reader_n_version: "1.0.0",
    reader_n_plus_1_version: "1.1.0",
    n_reader_accepts_n_plus_1_writer: false,
    n_plus_1_reader_accepts_n_writer: true,
    n_plus_1_writer_enable_condition: "all_live_readers_support_1_1_0",
    bridge_absence_semantics: "unsupported_and_zero_advertised_bridge_capacity",
    rollback_writer_version: "1.0.0_until_all_1.0.0_readers_are_drained",
  });
  assert.equal(value.rolling_schema_rules.rollback_required, true);
  assert.equal(
    value.rolling_schema_rules.cross_adapter_snapshot_restore,
    false,
  );
  assert.equal(value.clocks.durable_audit_clock, "utc_wall_clock");
  assert.equal(value.clocks.sip_timer_deadline_clock, "monotonic");
  assert.equal(value.clocks.rtp_clock, "media_clock_domain");
  assert.equal(value.clocks.persist_runtime_instant, false);
  assert.equal(
    value.clocks.recovery_timer_rule,
    "rebase_from_durable_duration_and_elapsed_evidence",
  );
});

test("Revision 4 freezes bounded migration and one G.729 wire identity", () => {
  const value = contract();
  assert.equal(value.migration_drain.default_scope, "new_calls_only");
  assert.equal(value.migration_drain.old_calls, "drain_on_original_runtime");
  assert.equal(value.migration_drain.active_call_migration_status, "not_run");
  assert.equal(
    value.migration_drain.unknown_attempt_policy,
    "query_reconcile_before_removal",
  );
  assert.equal(value.migration_drain.zero_loss_claim, false);
  assert.equal(value.migration_drain.max_drain_duration_ms, 14_400_000);
  assert.deepEqual(value.g729, {
    external_wire_identity: "G729/8000",
    external_identity_count: 1,
    mandatory_internal_modes: ["G729A", "G729AB"],
    packetization_ms: [10, 20, 30, 40, 50, 60],
    speech_frames_per_packet: [1, 2, 3, 4, 5, 6],
    annex_b_missing_defaults_yes: true,
    annex_b_explicit_no_wins: true,
    engineering_status: "not_run",
    legal_distribution_status: "not_run",
    runtime_enablement: false,
    production_eligible: false,
  });
});

test("Revision 4 closes edge parsing, backend lifecycle and rolling schema authority", () => {
  const value = contract();
  const edge = value.edge_to_core_policy;
  assert.deepEqual(edge.schema_identity, {
    registry_id: "opc-persistent-schema-registry-v1",
    artifact_type: "edge_core_sip_contract",
    schema_id: "edge-core-sip-v1",
    schema_version: "1.0.0",
    authority: "unified_rustpbx_protocol_governance",
  });
  assert.deepEqual(edge.message_limits, {
    message_bytes_max: 65_535,
    start_line_bytes_max: 4_096,
    uri_bytes_max: 2_048,
    header_section_bytes_max: 32_768,
    header_count_max: 128,
    header_line_bytes_max: 8_192,
    body_bytes_max: 32_768,
  });
  const headers = edge.critical_header_policy as JsonObject;
  assert.deepEqual(Object.keys(headers.header_rules as JsonObject), [
    "Content-Length",
    "Via",
    "From",
    "To",
    "Call-ID",
    "CSeq",
    "Max-Forwards",
    "Contact",
    "Route",
    "Record-Route",
    "Authorization",
  ]);
  assert.equal(headers.conflict_policy, "reject_fail_closed");
  assert.equal(
    (edge.uri_policy as JsonObject).invalid_percent_encoding,
    "reject_fail_closed",
  );
  assert.equal(
    (edge.uri_policy as JsonObject).ipv6_literal,
    "brackets_required",
  );
  assert.equal((edge.uri_policy as JsonObject).uri_parameter_count_max, 32);
  assert.equal(
    (edge.uri_policy as JsonObject).uri_header_component_count_max,
    16,
  );
  assert.deepEqual(edge.multipart_limits, {
    boundary_bytes_max: 70,
    nesting_depth_max: 2,
    part_count_max: 16,
    part_header_bytes_max: 8_192,
    part_body_bytes_max: 32_768,
    malformed_or_ambiguous_boundary: "reject_fail_closed",
  });

  for (const backend of value.backend_capability_sets) {
    assert.equal(backend.schema_id, "backend-capability-set-v1");
    assert.equal(backend.schema_version, "1.0.0");
    assert.equal(
      backend.schema_authority,
      "unified_rustpbx_media_protocol_governance",
    );
    assert.deepEqual(Object.keys(backend.lifecycle_contract as JsonObject), [
      "allocation_scope",
      "blocked_prepare",
      "precommit_output",
      "commit",
      "abort",
      "revoke",
      "zero_output_ack",
      "fence_scope",
      "query",
      "reconcile",
      "migration",
      "notification",
      "member_flow_fence",
      "security_termination_scope",
      "operation_contracts",
      "verification_status",
    ]);
  }
  assert.deepEqual(value.media_graph_compiler.lifecycle_granularity_rule, {
    required_unit: "directed_edge_generation",
    coarse_allocation_detection:
      "backend_lifecycle_or_fence_scope_coarser_than_directed_edge",
    member_flow_fence_proof_required: true,
    unproven_member_flow_policy: "split_binding_group_or_fail_closed",
    split_result:
      "one_lifecycle_and_fence_domain_per_compatible_directed_edge_set",
    allocation_before_resolution: "forbidden",
  });
  assert.ok(
    (value.media_graph_compiler.compile_errors as string[]).includes(
      "coarse_lifecycle_scope_without_member_flow_fence",
    ),
  );

  assert.deepEqual(value.rolling_schema_rules.schema_registry, {
    registry_id: "opc-persistent-schema-registry-v1",
    authority: "unified_rustpbx_protocol_governance",
    persistence: "postgresql_region_durable_store",
    identity_fields: [
      "artifact_type",
      "schema_id",
      "schema_version",
      "schema_sha256",
    ],
    unavailable_policy: "fail_closed_no_new_writer_version",
  });
  assert.deepEqual(value.rolling_schema_rules.versioned_artifacts, [
    "call_session",
    "business_dialog",
    "protocol_dialog",
    "protocol_effect",
    "effect_wal",
    "media_plan",
    "directed_media_edge",
    "backend_binding_group",
    "wire_transport_bundle",
    "recovery_capsule",
    "root_recording_manifest",
    "recording_source_chain",
    "capacity_vector",
    "voice_livekit_bridge_generation",
    "voice_livekit_bridge_attempt",
    "voice_livekit_bridge_command",
    "voice_livekit_bridge_receipt",
    "voice_livekit_bridge_tombstone",
  ]);
});

test("Revision 4 compiles complete MediaPlan demand and closes security and media quality", () => {
  const value = contract();
  const demand = value.capacity_demand;
  assert.equal(
    (demand.media_plan_compiler as JsonObject).compiler_id,
    "media-plan-capacity-demand-v1",
  );
  assert.deepEqual((demand.media_plan_compiler as JsonObject).plan_inputs, [
    "rtp_flows",
    "rtcp_flows",
    "srtp_contexts",
    "port_pairs",
    "codec_decode_edges",
    "codec_encode_edges",
    "resample_edges",
    "transcode_edges",
    "mix_outputs",
    "recording_edges",
    "ai_edges",
    "packetization",
    "bitrate",
    "numa_affinity",
    "worker_count",
    "shard_count",
    "queue_depth",
    "service_time_micros",
    "backpressure_limit",
  ]);
  assert.deepEqual((demand.media_plan_compiler as JsonObject).demand_outputs, [
    "rtp_socket_count",
    "rtcp_socket_count",
    "srtp_context_count",
    "port_pair_count",
    "packet_rate_pps",
    "bit_rate_bps",
    "memory_bytes",
    "cpu_micros_per_second",
    "numa_node",
    "decode_slots",
    "encode_slots",
    "resample_slots",
    "transcode_slots",
    "mix_slots",
    "record_slots",
    "ai_slots",
    "worker_count",
    "shard_count",
    "queue_depth",
    "service_time_micros",
    "backpressure_limit",
  ]);
  const mappings = (demand.media_plan_compiler as JsonObject)
    .resource_mappings as JsonObject[];
  assert.deepEqual(
    mappings.map((mapping) => mapping.plan_fact),
    [
      "wire_transport_bundle",
      "decode_edge",
      "encode_edge",
      "resample_edge",
      "transcode_edge",
      "mix_output",
      "recording_edge",
      "ai_edge",
    ],
  );
  assert.ok(
    mappings.every(
      (mapping) =>
        Array.isArray(mapping.demand_fields) &&
        (mapping.demand_fields as unknown[]).length > 0,
    ),
  );
  assert.deepEqual(
    (demand.role_supply as JsonObject[]).map((entry) => entry.role),
    [
      "rtpengine_ordinary",
      "embedded_voice_media",
      "livekit_sip_bridge",
      "rust_native_fast_path",
    ],
  );
  assert.deepEqual((demand.role_supply as JsonObject[])[1].supplies, [
    "wire_transport_bundle",
    "decode_edge",
    "encode_edge",
    "resample_edge",
    "transcode_edge",
    "mix_output",
    "recording_edge",
    "ai_edge",
  ]);
  assert.deepEqual((demand.role_supply as JsonObject[])[2].supplies, [
    "wire_transport_bundle",
    "decode_edge",
    "encode_edge",
    "resample_edge",
    "transcode_edge",
  ]);
  assert.equal(demand.reservation_rule, "atomic_before_backend_prepare");
  assert.equal(
    demand.failure_reserve_rule,
    "reserve_for_declared_failure_domain",
  );
  assert.equal(demand.n_plus_1_rule, "largest_failure_domain_plus_peak_demand");
  assert.equal(demand.cross_profile_inheritance, "forbidden");

  const security = value.security;
  assert.equal(
    (security.advisory_policy as JsonObject).owner,
    "unified_rustpbx_security_response",
  );
  assert.equal(
    (security.advisory_policy as JsonObject).feed_ingestion,
    "continuous_signed_feed_snapshot_with_digest",
  );
  assert.deepEqual((security.advisory_policy as JsonObject).triage_sla_hours, {
    critical: 4,
    high: 24,
    medium: 72,
    low: 168,
  });
  assert.equal(
    (security.advisory_policy as JsonObject).patch_lifecycle,
    "upstream_backport_then_cherry_pick_or_bounded_local_fork_with_owner_expiry_and_rebase",
  );
  assert.equal(
    (security.advisory_policy as JsonObject).affected_slice_policy,
    "requalify_exact_affected_slices_or_disable_them",
  );
  assert.deepEqual((security.native_dependencies as JsonObject).crash_policy, {
    core_dump: "disabled_in_production",
    crash_artifact: "redacted_minidump_without_keys_sdp_or_media",
    unredacted_crash_upload: "forbidden",
  });

  assert.equal(value.small_conference.per_participant_jitter_buffers, "N");
  assert.equal(value.small_conference.per_participant_encode_outputs, "N");
  for (const metric of [
    "clipping",
    "loudness",
    "level_normalization",
    "tandem_transcode",
    "plc_quality",
    "dtx_cng_transition",
    "clock_drift",
  ]) {
    assert.ok((value.quality.metrics as string[]).includes(metric), metric);
  }
});

test("Revision 4 selects one low-latency DTMF path and freezes WebRTC transport state", () => {
  const value = contract();
  assert.deepEqual(value.dtmf.normal_path_acquisition, {
    path: "rtpengine_rfc4733_event_notification",
    required_backend_capability_id: "dtmf_event_notification",
    alternate_read_only_fork: "forbidden",
    decode_all_ordinary_media: "forbidden",
    notification_identity_fields: [
      "tenant_id",
      "interaction_id",
      "leg_id",
      "ssrc",
      "rtp_timestamp",
      "event",
      "duration",
      "end_bit",
      "provider_event_sequence",
    ],
    dedupe_key:
      "leg_id_ssrc_rtp_timestamp_event_duration_end_bit_provider_event_sequence",
    report_p99_budget_ms: 50,
    loss_or_ambiguity_policy:
      "fail_closed_for_business_effect_query_reconcile_without_decode_all",
  });
  const rtpengine = value.backend_capability_sets.find(
    (backend) => backend.backend_id === "rtpengine_ordinary",
  );
  assert.ok(rtpengine);
  const notification = (rtpengine.capabilities as JsonObject[]).find(
    (capability) => capability.capability_id === "dtmf_event_notification",
  );
  assert.deepEqual(notification, {
    capability_id: "dtmf_event_notification",
    required: true,
    support: "unknown",
    verified: "not_run",
    granularity: "member_flow",
  });
  assert.equal(
    value.media_graph_compiler.required_capability_rule,
    "support_must_be_supported_and_verified_passed",
  );
  const protocols = value.media_protocol_invariants;
  assert.deepEqual(protocols.dtls, {
    role: "negotiated_setup_role_bound_to_bundle_generation",
    fingerprint: "exact_hash_algorithm_and_value_verified_before_srtp",
    role_or_fingerprint_change: "new_wire_transport_bundle_generation",
  });
  assert.deepEqual(protocols.ice, {
    credentials: "exact_ufrag_and_pwd_bound_to_bundle_generation",
    consent_freshness: "required_bounded_expiry_stops_output",
    restart: "new_ufrag_pwd_and_new_wire_transport_bundle_generation",
  });
  assert.deepEqual(protocols.multiplexing, {
    rtcp_mux: "negotiated_required_for_bundle_and_bound_to_generation",
    bundle_mid:
      "bundle_group_and_mid_demux_bound_to_generation_unknown_or_duplicate_mid_rejected",
    payload_type_scope: "leg_and_binding_revision",
    security_context_scope: "bundle_transport_and_generation",
  });
});

test("Revision 4 bounds repeated Voice-LiveKit round trips and concurrent arbitration", () => {
  const alternating = contract().livekit_handoff
    .alternating_handoff_contract as JsonObject;
  assert.equal(alternating.same_call_required, true);
  assert.deepEqual(alternating.active_path_cycle, ["V2L_ACTIVE", "L2V_ACTIVE"]);
  assert.equal(alternating.max_round_trips_per_scenario, 32);
  assert.equal(alternating.new_generation_per_switch, true);
  assert.equal(
    (alternating.concurrent_arbitration as JsonObject).authority,
    "opc_owned_bridge_coordinator_store",
  );
  assert.equal(
    (alternating.concurrent_arbitration as JsonObject).winner_rule,
    "head_cas_owner_epoch_and_idempotency_key",
  );
  assert.equal(
    (alternating.concurrent_arbitration as JsonObject).loser_rule,
    "fail_closed_then_query_and_reconcile_winner_generation",
  );
  assert.deepEqual(alternating.no_growth_invariants, [
    "one_business_call",
    "one_immutable_voice_cdr",
    "one_billing_rating_session",
    "one_root_recording_manifest_per_role",
    "one_active_livekit_participant_per_role",
    "bounded_port_pairs_by_active_generation",
    "one_writer_per_directed_edge_generation",
  ]);
  assert.deepEqual(alternating.terminal_zero_leak, [
    "participants",
    "port_pairs",
    "backend_allocations",
    "writers",
    "pending_commands",
    "unreconciled_receipts",
  ]);
  assert.deepEqual(alternating.required_evidence, [
    "alternating_32_round_trip_scenario",
    "concurrent_switch_property",
    "cas_loser_reconcile_fault",
    "timeout_after_apply_fault",
    "terminal_zero_leak_assertion",
  ]);
  assert.equal(alternating.verification_status, "not_run");
  assert.equal(alternating.production_eligible, false);
});

test("Revision 4 schema rejects a mutation of every newly frozen closure leaf", () => {
  const baseline = contract();
  const targets: Array<{ label: string; path: JsonPath }> = [
    {
      label: "edge schema identity",
      path: ["edge_to_core_policy", "schema_identity"],
    },
    {
      label: "edge message limits",
      path: ["edge_to_core_policy", "message_limits"],
    },
    {
      label: "edge critical headers",
      path: ["edge_to_core_policy", "critical_header_policy"],
    },
    { label: "edge URI policy", path: ["edge_to_core_policy", "uri_policy"] },
    {
      label: "edge multipart limits",
      path: ["edge_to_core_policy", "multipart_limits"],
    },
    {
      label: "RFC3263 contract",
      path: ["sip_transaction_policy", "rfc3263_contract"],
    },
    {
      label: "compiler lifecycle granularity",
      path: ["media_graph_compiler", "lifecycle_granularity_rule"],
    },
    {
      label: "compiler lifecycle operation gate",
      path: ["media_graph_compiler", "lifecycle_operation_gate"],
    },
    {
      label: "RTPengine execution profiles",
      path: ["rtpengine_atomic_lifecycle", "execution_profiles"],
    },
    { label: "active timer recovery closure", path: ["recovery_matrix"] },
    {
      label: "store atomic boundaries",
      path: ["durable_store_slo", "atomic_boundaries"],
    },
    {
      label: "store retry after contract",
      path: ["durable_store_slo", "retry_after_contract"],
    },
    {
      label: "store failure responses",
      path: ["durable_store_slo", "failure_responses"],
    },
    {
      label: "schema registry",
      path: ["rolling_schema_rules", "schema_registry"],
    },
    {
      label: "versioned artifacts",
      path: ["rolling_schema_rules", "versioned_artifacts"],
    },
    {
      label: "per-artifact rolling schema contracts",
      path: ["rolling_schema_rules", "artifact_contracts"],
    },
    { label: "G729 packetization", path: ["g729", "packetization_ms"] },
    {
      label: "G729 frames per packet",
      path: ["g729", "speech_frames_per_packet"],
    },
    { label: "DTMF acquisition", path: ["dtmf", "normal_path_acquisition"] },
    { label: "DTMF delivery", path: ["dtmf", "delivery_contract"] },
    { label: "DTLS invariants", path: ["media_protocol_invariants", "dtls"] },
    { label: "ICE invariants", path: ["media_protocol_invariants", "ice"] },
    {
      label: "multiplexing invariants",
      path: ["media_protocol_invariants", "multiplexing"],
    },
    {
      label: "alternating handoff",
      path: ["livekit_handoff", "alternating_handoff_contract"],
    },
    {
      label: "LiveKit machine vectors",
      path: ["livekit_handoff", "machine_verification_vectors"],
    },
    {
      label: "LiveKit command token contract",
      path: ["livekit_handoff", "command_token_contract"],
    },
    {
      label: "LiveKit cancellation contract",
      path: ["livekit_handoff", "cancellation_contract"],
    },
    {
      label: "LiveKit webhook contract",
      path: ["livekit_handoff", "webhook_contract"],
    },
    {
      label: "three-party drain",
      path: ["migration_drain", "three_party_drain_contract"],
    },
    {
      label: "MediaPlan demand compiler",
      path: ["capacity_demand", "media_plan_compiler"],
    },
    { label: "capacity role supply", path: ["capacity_demand", "role_supply"] },
    {
      label: "capacity reservation",
      path: ["capacity_demand", "reservation_rule"],
    },
    {
      label: "failure reserve",
      path: ["capacity_demand", "failure_reserve_rule"],
    },
    { label: "N+1 reserve", path: ["capacity_demand", "n_plus_1_rule"] },
    {
      label: "capacity inheritance",
      path: ["capacity_demand", "cross_profile_inheritance"],
    },
    {
      label: "capacity admission contract",
      path: ["capacity_demand", "admission_contract"],
    },
    {
      label: "conference jitter",
      path: ["small_conference", "per_participant_jitter_buffers"],
    },
    {
      label: "conference encode",
      path: ["small_conference", "per_participant_encode_outputs"],
    },
    {
      label: "security advisory lifecycle",
      path: ["security", "advisory_policy"],
    },
    {
      label: "native crash policy",
      path: ["security", "native_dependencies", "crash_policy"],
    },
    { label: "quality metrics", path: ["quality", "metrics"] },
    {
      label: "quality measurement methods",
      path: ["quality", "measurement_methods"],
    },
    {
      label: "quality workload contract",
      path: ["quality", "workload_contract"],
    },
    {
      label: "quality threshold contract",
      path: ["quality", "threshold_contract"],
    },
    {
      label: "quality evidence identity",
      path: ["quality", "evidence_identity_fields"],
    },
  ];
  for (const backendIndex of valueAtPath(baseline, [
    "backend_capability_sets",
  ]) as JsonObject[]) {
    assert.ok(backendIndex);
  }
  for (
    let index = 0;
    index < baseline.backend_capability_sets.length;
    index += 1
  ) {
    for (const field of [
      "schema_id",
      "schema_version",
      "schema_authority",
      "lifecycle_contract",
    ]) {
      targets.push({
        label: `backend ${index} ${field}`,
        path: ["backend_capability_sets", index, field],
      });
    }
  }

  const validate = validator();
  for (const target of targets) {
    const selected = valueAtPath(baseline, target.path);
    assert.notEqual(selected, undefined, `${target.label} positive presence`);
    const leaves = leafPaths(selected);
    assert.ok(leaves.length > 0, `${target.label} must expose leaves`);
    for (const relativePath of leaves) {
      const fixture = structuredClone(baseline);
      mutateLeaf(fixture, [...target.path, ...relativePath]);
      assert.equal(
        validate(fixture),
        false,
        `${target.label}/${relativePath.join("/")} must reject mutation`,
      );
    }
  }
});

test("Revision 4 covers capacity, security, quality and every execution phase without promotion", () => {
  const value = contract();
  for (const field of [
    "demand_categories",
    "capacity_vector_fields",
    "admission_vectors",
  ]) {
    assert.ok(Array.isArray(value.capacity_demand[field]));
    assert.ok((value.capacity_demand[field] as unknown[]).length > 5);
  }
  assert.equal(value.capacity_demand.physical_result_status, "not_run");
  assert.equal(value.security.verification_status, "not_run");
  assert.equal(value.quality.verification_status, "not_run");
  assert.deepEqual(
    value.current_target_eligibility.map((entry) => entry.component_id),
    [
      "g729",
      "livekit_handoff",
      "media_protocol_invariants",
      "rtpengine_atomic_lifecycle",
      "rust_native_fast_path",
      "sip_foundation",
      "small_conference",
      "voice_media_embedded",
    ],
  );
  assert.ok(
    value.current_target_eligibility.every(
      (entry) => entry.production_eligible === false,
    ),
  );
  assert.deepEqual(
    value.phase_gates.map((entry) => entry.phase_id),
    ["D0", "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9"],
  );
  assert.ok(
    value.phase_gates.every(
      (entry) =>
        entry.physical_result_status === "not_run" &&
        entry.production_result_status === "not_run" &&
        entry.production_eligible === false,
    ),
  );
});

test("Revision 4 binds its objective and reciprocal authority contracts without claiming runtime evidence", () => {
  const value = contract();
  assert.deepEqual(value.binding_objective, {
    source_path: "/private/tmp/opc-ivekit-unified-voice-goal-r4-2026-07-29.md",
    archive_path:
      "docs/capacity/contracts/unified-voice-foundation-r4-objective.md",
    content_sha256:
      "9435c3e28f46f43906d325bb325253da2ecb448d257533547740073d9132bc54",
  });
  assert.deepEqual(value.implementation_plan, {
    path: "docs/superpowers/plans/2026-07-29-unified-voice-foundation-r4.md",
    content_sha256:
      "b5121a7c73360f2a46eb0aa2114c95953f85224a2750c74059755df2f9bec107",
  });
  assert.equal(
    fileSha256(value.binding_objective.archive_path as string),
    value.binding_objective.content_sha256,
  );
  assert.equal(
    fileSha256(value.implementation_plan.path as string),
    value.implementation_plan.content_sha256,
  );
  assert.equal(
    value.authority_bindings.digest_projection,
    "rfc8785_jcs_without_top_level_authority_binding",
  );
  for (const [key, expected] of Object.entries({
    rvoip: {
      path: "docs/capacity/contracts/rvoip-capability-integration-v1.json",
      contract_id: "rvoip-capability-integration-v1",
      revision: 6,
    },
    voice_media_goal4: {
      path: "docs/capacity/contracts/voice-media-goal4-v1.json",
      contract_id: "voice-media-goal4-v1",
      revision: 6,
    },
  })) {
    const binding = value.authority_bindings[key];
    object(binding, `authority_bindings.${key}`);
    assert.equal(binding.path, expected.path);
    assert.equal(binding.contract_id, expected.contract_id);
    assert.equal(binding.revision, expected.revision);
    assert.match(binding.content_sha256 as string, /^[0-9a-f]{64}$/);
  }
  assert.ok(
    namedValues(value, "verification_status").every(
      (entry) => entry === "not_run",
    ),
  );
  assert.ok(
    namedValues(value, "production_eligible").every((entry) => entry === false),
  );
});

test("Revision 4 freezes one architecture profile and splits every irreversible authority fact", () => {
  const value = contract();
  assert.deepEqual(value.architecture_profile, {
    profile_id: "CARRIER-CELL-V1",
    architecture_profile_count: 1,
    ordinary_media_backend: "rtpengine_ordinary",
    decode_required_backend: "embedded_voice_media",
    room_webrtc_backend: "livekit",
    livekit_gateway_backend: "livekit_sip_bridge",
    rust_native_fast_path_role: "candidate_backend_not_second_profile",
    standalone_role: "development_diagnostics_and_benchmark_only",
    runtime_capability_identity_fields: [
      "backend_id",
      "source_digest",
      "binary_digest",
      "config_digest",
      "capability_set_digest",
    ],
    missing_identity_policy: "backend_ineligible_fail_closed",
    results_inheritable: false,
    verification_status: "not_run",
    production_eligible: false,
  });

  const authority = value.authority_matrix;
  assert.equal(
    (authority.recording_intent as JsonObject).owner,
    "unified_rustpbx_call_core",
  );
  assert.equal(
    (authority.recording_manifest as JsonObject).owner,
    "region_recording_plane",
  );
  assert.equal(
    (authority.immutable_voice_cdr as JsonObject).owner,
    "unified_rustpbx_call_core",
  );
  assert.equal(
    (authority.cdr_convergence as JsonObject).owner,
    "region_cdr_convergence_service",
  );
  assert.equal(
    (authority.billing_rating as JsonObject).owner,
    "opc_ivekit_billing",
  );
  assert.ok(
    Object.values(authority)
      .filter(
        (entry): entry is JsonObject =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
      .every((entry) => entry.writer_count === 1),
  );
});

test("Revision 4 capability sets bind source, binary and config identity at per-capability granularity", () => {
  const value = contract();
  assert.deepEqual(
    value.backend_capability_sets.map((entry) => entry.backend_id),
    [
      "embedded_voice_media",
      "livekit_sip_bridge",
      "rtpengine_ordinary",
      "rust_native_fast_path",
    ],
  );
  for (const backend of value.backend_capability_sets) {
    for (const digestKey of [
      "source_digest",
      "binary_digest",
      "config_digest",
      "capability_set_digest",
    ]) {
      const digest = backend[digestKey];
      object(digest, `${backend.backend_id}.${digestKey}`);
      assert.equal(digest.algorithm, "sha256");
      assert.equal(digest.value, null);
      assert.equal(digest.verification_status, "not_run");
    }
    const capabilities = backend.capabilities as JsonObject[];
    assertUniqueSemanticKeys(
      capabilities,
      "capability_id",
      `${backend.backend_id}.capabilities`,
    );
    assert.ok(
      capabilities.every(
        (capability) =>
          ["supported", "partial", "unsupported", "unknown"].includes(
            capability.support as string,
          ) &&
          capability.verified === "not_run" &&
          [
            "backend",
            "binding_group",
            "directed_edge",
            "member_flow",
            "bridge_generation",
          ].includes(capability.granularity as string),
      ),
    );
  }

  assert.deepEqual(value.media_graph_compiler.compile_errors, [
    "backend_identity_missing",
    "backend_identity_mismatch",
    "required_capability_not_supported",
    "required_capability_not_verified",
    "capability_granularity_mismatch",
    "illegal_binding_group",
    "incomplete_member_flow_set",
    "writer_fence_conflict",
    "security_context_mismatch",
    "coarse_lifecycle_scope_without_member_flow_fence",
    "binding_group_split_impossible",
    "lifecycle_operation_missing",
    "lifecycle_operation_not_supported",
    "lifecycle_operation_not_verified",
    "lifecycle_operation_granularity_mismatch",
    "lifecycle_operation_prerequisite_unmet",
  ]);
  const rules = value.media_graph_compiler.grouping_rules as JsonObject;
  assert.equal(rules.member_set, "immutable_within_group_generation");
  assert.equal(rules.bidirectional_media, "two_opposite_directed_edges");
  assert.equal(
    rules.tap_rule,
    "recording_ai_and_quality_are_separate_directed_edges",
  );
});

test("Revision 4 makes RTPengine allocation, generation, fence, WAL and zero-output rules atomic", () => {
  const value = contract();
  const lifecycle = value.rtpengine_atomic_lifecycle;
  assert.deepEqual(lifecycle.allocation_identity_fields, [
    "backend_allocation_id",
    "binding_group_id",
    "binding_group_generation",
    "backend_instance_id",
  ]);
  assert.deepEqual(lifecycle.writer_fence_fields, [
    "owner_epoch",
    "command_sequence",
    "writer_fence",
  ]);
  assert.equal(lifecycle.wal_decision_before_command, true);
  assert.equal(lifecycle.notification_is_receipt, false);
  assert.equal(lifecycle.notification_loss_policy, "query_and_reconcile");
  assert.deepEqual(lifecycle.member_flow_identity_fields, [
    "group_id",
    "group_generation",
    "flow_selector",
  ]);
  assert.equal(
    lifecycle.zero_output_requirement,
    "packet_level_ack_with_last_tx_watermark_before_successor_commit",
  );
  assert.deepEqual(lifecycle.security_identity_fields, [
    "wire_transport_bundle_id",
    "security_mode",
    "crypto_context_generation",
  ]);
  assertUniqueSemanticKeys(
    lifecycle.operations as JsonObject[],
    "operation_id",
    "rtpengine_atomic_lifecycle.operations",
  );

  assert.deepEqual(value.single_process_failure_scope.failure_modes, [
    "oom",
    "process_abort",
    "undefined_behavior",
    "allocator_corruption",
    "uncatchable_native_failure",
  ]);
  assert.equal(
    value.single_process_failure_scope.address_space_isolation,
    false,
  );
  assert.equal(
    value.single_process_failure_scope.embedded_edge_blast_radius,
    "all_embedded_edges_in_unified_rustpbx_process",
  );
  assert.equal(
    value.single_process_failure_scope.ordinary_rtpengine_edge_on_process_loss,
    "continue_degraded",
  );
});

test("Revision 4 covers normal DTMF, media protocol continuity, multidimensional demand and bounded conference", () => {
  const value = contract();
  assert.equal(value.dtmf.normal_path, "rfc4733_via_rtpengine");
  assert.equal(
    value.dtmf.canonical_event_authority,
    "unified_rustpbx_per_leg_dtmf_event_authority",
  );
  assert.deepEqual(value.dtmf.candidate_inputs, [
    "rfc4733",
    "sip_info",
    "in_band_detector",
    "livekit_data_or_control",
  ]);

  const protocols = value.media_protocol_invariants;
  assert.equal(
    (protocols.rtcp as JsonObject).cname_rule,
    "stable_per_sender_with_explicit_generation_discontinuity",
  );
  assert.equal(
    (protocols.srtp as JsonObject).roc_rule,
    "persist_or_rekey_without_rollback_per_ssrc_key_generation",
  );
  assert.equal(
    (protocols.srtp as JsonObject).replay_rule,
    "bounded_replay_window_rejects_duplicate_and_too_old_packets",
  );
  assert.equal(
    (protocols.ssrc as JsonObject).collision_rule,
    "detect_rewrite_or_allocate_new_edge_generation",
  );
  assert.deepEqual(protocols.livekit_webrtc_authority, [
    "ice",
    "dtls",
    "dtls_srtp",
    "turn",
    "bundle",
    "mid",
  ]);
  assert.equal(
    (protocols.multiplexing as JsonObject).rtcp_mux,
    "negotiated_required_for_bundle_and_bound_to_generation",
  );
  assert.equal(
    (protocols.multiplexing as JsonObject).bundle_mid,
    "bundle_group_and_mid_demux_bound_to_generation_unknown_or_duplicate_mid_rejected",
  );

  assert.deepEqual(value.capacity_demand.demand_categories, [
    "bridge_generations",
    "directed_bridge_edges",
    "livekit_sip_participants",
    "bridge_cps",
    "switch_attempts",
    "switch_gap_loss",
    "codec_transcode_demand",
    "recording_roles",
    "handoff_reconciliation",
  ]);
  const capacityVectorFields = value.capacity_demand
    .capacity_vector_fields as JsonObject[];
  assertUniqueSemanticKeys(
    capacityVectorFields,
    "field_id",
    "capacity_demand.capacity_vector_fields",
  );
  assert.deepEqual(
    capacityVectorFields.map((field) => [field.field_id, field.unit]),
    [
      ["bridge_generations", "count"],
      ["directed_bridge_edges", "count"],
      ["livekit_sip_participants", "count"],
      ["bridge_cps", "per_second"],
      ["switch_attempts", "per_second"],
      ["switch_gap_p99_ms", "milliseconds"],
      ["switch_loss_packets_p99", "packets"],
      ["decode_slots", "count"],
      ["encode_slots", "count"],
      ["resample_slots", "count"],
      ["transcode_slots", "count"],
      ["recording_roles", "count"],
      ["handoff_reconciliation_cps", "per_second"],
    ],
  );
  assert.equal(
    value.small_conference.mix_semantics,
    "per_participant_n_minus_one",
  );
  assert.equal(value.small_conference.naive_complexity, "O(N^2)");
  assert.equal(value.small_conference.max_participants, 8);
  assert.equal(
    value.small_conference.above_limit_policy,
    "route_new_conference_to_livekit_or_reject",
  );
  assert.equal(
    value.small_conference.recording_role,
    "separate_directed_edge_from_authoritative_mix_output",
  );
  assert.equal(value.small_conference.results_inheritable, false);
});

test("Revision 4 freezes advisory SLA, key handling and native unsafe FFI boundaries", () => {
  const security = contract().security;
  assert.deepEqual((security.advisory_policy as JsonObject).sources, [
    "rustsec",
    "osv",
    "github_security_advisories",
    "vendor_advisories",
  ]);
  assert.deepEqual(
    (security.advisory_policy as JsonObject).remediation_sla_hours,
    {
      critical: 24,
      high: 168,
      medium: 720,
      low: 2160,
    },
  );
  assert.equal(
    (security.key_management as JsonObject).raw_key_persistence,
    "forbidden",
  );
  assert.equal(
    (security.native_dependencies as JsonObject).untracked_native_code,
    "forbidden",
  );
  assert.equal(
    (security.unsafe_rust as JsonObject).policy,
    "deny_unless_allowlisted_reviewed_and_tested",
  );
  assert.equal(
    (security.ffi as JsonObject).failure_policy,
    "fail_closed_and_contain_at_worker_boundary_when_possible",
  );
});

test("Revision 4 defines the complete Voice to LiveKit bridge machine without merged terminal facts", () => {
  const machine = contract().livekit_handoff;
  const paths = machine.paths as JsonObject[];
  assert.equal(machine.machine_id, "voice-livekit-bridge-v1");
  assert.equal(machine.results_inheritable, false);
  assert.deepEqual(
    paths.map((path) => path.path_id),
    ["V2L_NEW", "L2V_NEW", "V2L_ACTIVE", "L2V_ACTIVE"],
  );
  assertUniqueSemanticKeys(paths, "path_id", "livekit_handoff.paths");
  for (const path of paths) {
    const slices = path.evidence_slices as JsonObject[];
    assert.deepEqual(
      slices.map((slice) => slice.slice_id),
      ["functional", "fault", "capacity"],
      path.path_id as string,
    );
    assertUniqueSemanticKeys(
      slices,
      "slice_id",
      `livekit_handoff.paths.${String(path.path_id)}.evidence_slices`,
    );
    for (const slice of slices) {
      assert.equal(slice.status, "not_run");
      assert.equal(slice.results_inheritable, false);
      assert.deepEqual(slice.forbidden_inheritance_sources, [
        "other_path",
        "ordinary_rtp",
        "livekit_only",
        "optional_bridge_excluded",
      ]);
    }
  }
  assert.equal(
    (machine.bridge_generation_identity_fields as string[]).length,
    45,
  );
  for (const identityField of [
    "tenant_id",
    "interaction_id",
    "call_id",
    "media_call_id",
    "leg_id",
    "sip_dialog_id",
    "livekit_room_id",
    "livekit_participant_id",
    "bridge_id",
    "bridge_generation",
    "edge_id",
    "edge_generation",
    "binding_group_id",
    "binding_group_generation",
    "writer_fence",
    "owner_epoch",
    "command_sequence",
    "decision_hash",
    "predecessor_zero_output_receipt_hash",
    "terminal_receipt_hash",
    "billing_key",
    "recording_intent_id",
    "root_recording_manifest_id",
    "recording_source_chain_id",
    "cleanup_state",
  ]) {
    assert.ok(
      (machine.bridge_generation_identity_fields as string[]).includes(
        identityField,
      ),
      identityField,
    );
  }
  assert.deepEqual(machine.directed_edges, [
    {
      edge_role: "voice_to_livekit",
      direction: "voice_to_livekit",
      edge_count: 1,
      independent_generation: true,
      independent_writer_fence: true,
    },
    {
      edge_role: "livekit_to_voice",
      direction: "livekit_to_voice",
      edge_count: 1,
      independent_generation: true,
      independent_writer_fence: true,
    },
  ]);
  const operations = machine.operations as JsonObject[];
  assert.deepEqual(
    operations.map((operation) => operation.operation_id),
    [
      "prepare",
      "commit",
      "abort",
      "query",
      "reconcile",
      "revoke",
      "release",
      "terminate",
      "delete",
      "cleanup",
    ],
  );
  assert.notEqual(
    operations.find((operation) => operation.operation_id === "terminate")
      ?.durable_fact,
    operations.find((operation) => operation.operation_id === "delete")
      ?.durable_fact,
  );
  assert.equal(
    (machine.state_contract as JsonObject).unknown_policy,
    "freeze_role_then_query_and_reconcile_exact_generation",
  );
  assert.equal(
    (machine.state_contract as JsonObject).blocked_state,
    "prepared_blocked_no_output_or_side_effects",
  );
  assert.equal(
    (machine.state_contract as JsonObject).current_handoff_mode,
    "break_before_make",
  );
  assert.equal(
    (machine.state_contract as JsonObject).compensation_terminal,
    "compensated_failed",
  );
  assert.equal(
    (machine.activation_prerequisites as string[]).at(-1),
    "predecessor_zero_output_receipt_durable_for_handoff",
  );
  assert.equal(
    (machine.timeout_rollback as JsonObject).timeout_policy,
    "unknown_then_query_same_command_no_recreate",
  );
  assert.equal(
    (machine.timeout_rollback as JsonObject).revoked_generation_reactivation,
    "forbidden",
  );
  const store = machine.store_contract as JsonObject;
  assert.deepEqual(store.head_compare_and_swap_fields, [
    "revision",
    "owner_epoch",
    "state",
  ]);
  assert.deepEqual(store.append_only_records, [
    "bridge_command",
    "bridge_receipt",
    "bridge_tombstone",
  ]);
  assert.equal(store.history_foreign_key_policy, "on_delete_restrict");
  assert.equal(
    store.migration_writer_policy,
    "one_writer_epoch_cas_no_old_new_dual_write",
  );
  assert.equal(store.current_status, "not_present");

  const manifest = machine.recording_manifest_contract as JsonObject;
  assert.equal(manifest.authority, "region_recording_plane");
  assert.equal(manifest.root_manifest_count_per_interaction_role, 1);
  assert.deepEqual(manifest.root_identity_fields, [
    "recording_intent_id",
    "logical_recording_role",
  ]);
  assert.equal(manifest.source_chain_mutability, "append_only");
  assert.equal(manifest.segment_mutability, "append_only");
  assert.equal(
    manifest.handoff_source_change,
    "append_source_specific_chain_under_same_root_manifest",
  );

  const endpointSecurity = machine.control_endpoint_security as JsonObject;
  assert.equal(endpointSecurity.production_scheme, "https_only");
  assert.equal(endpointSecurity.certificate_chain_verification, true);
  assert.equal(endpointSecurity.hostname_verification, true);
  assert.equal(endpointSecurity.internal_service_http_bypass, false);
  assert.equal(
    endpointSecurity.bare_http_scope,
    "non_production_loopback_fixture_only",
  );

  const behavior = machine.behavior_contract as JsonObject;
  for (const field of [
    "codec",
    "dtmf",
    "hold_resume",
    "mute",
    "transfer",
    "hangup",
    "security",
    "webhook",
    "capacity",
    "return_to_rtpengine",
  ]) {
    assert.equal(typeof behavior[field], "string", field);
  }
});

test("Revision 4 schema rejects authority, identity, lifecycle, evidence and dependency mutations", () => {
  rejectMutation("billing authority drift", (value) => {
    (value.authority_matrix.billing_rating as JsonObject).owner = "livekit";
  });
  rejectMutation("missing backend config digest", (value) => {
    delete value.backend_capability_sets[0].config_digest;
  });
  rejectMutation("unversioned backend capability set", (value) => {
    delete value.backend_capability_sets[0].schema_version;
  });
  rejectMutation("backend precommit output weakening", (value) => {
    (
      value.backend_capability_sets[0].lifecycle_contract as JsonObject
    ).precommit_output = "allowed";
  });
  rejectMutation("backend lifecycle scope drift", (value) => {
    (
      value.backend_capability_sets[0].lifecycle_contract as JsonObject
    ).allocation_scope = "binding_group_generation";
  });
  rejectMutation(
    "coarse backend grouping without member-flow proof",
    (value) => {
      (
        value.media_graph_compiler.lifecycle_granularity_rule as JsonObject
      ).unproven_member_flow_policy = "share_anyway";
    },
  );
  rejectMutation("edge message limit removal", (value) => {
    delete (value.edge_to_core_policy.message_limits as JsonObject)
      .message_bytes_max;
  });
  rejectMutation("edge URI limit weakened", (value) => {
    (value.edge_to_core_policy.message_limits as JsonObject).uri_bytes_max =
      65_535;
  });
  rejectMutation("critical SIP header conflict accepted", (value) => {
    (
      value.edge_to_core_policy.critical_header_policy as JsonObject
    ).conflict_policy = "last_value_wins";
  });
  rejectMutation("schema registry made ephemeral", (value) => {
    (value.rolling_schema_rules.schema_registry as JsonObject).persistence =
      "process_memory";
  });
  rejectMutation("Call schema removed from registry", (value) => {
    (value.rolling_schema_rules.versioned_artifacts as string[]).shift();
  });
  rejectMutation("transcode demand mapping removed", (value) => {
    const mappings = (value.capacity_demand.media_plan_compiler as JsonObject)
      .resource_mappings as JsonObject[];
    const index = mappings.findIndex(
      (mapping) => mapping.plan_fact === "transcode_edge",
    );
    assert.notEqual(index, -1);
    mappings.splice(index, 1);
  });
  rejectMutation("capacity reservation moved after prepare", (value) => {
    value.capacity_demand.reservation_rule = "after_backend_prepare";
  });
  rejectMutation("cross-profile capacity inheritance", (value) => {
    value.capacity_demand.cross_profile_inheritance = "allowed";
  });
  rejectMutation("production core dumps enabled", (value) => {
    (
      (value.security.native_dependencies as JsonObject)
        .crash_policy as JsonObject
    ).core_dump = "enabled";
  });
  rejectMutation("ordinary DTMF decode-all", (value) => {
    (
      value.dtmf.normal_path_acquisition as JsonObject
    ).decode_all_ordinary_media = "required";
  });
  rejectMutation("DTMF notification capability bypass", (value) => {
    (
      value.dtmf.normal_path_acquisition as JsonObject
    ).required_backend_capability_id = "ordinary_rtp_rtcp";
  });
  rejectMutation("ICE consent freshness optional", (value) => {
    (value.media_protocol_invariants.ice as JsonObject).consent_freshness =
      "optional";
  });
  rejectMutation("alternating handoff generation reuse", (value) => {
    (
      value.livekit_handoff.alternating_handoff_contract as JsonObject
    ).new_generation_per_switch = false;
  });
  rejectMutation("concurrent handoff last-write-wins", (value) => {
    (
      (value.livekit_handoff.alternating_handoff_contract as JsonObject)
        .concurrent_arbitration as JsonObject
    ).winner_rule = "last_write_wins";
  });
  rejectMutation("capability semantic key duplication", (value) => {
    const capabilities = value.backend_capability_sets[0]
      .capabilities as JsonObject[];
    capabilities[1].capability_id = capabilities[0].capability_id;
  });
  rejectMutation("RTPengine zero-output weakening", (value) => {
    value.rtpengine_atomic_lifecycle.zero_output_requirement =
      "participant_muted";
  });
  rejectMutation("make-before-break promotion", (value) => {
    (value.livekit_handoff.state_contract as JsonObject).current_handoff_mode =
      "make_before_break";
  });
  rejectMutation("merged terminate delete fact", (value) => {
    const operations = value.livekit_handoff.operations as JsonObject[];
    const terminate = operations.find(
      (operation) => operation.operation_id === "terminate",
    );
    const deleteOperation = operations.find(
      (operation) => operation.operation_id === "delete",
    );
    assert.ok(terminate && deleteOperation);
    deleteOperation.durable_fact = terminate.durable_fact;
  });
  rejectMutation("borrowed bridge capacity result", (value) => {
    value.livekit_handoff.results_inheritable = true;
  });
  rejectMutation("one path cannot promote a global bridge result", (value) => {
    const paths = value.livekit_handoff.paths as JsonObject[];
    const slices = paths[0].evidence_slices as JsonObject[];
    slices[0].status = "passed";
    value.livekit_handoff.physical_result_status = "passed";
  });
  rejectMutation("cross-path bridge evidence inheritance", (value) => {
    const paths = value.livekit_handoff.paths as JsonObject[];
    const slices = paths[1].evidence_slices as JsonObject[];
    slices[1].results_inheritable = true;
  });
  rejectMutation("fabricated production evidence", (value) => {
    value.livekit_handoff.production_result_status = "passed";
  });
  rejectMutation("last-write-wins bridge head", (value) => {
    (
      value.livekit_handoff.store_contract as JsonObject
    ).head_compare_and_swap_fields = ["state"];
  });
  rejectMutation("old/new bridge store dual write", (value) => {
    (
      value.livekit_handoff.store_contract as JsonObject
    ).migration_writer_policy = "dual_write_allowed";
  });
  rejectMutation("second root recording manifest", (value) => {
    (
      value.livekit_handoff.recording_manifest_contract as JsonObject
    ).root_manifest_count_per_interaction_role = 2;
  });
  rejectMutation("internal service bare HTTP bypass", (value) => {
    (
      value.livekit_handoff.control_endpoint_security as JsonObject
    ).internal_service_http_bypass = true;
  });
  rejectMutation("U2 whole-foundation dependency", (value) => {
    const u2 = value.phase_gates.find((phase) => phase.phase_id === "U2");
    assert.ok(u2);
    u2.depends_on = ["D0", "U1"];
  });
  rejectMutation("U6 whole U5 dependency", (value) => {
    const u6 = value.phase_gates.find((phase) => phase.phase_id === "U6");
    assert.ok(u6);
    u6.depends_on = ["D0", "U1", "U3", "U5"];
  });
});

test("Revision 4 phase dependencies keep U2 independent and gate U6 by selected slices", () => {
  const phases = new Map(
    contract().phase_gates.map((phase) => [phase.phase_id, phase]),
  );
  assert.deepEqual(phases.get("U2")?.depends_on, ["D0"]);
  assert.deepEqual(phases.get("U6")?.depends_on, ["D0"]);
  assert.equal(phases.get("U6")?.dependency_mode, "slice_gated");
  const slices = phases.get("U6")?.slice_dependencies as JsonObject[];
  assert.deepEqual(
    slices.map((slice) => slice.slice_id),
    [
      "repository_schema_backfill",
      "durable_coordinator_and_new_call_bridge",
      "v2l_new_l2v_new",
      "v2l_active_l2v_active",
      "g729_carrier_leg",
      "advanced_sip_transport_or_transfer",
      "recording_billing_closure",
      "production_fault_capacity",
    ],
  );
  assert.deepEqual(slices[0].required_predecessors, ["D0"]);
  assert.equal(
    slices[0].gate_effect,
    "contract_and_storage_only_no_runtime_behavior",
  );
  assert.deepEqual(slices[4].required_predecessors, [
    "U2",
    "U5:g729_corresponding_integration_slice",
  ]);
  assert.deepEqual(slices[5].required_predecessors, [
    "U4:applicable_qualified_module",
  ]);
  assert.deepEqual(slices[6].required_predecessors, [
    "U6:lifecycle_contract",
    "U7:root_manifest_source_chain_physical_evidence",
  ]);
  assert.deepEqual(slices[7].required_predecessors, [
    "U7:evidence_observability",
    "U8:physical_qualification",
    "U9:finalization",
  ]);
  assert.ok(slices.every((slice) => slice.results_inheritable === false));
});

test("Revision 4 keeps every semantic key unique across keyed collections", () => {
  const value = contract();
  assertUniqueSemanticKeys(
    value.backend_capability_sets,
    "backend_id",
    "backend_capability_sets",
  );
  assertUniqueSemanticKeys(
    value.recovery_matrix,
    "state_id",
    "recovery_matrix",
  );
  assertUniqueSemanticKeys(
    value.current_target_eligibility,
    "component_id",
    "current_target_eligibility",
  );
  assertUniqueSemanticKeys(value.phase_gates, "phase_id", "phase_gates");
  const u6 = value.phase_gates.find((phase) => phase.phase_id === "U6");
  assert.ok(u6);
  assertUniqueSemanticKeys(
    u6.slice_dependencies as JsonObject[],
    "slice_id",
    "phase_gates.U6.slice_dependencies",
  );
  assertUniqueSemanticKeys(
    value.livekit_handoff.paths as JsonObject[],
    "path_id",
    "livekit_handoff.paths",
  );
  assertUniqueSemanticKeys(
    value.livekit_handoff.directed_edges as JsonObject[],
    "edge_role",
    "livekit_handoff.directed_edges",
  );
  assertUniqueSemanticKeys(
    value.livekit_handoff.operations as JsonObject[],
    "operation_id",
    "livekit_handoff.operations",
  );
  assertUniqueSemanticKeys(
    value.rtpengine_atomic_lifecycle.operations as JsonObject[],
    "operation_id",
    "rtpengine_atomic_lifecycle.operations",
  );
});

test("Revision 4 fails closed on every backend lifecycle operation independently", () => {
  const value = contract();
  const operationIds = [
    "allocation",
    "prepare",
    "commit",
    "abort",
    "revoke",
    "fence",
    "query",
    "reconcile",
    "migration",
    "notification",
    "member_flow_fence",
    "zero_output_ack",
    "security_termination_scope",
  ];
  const operationKeys = [
    "operation_id",
    "required",
    "support",
    "verified",
    "granularity",
    "prerequisites",
    "unmet_prerequisite_policy",
  ];

  for (const backend of value.backend_capability_sets) {
    const lifecycle = backend.lifecycle_contract as JsonObject;
    const operations = lifecycle.operation_contracts as JsonObject[];
    assert.deepEqual(
      operations.map((operation) => operation.operation_id),
      operationIds,
      String(backend.backend_id),
    );
    assertUniqueSemanticKeys(
      operations,
      "operation_id",
      `${String(backend.backend_id)}.lifecycle.operation_contracts`,
    );
    for (const operation of operations) {
      assert.deepEqual(Object.keys(operation), operationKeys);
      assert.equal(operation.required, true);
      assert.ok(
        ["supported", "partial", "unsupported", "unknown"].includes(
          operation.support as string,
        ),
      );
      assert.equal(operation.verified, "not_run");
      assert.ok(
        [
          "backend",
          "binding_group",
          "directed_edge",
          "member_flow",
          "bridge_generation",
        ].includes(operation.granularity as string),
      );
      assert.ok(
        Array.isArray(operation.prerequisites) &&
          operation.prerequisites.length > 0,
      );
      assert.equal(
        operation.unmet_prerequisite_policy,
        "fail_closed_without_side_effect_and_freeze_exact_generation",
      );
    }
  }

  assert.deepEqual(value.media_graph_compiler.lifecycle_operation_gate, {
    required_operations: operationIds,
    requirement_sources: {
      lifecycle_operations:
        "backend_capability_sets.lifecycle_contract.operation_contracts",
      media_features: "backend_capability_sets.capabilities",
    },
    input_fields: ["support", "verified", "granularity", "prerequisites"],
    support_requirement: "supported",
    verification_requirement: "passed",
    granularity_requirement: "exact_operation_scope",
    prerequisite_requirement: "all_declared_prerequisites_passed",
    evaluation: "each_operation_independent_no_aggregate_inference",
    failure_mode: "fail_closed_without_side_effect_and_freeze_exact_generation",
  });
  assert.equal(
    value.media_graph_compiler.required_capability_rule,
    "support_must_be_supported_and_verified_passed",
  );
  for (const error of [
    "lifecycle_operation_missing",
    "lifecycle_operation_not_supported",
    "lifecycle_operation_not_verified",
    "lifecycle_operation_granularity_mismatch",
    "lifecycle_operation_prerequisite_unmet",
  ]) {
    assert.ok(
      (value.media_graph_compiler.compile_errors as string[]).includes(error),
      error,
    );
  }
});

test("Revision 4 admits capacity only against signed identity-bound atomic supply", () => {
  const demand = contract().capacity_demand;
  const workerFields = [
    "worker_count",
    "shard_count",
    "queue_depth",
    "service_time_micros",
    "backpressure_limit",
  ];
  const compiler = demand.media_plan_compiler as JsonObject;
  for (const field of workerFields) {
    assert.ok((compiler.plan_inputs as string[]).includes(field), field);
    assert.ok((compiler.demand_outputs as string[]).includes(field), field);
  }

  const supplyIdentityFields = [
    "capacity_profile_id",
    "profile_revision",
    "role",
    "backend_source_digest",
    "binary_digest",
    "config_digest",
    "hardware_profile_id",
    "cell_id",
    "failure_domain_id",
    "issued_at",
    "expires_at",
    "signature_key_id",
  ];
  for (const supply of demand.role_supply as JsonObject[]) {
    assert.deepEqual(supply.supply_identity_fields, supplyIdentityFields);
    assert.equal(
      supply.unit_binding,
      "exact_capacity_vector_field_id_and_unit",
    );
    assert.equal(supply.verification_status, "not_run");
  }

  const admission = demand.admission_contract as JsonObject;
  assert.deepEqual(admission, {
    worker_demand_fields: workerFields,
    supply_identity_fields: supplyIdentityFields,
    supply_signature: "required_and_verified_before_admission",
    admission_predicate: {
      evaluation_scope: "each_capacity_vector_dimension",
      numeric_policy: "checked_u64_no_wrap_saturate_or_negative",
      comparison: {
        left: "deduplicated_demand",
        operator: "less_than_or_equal",
        right_base: "signed_unexpired_identity_bound_supply",
        right_subtract: ["active_reservations", "failure_reserve"],
      },
      supply_preconditions: [
        "present",
        "signature_verified",
        "unexpired",
        "identity_match",
        "unit_match",
      ],
      shared_transport_dedupe_key: [
        "binding_group_id",
        "binding_group_generation",
        "wire_transport_bundle_id",
      ],
      same_dedupe_key_different_vector: "conflict_fail_closed",
      overflow_policy: "reject_admission",
      underflow_policy: "reject_admission",
    },
    reservation_compare_and_swap_fields: [
      "capacity_profile_id",
      "profile_revision",
      "reservation_epoch",
      "available_vector_digest",
    ],
    reservation_receipt_identity_fields: [
      "tenant_id",
      "interaction_id",
      "media_plan_generation",
      "reservation_id",
      "capacity_profile_id",
      "profile_revision",
      "demand_vector_digest",
      "failure_reserve_vector_digest",
      "decision_hash",
    ],
    reservation_order: "atomic_cas_receipt_durable_before_backend_prepare",
    missing_supply_policy: "reject_admission",
    stale_or_expired_supply_policy: "reject_admission",
    identity_or_unit_mismatch_policy: "reject_admission",
    n_plus_1_predicate: {
      failure_domain_selection: "largest_declared_failure_domain",
      comparison: {
        left: "supply_minus_active_reservations_minus_largest_failure_domain",
        operator: "greater_than_or_equal",
        right: "peak_admitted_demand",
      },
      missing_failure_domain_policy: "reject_admission",
    },
    verification_status: "not_run",
    production_eligible: false,
  });

  type Vector = Record<string, bigint>;
  type AdmissionInput = {
    demand: Vector;
    supply: Vector;
    activeReservations: Vector;
    failureReserve: Vector;
    largestFailureDomain: Vector;
    peakAdmittedDemand: Vector;
    sharedTransportDemand: Array<{ key: string; demand: Vector }>;
    supplyPresent: boolean;
    signatureVerified: boolean;
    identityMatch: boolean;
    unitMatch: boolean;
    nowEpochSeconds: bigint;
    expiresAtEpochSeconds: bigint;
  };
  const maxU64 = (1n << 64n) - 1n;
  const evaluateAdmission = (input: AdmissionInput): boolean => {
    const predicate = admission.admission_predicate as JsonObject;
    assert.equal(
      predicate.numeric_policy,
      "checked_u64_no_wrap_saturate_or_negative",
    );
    if (
      !input.supplyPresent ||
      !input.signatureVerified ||
      !input.identityMatch ||
      !input.unitMatch ||
      input.expiresAtEpochSeconds <= input.nowEpochSeconds
    )
      return false;

    const vectorIdentity = (vector: Vector): string =>
      Object.entries(vector)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dimension, value]) => `${dimension}:${value}`)
        .join("|");
    const uniqueShared = new Map<string, Vector>();
    for (const shared of input.sharedTransportDemand) {
      const existing = uniqueShared.get(shared.key);
      if (
        existing !== undefined &&
        vectorIdentity(existing) !== vectorIdentity(shared.demand)
      ) {
        return false;
      }
      if (existing === undefined) {
        uniqueShared.set(shared.key, shared.demand);
      }
    }
    const dimensions = new Set([
      ...Object.keys(input.demand),
      ...Object.keys(input.supply),
      ...Object.keys(input.activeReservations),
      ...Object.keys(input.failureReserve),
      ...Object.keys(input.largestFailureDomain),
      ...Object.keys(input.peakAdmittedDemand),
      ...[...uniqueShared.values()].flatMap(Object.keys),
    ]);
    const read = (vector: Vector, dimension: string): bigint | null => {
      const value = vector[dimension] ?? 0n;
      return value < 0n || value > maxU64 ? null : value;
    };
    for (const dimension of dimensions) {
      if (!(dimension in input.supply)) return false;
      const values = [
        read(input.demand, dimension),
        read(input.supply, dimension),
        read(input.activeReservations, dimension),
        read(input.failureReserve, dimension),
        read(input.largestFailureDomain, dimension),
        read(input.peakAdmittedDemand, dimension),
      ];
      if (values.some((value) => value === null)) return false;
      const [
        baseDemand,
        supply,
        activeReservations,
        failureReserve,
        largestFailureDomain,
        peakAdmittedDemand,
      ] = values as bigint[];
      let deduplicatedDemand = baseDemand;
      for (const shared of uniqueShared.values()) {
        const sharedDemand = read(shared, dimension);
        if (
          sharedDemand === null ||
          deduplicatedDemand > maxU64 - sharedDemand
        ) {
          return false;
        }
        deduplicatedDemand += sharedDemand;
      }
      if (
        activeReservations > supply ||
        failureReserve > supply - activeReservations
      )
        return false;
      if (deduplicatedDemand > supply - activeReservations - failureReserve)
        return false;
      if (
        largestFailureDomain > supply - activeReservations ||
        peakAdmittedDemand > supply - activeReservations - largestFailureDomain
      )
        return false;
    }
    return true;
  };

  const exactFit: AdmissionInput = {
    demand: { cpu: 6n },
    supply: { cpu: 10n },
    activeReservations: { cpu: 2n },
    failureReserve: { cpu: 2n },
    largestFailureDomain: { cpu: 2n },
    peakAdmittedDemand: { cpu: 6n },
    sharedTransportDemand: [],
    supplyPresent: true,
    signatureVerified: true,
    identityMatch: true,
    unitMatch: true,
    nowEpochSeconds: 100n,
    expiresAtEpochSeconds: 101n,
  };
  assert.equal(evaluateAdmission(exactFit), true);
  assert.equal(
    evaluateAdmission({
      ...exactFit,
      demand: { cpu: 7n },
    }),
    false,
  );
  for (const invalid of [
    { supplyPresent: false },
    { signatureVerified: false },
    { identityMatch: false },
    { unitMatch: false },
    { expiresAtEpochSeconds: 100n },
  ]) {
    assert.equal(evaluateAdmission({ ...exactFit, ...invalid }), false);
  }
  assert.equal(
    evaluateAdmission({
      ...exactFit,
      demand: { cpu: 4n },
      supply: { cpu: 8n },
      activeReservations: { cpu: 0n },
      sharedTransportDemand: [
        { key: "group:1:wire:1", demand: { cpu: 2n } },
        { key: "group:1:wire:1", demand: { cpu: 2n } },
      ],
      largestFailureDomain: { cpu: 2n },
      peakAdmittedDemand: { cpu: 6n },
    }),
    true,
  );
  assert.equal(
    evaluateAdmission({
      ...exactFit,
      demand: { cpu: 4n },
      supply: { cpu: 9n },
      activeReservations: { cpu: 0n },
      sharedTransportDemand: [
        { key: "group:1:wire:1", demand: { cpu: 2n } },
        { key: "group:1:wire:1", demand: { cpu: 3n } },
      ],
      largestFailureDomain: { cpu: 2n },
      peakAdmittedDemand: { cpu: 6n },
    }),
    false,
  );
  assert.equal(
    evaluateAdmission({
      ...exactFit,
      demand: { cpu: 1n },
      supply: { cpu: 10n },
      activeReservations: { cpu: 3n },
      failureReserve: { cpu: 2n },
      largestFailureDomain: { cpu: 4n },
      peakAdmittedDemand: { cpu: 7n },
    }),
    false,
  );
  assert.equal(
    evaluateAdmission({
      ...exactFit,
      demand: { cpu: maxU64 + 1n },
      supply: { cpu: maxU64 },
    }),
    false,
  );
  assert.equal(
    evaluateAdmission({
      ...exactFit,
      supply: { cpu: 1n },
      activeReservations: { cpu: 2n },
    }),
    false,
  );
});

test("Revision 4 gives every durable artifact a closed N and N plus 1 schema contract", () => {
  const rolling = contract().rolling_schema_rules;
  const artifactTypes = rolling.versioned_artifacts as string[];
  const artifacts = rolling.artifact_contracts as JsonObject[];
  assert.deepEqual(
    artifacts.map((artifact) => artifact.artifact_type),
    artifactTypes,
  );
  assertUniqueSemanticKeys(
    artifacts,
    "artifact_type",
    "rolling_schema_rules.artifact_contracts",
  );
  for (const artifact of artifacts) {
    assert.deepEqual(Object.keys(artifact), [
      "artifact_type",
      "schema_id",
      "target_schema_versions",
      "schema_hashes",
      "current_writer_version",
      "current_writer_identity",
      "current_status",
      "reader_matrix",
      "writer_enable_gate",
      "writer_expand_contract",
      "takeover_prerequisites",
      "migration",
      "rollback",
      "retention",
      "garbage_collection",
      "verification_status",
      "production_eligible",
    ]);
    assert.equal(artifact.schema_id, `${String(artifact.artifact_type)}-v1`);
    assert.deepEqual(artifact.target_schema_versions, {
      n: "1.0.0",
      n_plus_1: "1.1.0",
    });
    assert.deepEqual(artifact.schema_hashes, {
      n: null,
      n_plus_1: null,
      verification_status: "not_run",
    });
    assert.equal(artifact.current_writer_version, null);
    assert.equal(artifact.current_writer_identity, null);
    assert.equal(artifact.current_status, "not_run");
    assert.deepEqual(artifact.reader_matrix, {
      reader_n_reads_writer_n: true,
      reader_n_reads_writer_n_plus_1: false,
      reader_n_plus_1_reads_writer_n: true,
      reader_n_plus_1_reads_writer_n_plus_1: true,
    });
    assert.equal(
      artifact.writer_enable_gate,
      "registry_receipt_and_both_schema_hashes_verified_all_live_readers_compatible",
    );
    assert.equal(
      artifact.writer_expand_contract,
      "expand_then_dual_read_single_write_then_contract",
    );
    assert.deepEqual(artifact.takeover_prerequisites, [
      "reader_matrix_verified",
      "schema_and_adapter_identity_match",
      "oldest_live_reader_supports_writer_version",
    ]);
    assert.equal(
      artifact.migration,
      "idempotent_versioned_per_object_with_durable_receipt",
    );
    assert.equal(
      artifact.rollback,
      "writer_n_until_all_reader_n_instances_are_drained",
    );
    assert.equal(
      artifact.retention,
      "retain_source_and_migration_receipts_until_rollback_window_closed",
    );
    assert.equal(
      artifact.garbage_collection,
      "only_after_no_live_reader_writer_or_rollback_reference",
    );
    assert.equal(artifact.verification_status, "not_run");
    assert.equal(artifact.production_eligible, false);
  }
});

test("Revision 4 freezes atomic store boundaries and deterministic failure responses", () => {
  const store = contract().durable_store_slo;
  assert.deepEqual(store.atomic_boundaries, {
    call_admission: [
      "call_session",
      "protocol_effect",
      "effect_wal",
      "capacity_reservation_receipt",
      "idempotency_record",
    ],
    media_generation: [
      "media_plan",
      "directed_media_edges",
      "backend_binding_groups",
      "capacity_reservation_receipt",
    ],
    bridge_head: [
      "bridge_command",
      "bridge_decision",
      "bridge_receipt",
      "head_compare_and_swap",
    ],
    recording: [
      "recording_intent",
      "root_recording_manifest",
      "source_chain",
      "segment_reference",
    ],
    commit_rule: "all_or_nothing_single_region_transaction",
    partial_commit_policy: "rollback_and_return_stable_failure_code",
    business_visible_effect_gates: {
      route_activation: "after_call_admission_durable_decision",
      media_activation:
        "after_media_generation_and_bridge_head_durable_decisions",
      billing: "after_call_admission_or_bridge_durable_decision",
      recording: "after_recording_durable_decision",
      webhook: "after_protocol_or_bridge_effect_durable_decision",
    },
  });
  const retry = store.retry_after_contract as JsonObject;
  assert.deepEqual(retry, {
    input_fields: [
      "failure_code",
      "pool_wait_ms",
      "queue_depth",
      "retry_attempt",
    ],
    input_constraints: {
      failure_code: {
        membership: "degradation_cause_codes",
      },
      pool_wait_ms: {
        type: "u64",
        minimum: 0,
        maximum: 250,
      },
      queue_depth: {
        type: "u64",
        minimum: 0,
        maximum: 1024,
      },
      retry_attempt: {
        type: "u64",
        minimum: 0,
        maximum: 3,
      },
    },
    numeric_policy: "checked_u64_reject_overflow",
    base_seconds: 1,
    pool_wait_divisor_ms: 1000,
    queue_depth_divisor: 256,
    retry_attempt_seconds: 1,
    formula: {
      operation: "clamp",
      minimum_field: "minimum_seconds",
      maximum_field: "maximum_seconds",
      value: {
        operation: "checked_add",
        operands: [
          "base_seconds",
          {
            operation: "checked_ceil_div",
            numerator_field: "pool_wait_ms",
            divisor_field: "pool_wait_divisor_ms",
          },
          {
            operation: "checked_ceil_div",
            numerator_field: "queue_depth",
            divisor_field: "queue_depth_divisor",
          },
          {
            operation: "checked_multiply",
            left_field: "retry_attempt",
            right_field: "retry_attempt_seconds",
          },
        ],
      },
    },
    minimum_seconds: 1,
    maximum_seconds: 30,
    jitter: "forbidden",
    same_inputs_same_output: true,
    invalid_input_policy: "reject_without_fabricated_retry_after",
  });
  const retryAfter = (input: {
    poolWaitMs: number;
    queueDepth: number;
    retryAttempt: number;
  }): number => {
    const raw =
      Number(retry.base_seconds) +
      Math.ceil(input.poolWaitMs / Number(retry.pool_wait_divisor_ms)) +
      Math.ceil(input.queueDepth / Number(retry.queue_depth_divisor)) +
      input.retryAttempt * Number(retry.retry_attempt_seconds);
    return Math.min(
      Number(retry.maximum_seconds),
      Math.max(Number(retry.minimum_seconds), raw),
    );
  };
  assert.equal(
    retryAfter({
      poolWaitMs: 250,
      queueDepth: 256,
      retryAttempt: 1,
    }),
    4,
  );
  assert.equal(
    retryAfter({
      poolWaitMs: 250,
      queueDepth: 256,
      retryAttempt: 1,
    }),
    4,
  );

  const responses = store.failure_responses as JsonObject[];
  assert.deepEqual(
    responses.map((response) => response.failure_code),
    store.degradation_cause_codes,
  );
  assertUniqueSemanticKeys(
    responses,
    "failure_code",
    "durable_store_slo.failure_responses",
  );
  for (const response of responses) {
    assert.equal(response.sip_status, 503);
    assert.equal("http_status" in response, false);
    assert.equal(response.retry_after_required, true);
    assert.equal(response.partial_commit_allowed, false);
  }
});

test("Revision 4 bounds RFC3263 candidates and retains every protocol effect", () => {
  assert.deepEqual(contract().sip_transaction_policy.rfc3263_contract, {
    candidate_order: [
      "naptr_order_and_preference",
      "srv_priority_and_weight",
      "address_family_policy",
    ],
    candidate_identity_fields: [
      "target_fqdn",
      "transport",
      "port",
      "address",
      "naptr_order",
      "naptr_preference",
      "srv_priority",
      "srv_weight",
    ],
    dns_query_timeout_ms: 2000,
    candidate_connect_timeout_ms: 3000,
    candidate_attempt_ceiling: 8,
    per_candidate_retry_ceiling: 1,
    total_resolution_connect_deadline_ms: 10000,
    exhaustion_policy:
      "terminal_effect_with_ordered_candidate_attempt_receipts",
    effect_retention: {
      candidate_attempt_receipt_ms: 86400000,
      transaction_effect_ms: 604800000,
      late_response_correlation_ms: 32000,
      gc_policy:
        "only_after_transaction_dialog_recovery_and_rollback_references_expire",
    },
    verification_status: "not_run",
  });
});

test("Revision 4 makes active timers an explicit failed-closed recovery state", () => {
  const activeTimers = contract().recovery_matrix.find(
    (state) => state.state_id === "active_timers",
  );
  assert.deepEqual(activeTimers, {
    state_id: "active_timers",
    current_status: "unavailable",
    target_policy: "fail_closed_or_protocol_restart",
    verification_status: "not_run",
    lossless_restore_claim: false,
    persist_runtime_instant: false,
    cross_adapter_restore: false,
  });
});

test("Revision 4 requires three-party active-zero before deletion-safe drain", () => {
  const drain = contract().migration_drain;
  assert.equal("emergency_termination_allowed" in drain, false);
  assert.deepEqual(drain.three_party_drain_contract, {
    authoritative_sources: [
      {
        source_id: "unified_rustpbx",
        required_zero_counters: [
          "call_count",
          "protocol_session_count",
          "edge_count",
          "binding_group_count",
        ],
      },
      {
        source_id: "rtpengine",
        required_zero_counters: [
          "session_count",
          "port_count",
          "allocation_count",
          "generation_count",
        ],
      },
      {
        source_id: "effect_wal",
        required_zero_counters: [
          "pending_effect_count",
          "unknown_effect_count",
          "repair_delta_count",
          "cleanup_delta_count",
        ],
      },
    ],
    source_receipt_identity_fields: [
      "tenant_id",
      "drain_scope_id",
      "generation",
      "observation_epoch",
      "counter_vector_digest",
      "receipt_digest",
    ],
    counter_numeric_policy: "checked_u64",
    active_zero_predicate: {
      operator: "all",
      required_source_count: 3,
      comparison: {
        left: "every_required_zero_counter",
        operator: "equals",
        right: 0,
      },
      consistency:
        "all_source_receipts_match_exact_tenant_drain_scope_generation_and_observation_epoch",
      missing_stale_or_mismatched_policy: "not_active_zero_continue_drain",
    },
    deletion_reference_counters: [
      "retention_reference_count",
      "rollback_reference_count",
    ],
    deletion_safe_predicate: {
      operator: "all",
      clauses: [
        "active_zero_predicate_passed",
        "three_source_consistency_passed",
        "retention_reference_count_equals_zero",
        "rollback_reference_count_equals_zero",
      ],
      failure_policy: "not_deletion_safe_continue_drain",
    },
    normal_timeout_action:
      "stop_new_admission_keep_drain_no_bye_no_forced_delete",
    normal_timeout_bye_allowed: false,
    normal_timeout_delete_allowed: false,
    emergency_authorization: {
      required: true,
      fields: [
        "actor",
        "reason_code",
        "incident_id",
        "scope",
        "expires_at",
        "decision_hash",
      ],
      separate_from_normal_timeout: true,
    },
    emergency_action: "exact_scope_terminal_bye_or_delete_with_audit_receipt",
    verification_status: "not_run",
    production_eligible: false,
  });

  const contractValue = drain.three_party_drain_contract as JsonObject;
  const sources = contractValue.authoritative_sources as JsonObject[];
  assertUniqueSemanticKeys(
    sources,
    "source_id",
    "migration_drain.three_party_drain_contract.authoritative_sources",
  );
  const deletionSafe = (
    observations: Record<string, Record<string, bigint>>,
    retentionReferences: bigint,
    rollbackReferences: bigint,
  ): boolean =>
    sources.every((source) => {
      const observed = observations[String(source.source_id)];
      return (
        observed !== undefined &&
        (source.required_zero_counters as string[]).every(
          (counter) => observed[counter] === 0n,
        )
      );
    }) &&
    retentionReferences === 0n &&
    rollbackReferences === 0n;
  const allZero = Object.fromEntries(
    sources.map((source) => [
      String(source.source_id),
      Object.fromEntries(
        (source.required_zero_counters as string[]).map((counter) => [
          counter,
          0n,
        ]),
      ),
    ]),
  );
  assert.equal(deletionSafe(allZero, 0n, 0n), true);
  assert.equal(
    deletionSafe(
      {
        ...allZero,
        rtpengine: { ...allZero.rtpengine, port_count: 1n },
      },
      0n,
      0n,
    ),
    false,
  );
  assert.equal(deletionSafe(allZero, 1n, 0n), false);
  assert.equal(deletionSafe(allZero, 0n, 1n), false);
});

test("Revision 4 authenticates, bounds and durably orders normal-path DTMF", () => {
  assert.deepEqual(contract().dtmf.delivery_contract, {
    transport: "rtpengine_authenticated_event_notification",
    authentication: {
      mechanism: "mutual_tls_and_hmac_signed_payload",
      identity_fields: [
        "backend_instance_id",
        "binding_group_generation",
        "tenant_id",
        "interaction_id",
        "leg_id",
      ],
      failure_policy: "reject_without_business_effect",
    },
    ordering_scope: "tenant_interaction_leg",
    bounded_queue: {
      queue_depth_max: 1024,
      event_bytes_max: 4096,
      delivery_deadline_ms: 50,
      overflow_policy: "freeze_business_effect_then_query_exact_leg",
    },
    durable_sequence: {
      field: "event_sequence",
      allocation: "monotonic_compare_and_swap_per_leg",
      persistence_order: "durable_before_business_effect",
      duplicate_policy: "replay_same_receipt_without_second_effect",
      gap_policy: "freeze_then_query_and_reconcile_exact_leg",
    },
    receipt_identity_fields: [
      "event_id",
      "event_sequence",
      "payload_hash",
      "backend_identity_digest",
      "received_at",
    ],
    same_identity_different_hash: "conflict_fail_closed",
    query_prerequisite:
      "backend_query_supported_and_verified_before_business_effect_eligibility",
    verification_status: "not_run",
    production_eligible: false,
  });
});

test("Revision 4 enumerates independent Voice-LiveKit scenario property and fault vectors", () => {
  assert.deepEqual(contract().livekit_handoff.machine_verification_vectors, {
    required_round_trips: 32,
    scenario_vectors: [
      "same_call_32_round_trip_v2l_l2v",
      "concurrent_head_cas_single_winner",
      "terminal_zero_resource_leak",
      "cancel_before_prepare_ack",
      "cancel_after_apply_before_receipt",
      "token_expiry_before_prepare",
      "token_expiry_during_active",
      "webhook_duplicate_reordered_replayed_forged",
    ],
    property_vectors: [
      "every_switch_allocates_new_generation",
      "cas_loser_never_emits_media",
      "one_call_cdr_rating_and_root_manifest",
      "terminal_cleanup_is_idempotent",
      "cancel_terminal_prevents_recreate",
      "token_scope_matches_exact_generation",
      "webhook_requires_exact_identity_and_receipt_digest",
    ],
    fault_vectors: [
      "timeout_before_apply",
      "timeout_after_apply",
      "coordinator_crash_after_decision",
      "livekit_sip_unavailable",
      "sfu_disconnect",
      "webhook_loss_duplicate_and_reorder",
      "token_expiry",
      "store_head_cas_conflict",
      "cleanup_retry_and_dead_letter",
    ],
    vectors_independently_required: true,
    results_inheritable: false,
    verification_status: "not_run",
    production_eligible: false,
  });
});

test("Revision 4 closes LiveKit token cancellation and webhook machine contracts", () => {
  const handoff = contract().livekit_handoff;
  assert.deepEqual(handoff.command_token_contract, {
    identity_fields: [
      "tenant_id",
      "interaction_id",
      "bridge_id",
      "bridge_generation",
      "operation_id",
      "idempotency_key",
      "issued_at",
      "expires_at",
      "key_id",
    ],
    authentication:
      "asymmetric_signature_verified_against_pinned_issuer_identity",
    scope_match_policy:
      "tenant_interaction_bridge_generation_operation_and_key_exact_match",
    expiry_comparison: "checked_now_strictly_before_expires_at",
    pre_prepare_expiry: "reject_without_command_or_resource",
    active_expiry: "block_new_commands_without_mutating_committed_generation",
    identity_mismatch: "reject_fail_closed",
    replay_policy: "same_identity_and_hash_replay_same_receipt",
    same_identity_different_hash: "conflict_fail_closed",
    verification_status: "not_run",
    production_eligible: false,
  });
  assert.deepEqual(handoff.cancellation_contract, {
    identity_fields: [
      "tenant_id",
      "interaction_id",
      "bridge_id",
      "bridge_generation",
      "command_id",
      "idempotency_key",
      "command_hash",
    ],
    ordering_field: "command_sequence",
    ordering_scope: "bridge_generation",
    durability: "cancel_tombstone_durable_before_ack",
    before_prepare_ack: "abort_or_release_without_writer",
    after_apply_before_receipt:
      "query_exact_generation_then_reconcile_to_terminal",
    terminal_prevents_recreate: true,
    duplicate_policy: "replay_same_cancel_receipt",
    same_identity_different_hash: "conflict_fail_closed",
    late_success_after_cancel:
      "terminal_cancel_wins_freeze_and_cleanup_exact_generation",
    verification_status: "not_run",
    production_eligible: false,
  });
  assert.deepEqual(handoff.webhook_contract, {
    authentication: "verified_signature_and_pinned_provider_identity",
    identity_fields: [
      "tenant_id",
      "interaction_id",
      "bridge_id",
      "bridge_generation",
      "provider_id",
      "provider_event_id",
      "provider_sequence",
      "event_type",
      "receipt_digest",
      "payload_hash",
    ],
    ordering_scope: "tenant_interaction_bridge_generation",
    ordering_field: "provider_sequence",
    scope_match_policy:
      "provider_tenant_interaction_bridge_generation_and_receipt_digest_exact_match",
    reorder_window_max: 128,
    durability: "receipt_durable_before_business_effect",
    duplicate_replay:
      "same_identity_and_hash_replay_same_receipt_without_second_effect",
    same_identity_different_hash: "conflict_fail_closed",
    reorder_policy: "bounded_buffer_else_freeze_query_and_reconcile",
    forged_policy: "reject_without_business_effect",
    terminal_event_rule:
      "terminal_tombstone_prevents_nonterminal_replay_or_recreate",
    verification_status: "not_run",
    production_eligible: false,
  });
});

test("Revision 4 deterministically models 32 LiveKit round trips and terminal faults", () => {
  const handoff = contract().livekit_handoff;
  const vectors = handoff.machine_verification_vectors as JsonObject;
  const alternating = handoff.alternating_handoff_contract as JsonObject;
  const roundTrips = Number(vectors.required_round_trips);
  const paths = alternating.active_path_cycle as string[];
  type ResourceName =
    | "participants"
    | "port_pairs"
    | "backend_allocations"
    | "writers"
    | "pending_commands"
    | "unreconciled_receipts";
  const resourceNames = alternating.terminal_zero_leak as ResourceName[];
  assert.deepEqual(resourceNames, [
    "participants",
    "port_pairs",
    "backend_allocations",
    "writers",
    "pending_commands",
    "unreconciled_receipts",
  ]);
  const zeroResources = (): Record<ResourceName, number> =>
    Object.fromEntries(resourceNames.map((name) => [name, 0])) as Record<
      ResourceName,
      number
    >;
  const scope = {
    tenantId: "tenant-a",
    interactionId: "interaction-a",
    bridgeId: "bridge-a",
  };
  const model = {
    headRevision: 0,
    nextGeneration: 0,
    activeGeneration: null as number | null,
    generationResources: new Map<number, Record<ResourceName, number>>(),
    stableBusinessCounters: {
      calls: 1,
      cdrs: 1,
      billingSessions: 1,
      rootRecordingManifests: 1,
    },
    commandReceipts: new Map<
      string,
      { hash: string; result: "winner"; generation: number }
    >(),
    cancelTombstones: new Set<string>(),
    terminalGenerations: new Set<number>(),
    webhookReceipts: new Map<
      string,
      { hash: string; sequence: number; generation: number }
    >(),
    lastWebhookSequence: 0,
    webhookEffects: 0,
  };
  const generations: number[] = [];
  const revokeGeneration = (generation: number): void => {
    assert.ok(model.generationResources.has(generation));
    model.generationResources.set(generation, zeroResources());
    model.terminalGenerations.add(generation);
    if (model.activeGeneration === generation) model.activeGeneration = null;
  };
  const assertGenerationIsolation = (): void => {
    for (const [generation, resources] of model.generationResources) {
      if (generation === model.activeGeneration) {
        assert.deepEqual(resources, {
          participants: 1,
          port_pairs: 1,
          backend_allocations: 1,
          writers: 1,
          pending_commands: 0,
          unreconciled_receipts: 0,
        });
      } else {
        assert.ok(
          model.terminalGenerations.has(generation),
          `old generation ${generation} was not explicitly revoked`,
        );
        assert.ok(
          Object.values(resources).every((count) => count === 0),
          `terminated generation ${generation} leaked resources`,
        );
      }
    }
    assert.deepEqual(model.stableBusinessCounters, {
      calls: 1,
      cdrs: 1,
      billingSessions: 1,
      rootRecordingManifests: 1,
    });
  };
  type CommandToken = {
    tenantId: string;
    interactionId: string;
    bridgeId: string;
    generation: number;
    operation: string;
    idempotencyKey: string;
    keyId: string;
    signed: boolean;
    issuerPinned: boolean;
    expiresAt: number;
  };
  const tokenFor = (
    expectedRevision: number,
    operation: string,
    key: string,
    overrides: Partial<CommandToken> = {},
  ): CommandToken => ({
    ...scope,
    generation: expectedRevision + 1,
    operation,
    idempotencyKey: key,
    keyId: "signing-key-1",
    signed: true,
    issuerPinned: true,
    expiresAt: 2,
    ...overrides,
  });
  const applySwitch = (input: {
    key: string;
    hash: string;
    operation: string;
    expectedRevision: number;
    token: CommandToken;
    now: number;
    receiptDurable?: boolean;
  }): {
    result:
      | "winner"
      | "replay"
      | "conflict"
      | "cancelled"
      | "token_rejected"
      | "cas_loser";
    writerCreated: boolean;
    generation: number | null;
  } => {
    const existing = model.commandReceipts.get(input.key);
    if (existing) {
      return existing.hash === input.hash
        ? {
            result: "replay",
            writerCreated: false,
            generation: existing.generation,
          }
        : { result: "conflict", writerCreated: false, generation: null };
    }
    if (model.cancelTombstones.has(input.key)) {
      return { result: "cancelled", writerCreated: false, generation: null };
    }
    if (
      !input.token.signed ||
      !input.token.issuerPinned ||
      input.now >= input.token.expiresAt ||
      input.token.tenantId !== scope.tenantId ||
      input.token.interactionId !== scope.interactionId ||
      input.token.bridgeId !== scope.bridgeId ||
      input.token.generation !== input.expectedRevision + 1 ||
      input.token.operation !== input.operation ||
      input.token.idempotencyKey !== input.key
    ) {
      return {
        result: "token_rejected",
        writerCreated: false,
        generation: null,
      };
    }
    if (input.expectedRevision !== model.headRevision) {
      return { result: "cas_loser", writerCreated: false, generation: null };
    }
    if (model.activeGeneration !== null) {
      revokeGeneration(model.activeGeneration);
    }
    const generation = ++model.nextGeneration;
    model.headRevision += 1;
    model.activeGeneration = generation;
    model.generationResources.set(generation, {
      participants: 1,
      port_pairs: 1,
      backend_allocations: 1,
      writers: 1,
      pending_commands: input.receiptDurable === false ? 1 : 0,
      unreconciled_receipts: input.receiptDurable === false ? 1 : 0,
    });
    generations.push(generation);
    if (input.receiptDurable !== false) {
      model.commandReceipts.set(input.key, {
        hash: input.hash,
        result: "winner",
        generation,
      });
    }
    return { result: "winner", writerCreated: true, generation };
  };
  const cancel = (key: string, generation: number): void => {
    model.cancelTombstones.add(key);
    if (model.activeGeneration === generation) {
      revokeGeneration(generation);
    }
  };
  const cleanup = (): void => {
    if (model.activeGeneration !== null) {
      revokeGeneration(model.activeGeneration);
    }
  };
  const webhook = (input: {
    id: string;
    hash: string;
    sequence: number;
    generation: number;
    signed: boolean;
    providerId: string;
    tenantId: string;
    interactionId: string;
    bridgeId: string;
    receiptDigest: string;
  }): "applied" | "replay" | "conflict" | "reordered" | "rejected" => {
    if (
      !input.signed ||
      input.providerId !== "livekit" ||
      input.tenantId !== scope.tenantId ||
      input.interactionId !== scope.interactionId ||
      input.bridgeId !== scope.bridgeId ||
      input.receiptDigest !== `receipt:${input.generation}` ||
      model.terminalGenerations.has(input.generation) ||
      input.generation !== model.activeGeneration
    ) {
      return "rejected";
    }
    const existing = model.webhookReceipts.get(input.id);
    if (existing) {
      return existing.hash === input.hash ? "replay" : "conflict";
    }
    if (input.sequence <= model.lastWebhookSequence) return "reordered";
    model.webhookReceipts.set(input.id, {
      hash: input.hash,
      sequence: input.sequence,
      generation: input.generation,
    });
    model.lastWebhookSequence = input.sequence;
    model.webhookEffects += 1;
    return "applied";
  };

  for (let round = 0; round < roundTrips; round += 1) {
    for (const path of paths) {
      const expectedRevision = model.headRevision;
      const key = `round:${round}:${path}`;
      const outcome = applySwitch({
        key,
        hash: `hash:${round}:${path}`,
        operation: path,
        expectedRevision,
        token: tokenFor(expectedRevision, path, key),
        now: 1,
      });
      assert.equal(outcome.result, "winner");
      assertGenerationIsolation();
    }
  }
  assert.deepEqual(
    generations,
    Array.from({ length: roundTrips * paths.length }, (_, index) => index + 1),
  );

  const concurrentRevision = model.headRevision;
  const concurrentGeneration = concurrentRevision + 1;
  const concurrent = [
    applySwitch({
      key: "cas:a",
      hash: "cas:a",
      operation: "commit",
      expectedRevision: concurrentRevision,
      token: tokenFor(concurrentRevision, "commit", "cas:a", {
        generation: concurrentGeneration,
      }),
      now: 1,
    }),
    applySwitch({
      key: "cas:b",
      hash: "cas:b",
      operation: "commit",
      expectedRevision: concurrentRevision,
      token: tokenFor(concurrentRevision, "commit", "cas:b", {
        generation: concurrentGeneration,
      }),
      now: 1,
    }),
  ];
  assert.equal(
    concurrent.filter((result) => result.result === "winner").length,
    1,
  );
  assert.ok(
    concurrent
      .filter((result) => result.result === "cas_loser")
      .every((result) => result.writerCreated === false),
  );
  assertGenerationIsolation();

  const beforeCancelRevision = model.headRevision;
  cancel("cancel-before", beforeCancelRevision + 1);
  assert.deepEqual(
    applySwitch({
      key: "cancel-before",
      hash: "cancel-before",
      operation: "prepare",
      expectedRevision: beforeCancelRevision,
      token: tokenFor(beforeCancelRevision, "prepare", "cancel-before"),
      now: 1,
    }),
    { result: "cancelled", writerCreated: false, generation: null },
  );
  const afterApplyRevision = model.headRevision;
  const afterApply = applySwitch({
    key: "cancel-after",
    hash: "cancel-after",
    operation: "commit",
    expectedRevision: afterApplyRevision,
    token: tokenFor(afterApplyRevision, "commit", "cancel-after"),
    now: 1,
    receiptDurable: false,
  });
  assert.equal(afterApply.result, "winner");
  cancel("cancel-after", Number(afterApply.generation));
  assert.equal(
    applySwitch({
      key: "cancel-after",
      hash: "cancel-after",
      operation: "commit",
      expectedRevision: model.headRevision,
      token: tokenFor(model.headRevision, "commit", "cancel-after"),
      now: 1,
    }).result,
    "cancelled",
  );
  assertGenerationIsolation();

  const expiredRevision = model.headRevision;
  assert.equal(
    applySwitch({
      key: "expired-before",
      hash: "expired-before",
      operation: "prepare",
      expectedRevision: expiredRevision,
      token: tokenFor(expiredRevision, "prepare", "expired-before", {
        expiresAt: 2,
      }),
      now: 2,
    }).result,
    "token_rejected",
  );
  assert.equal(
    applySwitch({
      key: "cross-tenant",
      hash: "cross-tenant",
      operation: "prepare",
      expectedRevision: expiredRevision,
      token: tokenFor(expiredRevision, "prepare", "cross-tenant", {
        tenantId: "tenant-b",
      }),
      now: 1,
    }).result,
    "token_rejected",
  );
  assert.equal(
    applySwitch({
      key: "wrong-operation",
      hash: "wrong-operation",
      operation: "commit",
      expectedRevision: expiredRevision,
      token: tokenFor(expiredRevision, "prepare", "wrong-operation"),
      now: 1,
    }).result,
    "token_rejected",
  );
  const activeRevision = model.headRevision;
  const active = applySwitch({
    key: "active-token",
    hash: "active-token",
    operation: "commit",
    expectedRevision: activeRevision,
    token: tokenFor(activeRevision, "commit", "active-token"),
    now: 1,
  });
  assert.equal(active.result, "winner");
  const activeGeneration = Number(active.generation);
  assert.equal(
    applySwitch({
      key: "expired-during-active",
      hash: "expired-during-active",
      operation: "commit",
      expectedRevision: model.headRevision,
      token: tokenFor(model.headRevision, "commit", "expired-during-active", {
        expiresAt: 2,
      }),
      now: 2,
    }).result,
    "token_rejected",
  );
  assert.equal(model.activeGeneration, activeGeneration);
  assert.equal(model.generationResources.get(activeGeneration)?.writers, 1);
  assertGenerationIsolation();

  const acceptedWebhook = {
    id: "event:2",
    hash: "payload:2",
    sequence: 2,
    generation: activeGeneration,
    signed: true,
    providerId: "livekit",
    tenantId: scope.tenantId,
    interactionId: scope.interactionId,
    bridgeId: scope.bridgeId,
    receiptDigest: `receipt:${activeGeneration}`,
  };
  assert.equal(webhook(acceptedWebhook), "applied");
  assert.equal(webhook(acceptedWebhook), "replay");
  assert.equal(
    webhook({ ...acceptedWebhook, hash: "payload:conflict" }),
    "conflict",
  );
  assert.equal(
    webhook({
      ...acceptedWebhook,
      id: "event:1",
      hash: "payload:1",
      sequence: 1,
    }),
    "reordered",
  );
  assert.equal(
    webhook({
      ...acceptedWebhook,
      id: "event:forged",
      sequence: 3,
      signed: false,
    }),
    "rejected",
  );
  assert.equal(
    webhook({
      ...acceptedWebhook,
      id: "event:wrong-provider",
      sequence: 3,
      providerId: "forged-provider",
    }),
    "rejected",
  );
  assert.equal(
    webhook({
      ...acceptedWebhook,
      id: "event:wrong-tenant",
      sequence: 3,
      tenantId: "tenant-b",
    }),
    "rejected",
  );
  assert.equal(model.webhookEffects, 1);

  cleanup();
  cleanup();
  assert.ok(
    [...model.generationResources.values()].every((resources) =>
      Object.values(resources).every((count) => count === 0),
    ),
  );
  assertGenerationIsolation();
  assert.equal(webhook(acceptedWebhook), "rejected");
});

test("Revision 4 binds quality methods thresholds and evidence without claiming a pass", () => {
  const quality = contract().quality;
  const methods = quality.measurement_methods as JsonObject[];
  assert.deepEqual(
    methods.map((method) => method.metric_id),
    quality.metrics,
  );
  assertUniqueSemanticKeys(methods, "metric_id", "quality.measurement_methods");
  for (const method of methods) {
    assert.equal(typeof method.method_id, "string");
    assert.equal(typeof method.unit, "string");
    assert.equal(method.method_source, null);
    assert.equal(method.method_digest, null);
    assert.equal(method.verification_status, "not_run");
  }
  assert.deepEqual(quality.profile_identity_fields, [
    "quality_profile_id",
    "quality_profile_revision",
    "codec_pair",
    "ptime_ms",
    "security_mode",
    "transcode_count",
    "network_impairment_profile_id",
    "hardware_profile_id",
    "backend_source_digest",
    "binary_digest",
    "config_digest",
  ]);
  assert.deepEqual(quality.workload_contract, {
    identity_fields: [
      "workload_profile_id",
      "workload_profile_revision",
      "call_mix_digest",
      "impairment_schedule_digest",
      "duration_seconds",
      "concurrency",
      "cps",
    ],
    workload_source: null,
    workload_digest: null,
    current_profile: null,
    missing_identity_policy: "not_run_and_ineligible",
    verification_status: "not_run",
  });
  assert.deepEqual(quality.threshold_contract, {
    binding_fields: [
      "metric_id",
      "method_id",
      "quality_profile_id",
      "operator",
      "threshold_value",
      "unit",
    ],
    threshold_source: null,
    threshold_digest: null,
    threshold_signature_status: "not_run",
    required_for_each_metric: true,
    current_bindings: [],
    missing_binding_policy: "not_run_and_ineligible",
    unsigned_threshold_policy: "not_run_and_ineligible",
    verification_status: "not_run",
  });
  assert.deepEqual(quality.evidence_identity_fields, [
    "run_id",
    "scenario_id",
    "quality_profile_digest",
    "threshold_digest",
    "source_commit",
    "binary_digest",
    "config_digest",
    "hardware_identity",
    "started_at",
    "ended_at",
    "witness_id",
    "evidence_sha256",
  ]);
  assert.equal(quality.verification_status, "not_run");
  assert.equal(quality.production_eligible, false);
});

test("Revision 4 keeps RTPengine userspace and kernel evidence independent", () => {
  const lifecycle = contract().rtpengine_atomic_lifecycle;
  assert.equal("userspace_result_status" in lifecycle, false);
  assert.equal("kernel_result_status" in lifecycle, false);
  const profiles = lifecycle.execution_profiles as JsonObject[];
  assert.deepEqual(
    profiles.map((profile) => profile.profile_id),
    ["userspace", "kernel"],
  );
  assertUniqueSemanticKeys(
    profiles,
    "profile_id",
    "rtpengine_atomic_lifecycle.execution_profiles",
  );
  for (const profile of profiles) {
    assert.deepEqual(profile.identity, {
      source_digest: {
        algorithm: "sha256",
        value: null,
        verification_status: "not_run",
      },
      binary_digest: {
        algorithm: "sha256",
        value: null,
        verification_status: "not_run",
      },
      config_digest: {
        algorithm: "sha256",
        value: null,
        verification_status: "not_run",
      },
      capability_set_digest: {
        algorithm: "sha256",
        value: null,
        verification_status: "not_run",
      },
    });
    assert.deepEqual(profile.hardware_identity, {
      hardware_profile_id: null,
      nic_driver_digest: null,
      kernel_module_digest: null,
      cell_id: null,
      verification_status: "not_run",
    });
    assert.equal(profile.result_status, "not_run");
    assert.equal(profile.results_inheritable, false);
    assert.equal(profile.production_eligible, false);
  }
  assert.equal(profiles[0].execution_mode, "userspace");
  assert.deepEqual(profiles[0].required_evidence, [
    "userspace_packet_path",
    "userspace_source_binary_config_capability_identity",
    "userspace_hardware_identity",
  ]);
  assert.equal(profiles[1].execution_mode, "kernel");
  assert.deepEqual(profiles[1].required_evidence, [
    "kernel_packet_path",
    "kernel_source_binary_config_capability_identity",
    "kernel_module_nic_and_hardware_identity",
  ]);
});
