import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const RSIPSTACK_PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-transaction-local-matched-cancel-pair.patch";
const RUSTPBX_PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-matched-cancel-capabilities.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence-index-v1.json";
const CONTRACT =
  "architecture-foundation/execution/goal-03/sip-foundation-contract-v1.json";

const SHA256 = new Map([
  [RSIPSTACK_PATCH, "6175c959d7dde6172efa097bdd98e708c589eceb1273db77a86a3a714102e7f4"],
  [
    RUSTPBX_PATCH,
    "61d4b66d1a6ebe92d7f451449d461d2f6b9e2c20a6dc5d67e4c982a41d36a15a",
  ],
]);

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.74 retains the matched-CANCEL pair before response capabilities", () => {
  for (const patch of [RSIPSTACK_PATCH, RUSTPBX_PATCH]) {
    assert.equal(existsSync(patch), true, `${patch} is required`);
    assert.equal(
      createHash("sha256").update(readFileSync(patch)).digest("hex"),
      SHA256.get(patch),
    );
    const parsed = spawnSync("git", ["apply", "--numstat", patch], {
      encoding: "utf8",
    });
    assert.equal(parsed.status, 0, parsed.stderr);
  }

  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.77"/);
  assert.match(
    build,
    /rsipstack-converact-uas-2xx-owner-retention\.patch"[\s\S]*rsipstack-converact-transaction-local-matched-cancel-pair\.patch"/,
  );
  assert.match(
    build,
    /rustpbx-converact-sip-effect-reconciler-supervisor\.patch"[\s\S]*rustpbx-converact-native-matched-cancel-capabilities\.patch"[\s\S]*rustpbx-converact-native-response-capabilities\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-transaction-local-matched-cancel-pair\.patch/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-matched-cancel-capabilities\.patch/,
  );
  assert.match(
    build,
    /\$3 != "src\/proxy\/tests\/test_auth\.rs"/,
    "the one-line constructor update must not broaden formatting into unrelated upstream test drift",
  );
});

test("one matched pending-INVITE CANCEL authorizes distinct 200 and 487 effects", () => {
  const source = additions(readFileSync(RSIPSTACK_PATCH, "utf8"));
  assert.match(source, /ServerInviteRequestTerminated/);
  assert.match(source, /split_for_matched_cancel/);
  assert.match(source, /install_egress_effect_gate/);
  assert.match(source, /matched_cancel_authorizes_200_and_487_as_two_peer_derived_effects/);
  assert.match(source, /cancel_after_an_existing_final_does_not_authorize_a_second_final/);
  assert.match(source, /transaction_local_gate_installs_after_trying/);
  assert.match(source, /matched_cancel_final_reconciliation_required/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|DashMap/);
});

test("Native Call authority registers the bounded pair before local gate installation", () => {
  const source = additions(readFileSync(RUSTPBX_PATCH, "utf8"));
  assert.match(source, /struct NativeSipEffectRuntime/);
  assert.match(source, /reserve_matched_cancel_capabilities/);
  assert.match(source, /register_peer_derived\([\s\S]*ServerInviteCancelOk/);
  assert.match(source, /register_peer_derived\([\s\S]*ServerInviteRequestTerminated/);
  assert.match(source, /install_for_admitted_native_call/);
  assert.match(source, /native_sip_effect_runtime: None/);
  assert.match(source, /default_disabled_runtime_leaves_the_transaction_ungated/);
  assert.match(source, /gate_installation_conflict_revokes_capabilities_and_closes_the_call/);
  assert.match(source, /partial_intent_registration_revokes_the_pair_and_closes_the_call/);
  assert.match(source, /mismatched_install_cannot_close_an_unrelated_active_call/);
  assert.match(source, /PINNED_RSIPSTACK_SOURCE_COMMIT/);
  assert.match(source, /runtime_rejects_an_unpinned_or_noncanonical_source_commit/);
  assert.match(source, /COMPLETION_SCOPE_TRANSACTION_PEER/);
  assert.doesNotMatch(source, /with_egress_effect_gate|tokio::spawn\(|unbounded_channel/);
});

test("the functional slice does not claim server activation or performance evidence", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
    native_matched_cancel_effects: {
      activation_blockers: string[];
      adapter_source_identity: string;
      pre_reservation_authority_mismatch: string;
      post_reservation_registration_failure: string;
      successor_replacement_cleanup_fence: string;
      capability_restart_rebuild: string;
      format_scope_exception: string;
      invite_termination_precondition: string;
      late_cancel_after_existing_final: string;
      local_functional_verification: {
        capability_recovery_oracle: string;
        rsipstack_library: string;
        rustpbx_library: string;
        affected_static_contract_tests: string;
        repository_typecheck: string;
      };
      live_server_activation: string;
      server_functional_verification: {
        status: string;
        campaign_id: string;
        base_source_commit: string;
        candidate_patchset: string;
        evidence_uri: string;
        migration_chain: string;
        physical_contract: string;
        rust_adapter_physical_tests: string;
        server_rust_compile: string;
        existing_service_state: string;
        test_container_and_tmpfs_after_cleanup: string;
      };
      performance_verification: string;
    };
  };
  const matchedCancel = contract.native_matched_cancel_effects;
  assert.match(readme, /ivekit\.77/);
  assert.match(readme, /default-disabled/i);
  assert.match(readme, /live Endpoint activation[\s\S]*remain[s]?[\s\S]*`not_run`/i);
  assert.match(readme, /performance[^\n]*remain[^\n]*`not_run`/i);
  assert.deepEqual(matchedCancel.activation_blockers, [
    "recovered_capability_live_wiring_not_implemented",
    "Rust_adapter_physical_PostgreSQL_ignored_tests_not_run",
    "live_endpoint_activation_not_run",
    "rustpbx_isolated_server_functional_verification_not_run_under_safe_disk_and_memory_floor",
  ]);
  assert.equal(
    matchedCancel.adapter_source_identity,
    "exact_pinned_rsipstack_commit_only",
  );
  assert.equal(
    matchedCancel.pre_reservation_authority_mismatch,
    "reject_without_call_mutation",
  );
  assert.equal(
    matchedCancel.post_reservation_registration_failure,
    "remove_exact_original_Call_authority_only",
  );
  assert.equal(
    matchedCancel.successor_replacement_cleanup_fence,
    "implemented_identity_and_native_cell_pointer_fence",
  );
  assert.equal(
    matchedCancel.capability_restart_rebuild,
    "durable_PostgreSQL_oracle_component_implemented_default_disabled_live_wiring_not_run",
  );
  assert.equal(
    matchedCancel.format_scope_exception,
    "test_auth_constructor_compiled_and_full_tested_rustfmt_excluded_due_unrelated_upstream_drift",
  );
  assert.equal(
    matchedCancel.invite_termination_precondition,
    "server_INVITE_state_trying_or_proceeding",
  );
  assert.equal(
    matchedCancel.late_cancel_after_existing_final,
    "200_CANCEL_only_no_487_capability",
  );
  assert.deepEqual(matchedCancel.local_functional_verification, {
    capability_recovery_oracle:
      "121_sip_effect_tests_passed_0_failed_10_physical_tests_ignored",
    rsipstack_library: "314_passed_0_failed",
    rustpbx_library: "not_run_for_ivekit_77",
    affected_static_contract_tests:
      "targeted_contract_and_migration_suite_passed",
    repository_typecheck: "passed",
  });
  assert.equal(matchedCancel.live_server_activation, "not_run");
  assert.deepEqual(matchedCancel.server_functional_verification, {
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
  });
  assert.equal(matchedCancel.performance_verification, "not_run");
  assert.equal(
    evidence.entries.find((entry) => entry.evidence_id === "G03-E13-PERFORMANCE")
      ?.status,
    "not_run",
  );
  assert.equal(
    evidence.entries.find((entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY")
      ?.status,
    "not_run",
  );
});
