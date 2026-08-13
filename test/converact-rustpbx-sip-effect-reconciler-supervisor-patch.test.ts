import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-sip-effect-reconciler-supervisor.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence-index-v1.json";

function additions(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("reconciler patch consumes only bounded exact-target authority grants", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const bytes = readFileSync(PATCH);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "d44e26c6346634dff00cc014f5c3ae5f5ef33a762268f25482e9a0b70176fa75",
  );
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(parsed.stdout.trim().split("\n"), [
    "54\t0\tsrc/call/adapters/mod.rs",
    "318\t25\tsrc/call/adapters/postgres_sip_effect.rs",
    "1887\t0\tsrc/call/adapters/sip_effect_reconciler_supervisor.rs",
    "60\t5\tsrc/call/domain/sip_effect.rs",
  ]);

  const source = additions(bytes.toString("utf8"));
  assert.match(source, /struct SipEffectRepairTarget/);
  assert.match(source, /struct SipEffectRepairGrantSpec/);
  assert.match(source, /pub\(crate\) struct SipEffectRepairGrant/);
  assert.match(source, /pub\(crate\) mod sip_effect_reconciler_supervisor/);
  assert.doesNotMatch(source, /pub struct SipEffectRepairGrantSpec/);
  assert.doesNotMatch(source, /pub struct SipEffectRepairTarget/);
  assert.doesNotMatch(source, /pub\(crate\) struct SipEffectRepairGrantSpec\s*\{/);
  assert.doesNotMatch(source, /pub\(crate\) struct SipEffectRepairTarget\s*\{/);
  assert.match(source, /cfg\(sip_effect_reconciler_privacy_ui\)/);
  assert.match(source, /cfg\(sip_effect_reconciler_privacy_direct_ui\)/);
  assert.match(source, /mod sibling_spec_probe/);
  assert.match(source, /fn cannot_mint_a_repair_grant/);
  assert.match(source, /mod sibling_direct_grant_probe/);
  assert.match(source, /fn cannot_construct_a_repair_grant_directly/);
  const grantImplStart = source.indexOf("impl SipEffectRepairGrant {");
  const grantImplEnd = source.indexOf("\n}\n\nfn is_sha256_lower_hex", grantImplStart);
  assert.notEqual(grantImplStart, -1);
  assert.notEqual(grantImplEnd, -1);
  assert.deepEqual(
    [
      ...source
        .slice(grantImplStart, grantImplEnd)
        .matchAll(/pub\(crate\) fn ([a-z_]+)/gu),
    ].map((match) => match[1]),
    [
      "grant_id",
      "tenant_id",
      "protocol_session_id",
      "protocol_session_generation",
      "repair_owner_id",
      "repair_owner_epoch",
    ],
  );
  assert.match(source, /expected_revision: u64/);
  assert.match(source, /expected_effect_identity_hash: String/);
  assert.match(source, /spec\.targets\.is_empty\(\)/);
  assert.match(source, /spec\.targets\.len\(\) > MAX_RECONCILER_BATCH_SIZE/);
  assert.match(source, /previous >= target\.protocol_effect_id\.as_str\(\)/);
  assert.match(source, /WITH ORDINALITY/);
  assert.match(source, /ORDER BY target\.target_ordinality/);
  assert.match(source, /FOR UPDATE OF effect SKIP LOCKED/);
  assert.match(source, /due_rows\.len\(\) != targets\.len\(\)/);
  assert.match(source, /pub struct SipEffectExactRepairBatch/);
  assert.match(source, /exhausted_effect_ids: Vec<String>/);
  assert.match(source, /GrantFailure::Superseded/);
  assert.match(source, /SipEffectError::FenceLost \| SipEffectError::Terminal/);
  assert.match(source, /REPAIR_LEASE_SAFETY_MARGIN/);
  assert.match(source, /LeaseWindowTooShort/);
  assert.match(source, /expires_at: Instant/);
  assert.match(source, /freeze_execution_lease/);
  assert.match(source, /MAX_RECONCILER_GRANT_TIMEOUT: Duration = Duration::from_secs\(29\)/);
  assert.match(source, /store_panic_cancels_the_entire_reconciler_child/);
  assert.match(source, /oracle_panic_cancels_the_entire_reconciler_child/);
  assert.match(source, /assert!\(!parent_cancel\.is_cancelled\(\)\)/);
  assert.match(source, /cancel\.cancel\(\)/);
  assert.doesNotMatch(source, /one_panicked_worker_does_not_stop_an_independent_fixed_worker/);
  assert.match(source, /claim_unknown_validates_the_full_repair_fence_token_boundary/);
  assert.match(source, /fence\.validate\(\)\?/);
  assert.match(source, /mid_batch_transient_preserves_prior_reconcile_and_claim_exhaustion_progress/);
  assert.match(source, /mid_batch_cancellation_preserves_prior_reconcile_progress/);
  assert.match(source, /submit_after_parent_cancellation_is_stopped_without_queue_metric_churn/);
  assert.match(source, /sub_millisecond_dwell_freezes_one_whole_millisecond_execution_lease/);
  assert.match(
    source,
    /exact_result_rejects_a_duplicate_exhausted_id_instead_of_trusting_its_count/,
  );
  assert.doesNotMatch(source, /claim_unknown_batch_for_session/);
  assert.doesNotMatch(source, /unbounded_channel|tokio::spawn\(/);
});

test("ivekit.72 applies and formats the reconciler after observer supervision", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.75"/u);
  assert.match(
    build,
    /rustpbx-converact-sip-effect-observer-supervisor\.patch"[\s\S]*rustpbx-converact-sip-effect-reconciler-supervisor\.patch"/u,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-sip-effect-reconciler-supervisor\.patch/u,
  );
  assert.match(
    build,
    /cargo rustc --locked --lib --features cross --[\s\S]*--cfg sip_effect_reconciler_privacy_ui[\s\S]*E0603/u,
  );
  assert.match(
    build,
    /cargo rustc --locked --lib --features cross --[\s\S]*--cfg sip_effect_reconciler_privacy_direct_ui[\s\S]*E0451/u,
  );
});

test("reconciler remains default-disabled behind unproved issuer and completion gates", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    production_eligible: boolean;
    entries: Array<{ evidence_id: string; status: string }>;
  };
  assert.match(readme, /ivekit\.72 adds the separately default-disabled/u);
  assert.match(readme, /authoritative grant issuer[\s\S]*remain `not_run`/u);
  assert.equal(evidence.production_eligible, false);
  for (const evidenceId of [
    "G03-E10-FAULT",
    "G03-E13-PERFORMANCE",
    "G03-E15-REVIEW",
    "G03-E16-NATIVE-AUTHORITY",
  ]) {
    assert.equal(
      evidence.entries.find((entry) => entry.evidence_id === evidenceId)?.status,
      "not_run",
      evidenceId,
    );
  }
});
