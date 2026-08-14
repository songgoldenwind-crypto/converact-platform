import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-response-capabilities.patch";
const PATCH_SHA256 =
  "3e21ff23a913a75f0d5ab3c7f1517b5c6cbefc93ccbff41a69a5d80307def5b6";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
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

test("ivekit.74 applies the Native Call response capability after matched CANCEL", () => {
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
      "1062\t8\tsrc/call/adapters/native_sip_effect_capabilities.rs",
      "19\t3\tsrc/call/adapters/rsipstack_sip_effect_gate.rs",
      "85\t2\tsrc/call/domain/native_call.rs",
      "243\t0\tsrc/proxy/active_call_registry.rs",
      "",
    ].join("\n"),
  );

  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.79"/);
  assert.match(
    build,
    /rustpbx-converact-native-matched-cancel-capabilities\.patch"[\s\S]*rustpbx-converact-native-response-capabilities\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-response-capabilities\.patch/,
  );
});

test("ordinary responses consume exact one-shot Call authority before durable send", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /struct NativeCallEgressGate/);
  assert.match(source, /struct NativeResponseTransactionBinding/);
  assert.match(source, /reserve_ordinary_response_capability/);
  assert.match(source, /ordinary_response_intent/);
  assert.match(source, /arm_for_durable_prepare/);
  assert.match(source, /prepare_registered/);
  assert.match(source, /commit_after_durable_prepare/);
  assert.match(source, /EgressEffectOutcome::TransportUnknown/);
  assert.match(
    source,
    /reserve_exact_Call_capability|Native Call gate installs/,
  );
  assert.match(
    source,
    /installed_call_gate_authorizes_provisional_and_final_responses_in_order/,
  );
  assert.match(
    source,
    /installed_call_gate_rejects_response_dialog_identity_drift_before_store/,
  );
  assert.match(
    source,
    /cancelled_durable_response_prepare_retains_exact_binding_for_reconcile/,
  );
  assert.match(
    source,
    /concurrent_call_revision_after_durable_prepare_marks_response_unknown/,
  );
  assert.match(
    source,
    /inbound_invite_accepts_multiple_provisional_responses_before_one_final/,
  );
  assert.match(
    source,
    /outbound_invite_accepts_multiple_provisional_responses_before_one_final/,
  );
  assert.doesNotMatch(source, /with_egress_effect_gate|unbounded_channel/);
});

test("response lifecycle remains default-disabled and claims no server or performance result", () => {
  const readme = readFileSync(README, "utf8");
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
    native_matched_cancel_effects: { activation_blockers: string[] };
    native_ordinary_response_effects: {
      authority: string;
      implementation_status: string;
      response_classes: Record<string, string | string[]>;
      authority_order: string;
      frozen_dialog_identity: string[];
      dialog_identity_drift: string;
      durable_prepare_cancellation_or_panic: string;
      call_revision_race_after_durable_prepare: string;
      local_functional_verification: Record<string, string>;
      live_server_activation: string;
      server_functional_verification: Record<string, string>;
      performance_verification: string;
      performance_policy: string;
    };
  };
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const responses = contract.native_ordinary_response_effects;

  assert.match(readme, /ivekit\.74/);
  assert.match(readme, /default-disabled/i);
  assert.equal(responses.authority, "Unified_RustPBX_Native_Call_registry");
  assert.equal(
    responses.implementation_status,
    "component_implemented_default_disabled",
  );
  assert.deepEqual(responses.response_classes, {
    provisional: "101_through_199",
    final_2xx: "200_through_299",
    final_non_2xx: "300_through_699",
    excluded: ["100", "700_through_999"],
  });
  assert.equal(
    responses.authority_order,
    "reserve_exact_Call_capability_then_register_exact_intent_then_durable_prepare_then_commit_Call_state_then_transport_send",
  );
  assert.deepEqual(responses.frozen_dialog_identity, [
    "SIP_Call_ID",
    "INVITE_CSeq_sequence_and_method",
    "From",
    "top_Via",
    "To_without_tag",
    "authority_generated_stable_local_To_tag",
  ]);
  assert.equal(
    responses.dialog_identity_drift,
    "reject_before_durable_store_work",
  );
  assert.equal(
    responses.durable_prepare_cancellation_or_panic,
    "retain_exact_binding_for_query_reconcile",
  );
  assert.equal(
    responses.call_revision_race_after_durable_prepare,
    "record_TransportUnknown_and_require_query_reconcile",
  );
  assert.deepEqual(responses.local_functional_verification, {
    native_response_capabilities: "19_passed_0_failed",
    native_call_domain: "13_passed_0_failed",
    active_call_registry: "24_passed_0_failed",
    durable_sip_effect_gate:
      "135_sip_effect_tests_passed_0_failed_11_physical_tests_ignored",
    rustfmt_changed_sources: "passed",
    locked_library_check: "passed",
    full_rustpbx_library: "2109_passed_0_failed_12_external_prerequisites_ignored",
  });
  assert.equal(responses.live_server_activation, "not_run");
  assert.equal(
    responses.server_functional_verification.status,
    "local_Rust_composition_and_isolated_PostgreSQL_adapter_passed_existing_service_unchanged",
  );
  assert.equal(
    responses.server_functional_verification.evidence_uri,
    "architecture-foundation/execution/goal-03/evidence/raw/durable-sip-runtime-composition-2ecfb72-18/README.md",
  );
  assert.equal(
    responses.server_functional_verification.existing_service_state,
    "unchanged_running_healthy",
  );
  assert.equal(responses.performance_verification, "not_run");
  assert.equal(
    responses.performance_policy,
    "deferred_to_final_performance_goal",
  );
  assert.equal(
    contract.native_matched_cancel_effects.activation_blockers.includes(
      "ordinary_provisional_and_final_response_intents_not_issued",
    ),
    false,
  );
  for (const evidenceId of [
    "G03-E13-PERFORMANCE",
    "G03-E16-NATIVE-AUTHORITY",
  ]) {
    assert.equal(
      evidence.entries.find((entry) => entry.evidence_id === evidenceId)
        ?.status,
      "not_run",
    );
  }
});
