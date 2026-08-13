import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-call-capability-recovery.patch";
const PATCH_SHA256 =
  "bfe2443d58df7770720dec9197dd0f3f54f84be26d4a9589dd2e7f8bdafe80e9";
const BUILD = "infra/converact/rustpbx/build.sh";
const CONTRACT =
  "architecture-foundation/execution/goal-03/sip-foundation-contract-v1.json";
const EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence-index-v1.json";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.76 applies recovery after cleanup fencing", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  assert.equal(
    createHash("sha256").update(readFileSync(PATCH)).digest("hex"),
    PATCH_SHA256,
  );
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(
    parsed.stdout,
    [
      "566\t6\tsrc/call/adapters/native_sip_effect_capabilities.rs",
      "59\t0\tsrc/proxy/active_call_registry.rs",
      "",
    ].join("\n"),
  );

  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.77"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-cleanup-fence\.patch"[\s\S]*rustpbx-converact-native-call-capability-recovery\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-capability-recovery\.patch/,
  );
});

test("recovery rebuilds only after a fenced no-visible-effect decision", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /trait NativeSipCapabilityRecoveryOracle/);
  assert.match(source, /struct NativeSipRecoveryProbeRequest/);
  assert.match(source, /enum NativeSipRecoveryProbeOutcome/);
  assert.match(source, /NoVisibleEffect/);
  assert.match(source, /VisibleOrAmbiguous/);
  assert.match(source, /recovery_oracle: None/);
  assert.match(source, /NativeCallIdentity::recover_from_binding/);
  assert.match(source, /canonical_json_sha256/);
  assert.match(source, /fence_predecessor_and_probe\(request\)\.await/);
  assert.match(source, /RecoveryReconciliationRequired/);
  assert.match(source, /is_sha256_lower_hex/);
  assert.match(source, /active_calls\.get_identity\(provider_call_id\)/);
  assert.match(source, /reserve_matched_cancel_capabilities_for_identity/);
  assert.match(source, /reserve_ordinary_response_capability_for_identity/);
  assert.match(source, /fn validate_bound_identity/);
  assert.match(
    source,
    /recovered_unconsumed_call_fences_predecessor_before_rebuilding_capabilities/,
  );
  assert.match(
    source,
    /visible_or_ambiguous_predecessor_effect_blocks_rebuild_without_mutation/,
  );
  assert.match(
    source,
    /successor_replacement_during_probe_cannot_receive_stale_capabilities/,
  );
  assert.match(
    source,
    /recovered_gate_cannot_mutate_a_later_same_provider_successor/,
  );
  assert.doesNotMatch(source, /unbounded_channel|std::thread::spawn/);
  assert.doesNotMatch(source, /PostgresSipEffectCapabilityRecoveryOracle/);
});

test("recovery remains component-only while durable and live gates are not_run", () => {
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
    source_identity: { patchset: string };
    native_matched_cancel_effects: {
      capability_restart_rebuild: string;
      activation_blockers: string[];
      live_server_activation: string;
      performance_verification: string;
    };
    native_call_capability_recovery: {
      implementation_status: string;
      oracle_contract: string;
      probe_outcomes: string[];
      visible_or_ambiguous_outcome: string;
      installed_gate_identity_fence: string;
      later_same_provider_successor_outcome: string;
      durable_postgresql_oracle: string;
      live_recovery_wiring: string;
      local_functional_verification: Record<string, string>;
      server_functional_verification: Record<string, string>;
      performance_verification: string;
      performance_policy: string;
      activation_blockers: string[];
    };
  };
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };

  assert.equal(contract.source_identity.patchset, "ivekit.77");
  assert.equal(
    contract.native_matched_cancel_effects.capability_restart_rebuild,
    "durable_PostgreSQL_oracle_component_implemented_default_disabled_live_wiring_not_run",
  );
  assert.equal(
    contract.native_call_capability_recovery.implementation_status,
    "component_implemented_default_disabled",
  );
  assert.equal(
    contract.native_call_capability_recovery.oracle_contract,
    "atomically_fence_predecessor_owner_generation_then_prove_NoVisibleEffect",
  );
  assert.deepEqual(contract.native_call_capability_recovery.probe_outcomes, [
    "NoVisibleEffect",
    "VisibleOrAmbiguous",
  ]);
  assert.equal(
    contract.native_call_capability_recovery.visible_or_ambiguous_outcome,
    "fail_closed_RecoveryReconciliationRequired_no_registry_or_intent_mutation",
  );
  assert.equal(
    contract.native_call_capability_recovery.installed_gate_identity_fence,
    "exact_NativeCallIdentity_checked_before_every_prepare_path_and_after_async_durable_prepare",
  );
  assert.equal(
    contract.native_call_capability_recovery.later_same_provider_successor_outcome,
    "fail_closed_no_successor_mutation_no_new_effect",
  );
  assert.equal(
    contract.native_call_capability_recovery.durable_postgresql_oracle,
    "component_implemented_exact_key_session_fenced_physical_SQL_verified_Rust_adapter_physical_tests_not_run",
  );
  assert.equal(contract.native_call_capability_recovery.live_recovery_wiring, "not_run");
  assert.equal(
    contract.native_call_capability_recovery.local_functional_verification
      .native_sip_effect_capabilities,
    "121_sip_effect_tests_passed_0_failed_10_physical_tests_ignored",
  );
  assert.deepEqual(
    contract.native_call_capability_recovery.server_functional_verification,
    {
      status:
        "isolated_postgresql_migration_and_contract_passed_Rust_adapter_physical_tests_not_run",
      campaign_id: "converact-g03-77-204f4d5-physical",
      base_source_commit: "204f4d562299",
      candidate_patchset: "ivekit.77",
      evidence_uri:
        "architecture-foundation/execution/goal-03/evidence/raw/capability-recovery-oracle-204f4d5-17/README.md",
      migration_chain: "through_116_passed_isolated_PostgreSQL_16",
      physical_contract:
        "session_fence_exact_two_key_probe_receipt_replay_stale_insert_and_prepared_send_attempt_rejection_and_tenant_RLS_passed",
      rust_adapter_physical_tests: "not_run",
      server_rust_compile: "not_run_safe_disk_and_memory_floor",
      existing_service_state: "unchanged_running_healthy",
      test_container_and_tmpfs_after_cleanup: "absent",
    },
  );
  assert.equal(contract.native_call_capability_recovery.performance_verification, "not_run");
  assert.equal(
    contract.native_call_capability_recovery.performance_policy,
    "deferred_to_final_performance_goal",
  );
  assert.deepEqual(contract.native_call_capability_recovery.activation_blockers, [
    "recovered_capability_live_wiring_not_implemented",
    "Rust_adapter_physical_PostgreSQL_ignored_tests_not_run",
    "real_process_restart_and_ambiguity_recovery_not_run",
    "live_endpoint_activation_not_run",
  ]);
  assert.equal(contract.native_matched_cancel_effects.live_server_activation, "not_run");
  assert.equal(contract.native_matched_cancel_effects.performance_verification, "not_run");
  assert.equal(
    evidence.entries.find(
      (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
    )?.status,
    "not_run",
  );
});
