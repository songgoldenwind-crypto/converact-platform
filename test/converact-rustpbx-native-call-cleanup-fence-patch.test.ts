import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-call-cleanup-fence.patch";
const PATCH_SHA256 =
  "d37cd3f0799585084ff8c6230ab80a611cf6ace0b521fc839c5f043606e8844a";
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

test("ivekit.75 applies cleanup fencing after ordinary response authority", () => {
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
      "87\t16\tsrc/call/adapters/native_sip_effect_capabilities.rs",
      "72\t15\tsrc/proxy/active_call_registry.rs",
      "",
    ].join("\n"),
  );

  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.76"/);
  assert.match(
    build,
    /rustpbx-converact-native-response-capabilities\.patch"[\s\S]*rustpbx-converact-native-call-cleanup-fence\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-cleanup-fence\.patch/,
  );
});

test("failure teardown is fenced to the exact admitted Native Call", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /struct NativeCallCleanupFence/);
  assert.match(source, /identity: NativeCallIdentity/);
  assert.match(source, /cell: Arc<NativeCallCell>/);
  assert.match(source, /remove_if_native_authority/);
  assert.match(source, /fn remove_original\(self/);
  assert.match(source, /let cleanup_fence = reservation\.commit\(\)/);
  assert.match(source, /cleanup_fence\.remove_original/);
  assert.match(source, /Arc::ptr_eq/);
  assert.match(source, /remove_slot_if/);
  assert.match(source, /occupied\.remove\(\)/);
  assert.match(
    source,
    /stale_failure_cleanup_cannot_remove_a_reused_provider_call/,
  );
  assert.match(source, /exact_failure_cleanup_removes_every_owned_call_index/);
  assert.doesNotMatch(source, /active_calls\.remove\(provider_call_id\)/);
  assert.doesNotMatch(source, /cleanup_fence\.clone\(\)/);
  assert.doesNotMatch(
    source,
    /#\[derive\([^\]]*Clone[^\]]*\)\]\s*pub\(crate\) struct NativeCallCleanupFence/,
  );
  assert.doesNotMatch(
    source,
    /unbounded_channel|tokio::spawn|std::thread::spawn/,
  );
});

test("cleanup closure is functional-only and leaves activation claims not_run", () => {
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
    source_identity: { patchset: string };
    native_matched_cancel_effects: {
      successor_replacement_cleanup_fence: string;
      activation_blockers: string[];
    };
    native_ordinary_response_effects: {
      local_functional_verification: {
        native_response_capabilities: string;
      };
      activation_blockers: string[];
    };
    native_call_cleanup_fencing: {
      authority: string;
      implementation_status: string;
      fence_fields: string[];
      fence_issuance: string;
      fence_consumption: string;
      fence_cloning: string;
      stale_fence_outcome: string;
      exact_fence_outcome: string;
      slot_teardown_atomicity: string;
      global_lock_or_scan: string;
      local_functional_verification: Record<string, string>;
      server_functional_verification: string;
      performance_verification: string;
    };
  };
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };

  assert.equal(contract.source_identity.patchset, "ivekit.76");
  assert.equal(
    contract.native_matched_cancel_effects.successor_replacement_cleanup_fence,
    "implemented_identity_and_native_cell_pointer_fence",
  );
  assert.equal(
    contract.native_matched_cancel_effects.activation_blockers.includes(
      "concurrent_successor_call_cleanup_fencing_not_implemented",
    ),
    false,
  );
  assert.equal(
    contract.native_ordinary_response_effects.local_functional_verification
      .native_response_capabilities,
    "19_passed_0_failed",
  );
  assert.equal(
    contract.native_ordinary_response_effects.activation_blockers.includes(
      "concurrent_successor_call_cleanup_fencing_not_implemented",
    ),
    false,
  );
  assert.equal(
    contract.native_call_cleanup_fencing.authority,
    "Unified_RustPBX_Native_Call_registry",
  );
  assert.equal(
    contract.native_call_cleanup_fencing.implementation_status,
    "component_implemented_default_disabled",
  );
  assert.deepEqual(contract.native_call_cleanup_fencing.fence_fields, [
    "NativeCallIdentity",
    "NativeCallCell_pointer_identity",
  ]);
  assert.equal(
    contract.native_call_cleanup_fencing.fence_issuance,
    "exact_admitted_Call_reservation_only",
  );
  assert.equal(
    contract.native_call_cleanup_fencing.fence_consumption,
    "one_shot_by_value",
  );
  assert.equal(contract.native_call_cleanup_fencing.fence_cloning, "forbidden");
  assert.equal(
    contract.native_call_cleanup_fencing.stale_fence_outcome,
    "no_op_preserve_successor_Call_and_all_secondary_indexes",
  );
  assert.equal(
    contract.native_call_cleanup_fencing.exact_fence_outcome,
    "remove_original_Call_and_all_owned_secondary_indexes",
  );
  assert.equal(
    contract.native_call_cleanup_fencing.slot_teardown_atomicity,
    "hold_one_provider_slot_exclusively_through_secondary_index_cleanup",
  );
  assert.equal(
    contract.native_call_cleanup_fencing.global_lock_or_scan,
    "none",
  );
  assert.deepEqual(
    contract.native_call_cleanup_fencing.local_functional_verification,
    {
      native_sip_effect_capabilities: "25_passed_0_failed",
      active_call_registry: "24_passed_0_failed",
      rustfmt_changed_sources: "passed",
      locked_library_check: "passed",
      full_rustpbx_library:
        "2082_passed_0_failed_9_external_prerequisites_ignored",
    },
  );
  assert.match(
    contract.native_call_cleanup_fencing.server_functional_verification,
    /^not_run_/,
  );
  assert.equal(
    contract.native_call_cleanup_fencing.performance_verification,
    "not_run",
  );
  for (const evidenceId of [
    "G03-E13-PERFORMANCE",
    "G03-E15-REVIEW",
    "G03-E16-NATIVE-AUTHORITY",
  ]) {
    assert.equal(
      evidence.entries.find((entry) => entry.evidence_id === evidenceId)
        ?.status,
      "not_run",
    );
  }
});
