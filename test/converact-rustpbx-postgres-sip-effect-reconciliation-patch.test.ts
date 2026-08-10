import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-postgres-sip-effect-reconciliation.patch";
const TRANSITIONS =
  "infra/converact/rustpbx/patches/rustpbx-converact-postgres-sip-effect-transitions.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence-index-v1.json";
const PHYSICAL_EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence/raw/native-postgres-reconciliation-fe519f1-02";

function additions(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("unknown repair claim is bounded by lease, epoch and attempt fences", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /const MAX_REPAIR_LEASE: Duration = Duration::from_secs\(30\)/);
  assert.match(source, /const CLAIM_UNKNOWN_SQL: &str = concat!/);
  assert.match(source, /pub async fn claim_unknown\(/);
  assert.match(source, /repair_due_at <= statement_timestamp\(\)/);
  assert.match(source, /repair_lease_until <= statement_timestamp\(\)/);
  assert.match(source, /repair_epoch_high_watermark < \$11::numeric/);
  assert.match(source, /repair_attempts < 8/);
  assert.match(source, /repair_claim_revision = revision \+ 1/);
  assert.doesNotMatch(
    source,
    /(updated_at|repair_due_at|repair_lease_until)\s*(?:=|<=)[^\n]*clock_timestamp\(\)|tokio::spawn\(|unbounded_channel/,
  );
});

test("reconcile rechecks the exact claim before atomic receipt application", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  const transitionSource = additions(readFileSync(TRANSITIONS, "utf8"));
  assert.match(source, /pub async fn reconcile\(/);
  assert.match(source, /let record = self\s*\.query\(identity\)\s*\.await/);
  assert.match(source, /record\.repair_claim\.as_ref\(\) != Some\(repair_fence\)/);
  assert.match(source, /record\.revision != repair_fence\.repair_claim_revision/);
  assert.match(source, /with_repair_fence\(repair_fence\.clone\(\)\)/);
  assert.match(source, /self\.apply\(receipt\)\.await/);
  assert.match(transitionSource, /repair_lease_until > statement_timestamp\(\)/);
});

test("repair lease conversion is millisecond exact and physically tested", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /bounded_repair_lease_millis\(Duration::from_millis\(1\)\)/);
  assert.match(source, /bounded_repair_lease_millis\(Duration::from_secs\(30\)\)/);
  assert.match(source, /Duration::from_micros\(1\)/);
  assert.match(
    source,
    /postgres_unknown_claim_is_fenced_and_reconciles_after_pool_recovery/,
  );
  assert.match(source, /repair-worker-a/);
  assert.match(source, /repair-worker-b/);
  assert.match(source, /store\.pool\.close\(\)\.await/);
  assert.match(source, /SipEffectReconcileOutcome::ProtocolObserved/);
});

test("controlled repair evidence binds attempts, restart and cleared claim", () => {
  const sha256 = (value: Buffer): string =>
    createHash("sha256").update(value).digest("hex");
  const success = readFileSync(`${PHYSICAL_EVIDENCE}/postgres-tests.log`);
  const attemptOne = readFileSync(
    `${PHYSICAL_EVIDENCE}/attempt-1-missing-tenant.log`,
  );
  const attemptTwo = readFileSync(
    `${PHYSICAL_EVIDENCE}/attempt-2-semantic-expectation.log`,
  );
  const database = readFileSync(
    `${PHYSICAL_EVIDENCE}/database-after-restart.txt`,
    "utf8",
  );
  const report = readFileSync(`${PHYSICAL_EVIDENCE}/README.md`, "utf8");
  assert.equal(
    sha256(success),
    "c32a82641dbea419a9b6f8819847d91cec4656cb6860ba2ff3c91a53f122471d",
  );
  assert.equal(
    sha256(attemptOne),
    "048d34c271c449643537229cf665fd505161bc2a8961920809a7c9722991cebf",
  );
  assert.equal(
    sha256(attemptTwo),
    "66a0d81ed1edad5732c3627677ccc49925301af93a0189566a746c36bdc1604d",
  );
  assert.equal(
    readFileSync(`${PHYSICAL_EVIDENCE}/postgres-tests.exit-code`, "utf8"),
    "0\n",
  );
  assert.match(
    success.toString("utf8"),
    /postgres_prepare_replay_and_query_survive_pool_recreation \.\.\. ok[\s\S]*postgres_receipt_transition_is_atomic_replayable_and_recoverable \.\.\. ok[\s\S]*postgres_unknown_claim_is_fenced_and_reconciles_after_pool_recovery \.\.\. ok[\s\S]*postgres_restart_recovery=passed/,
  );
  assert.match(database, /effect_state=protocol_observed/);
  assert.match(database, /effect_revision=6/);
  assert.match(database, /receipt_count=4/);
  assert.match(database, /repair_attempts=1/);
  assert.match(database, /repair_epoch_high_watermark=11/);
  assert.match(database, /repair_owner_cleared=true/);
  assert.match(database, /repair_claim_token_cleared=true/);
  assert.match(report, /Status: `verified_controlled`/);
  assert.match(report, /two preceding attempts are retained rather than hidden/i);
  assert.match(report, /`G03-E16-NATIVE-AUTHORITY` remain[\s\S]*`not_run`/);
});

test("exact build retains reconciliation in ivekit.57", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.70"/);
  assert.match(
    build,
    /rustpbx-converact-postgres-sip-effect-transitions\.patch"[\s\S]*rustpbx-converact-postgres-sip-effect-reconciliation\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-postgres-sip-effect-reconciliation\.patch/,
  );
});

test("ivekit.52 reconciliation stopped before batch exhaustion and live authority", () => {
  const readme = readFileSync(README, "utf8");
  const slice = readme.slice(
    readme.indexOf("ivekit.52"),
    readme.indexOf("ivekit.53"),
  );
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const nativeAuthority = evidence.entries.find(
    (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
  );
  assert.match(slice, /ivekit\.52/);
  assert.match(slice, /repair claim/i);
  assert.match(slice, /batch[\s\S]*exhaustion[\s\S]*live SIP dispatch[\s\S]*`not_run`/i);
  assert.equal(nativeAuthority?.status, "not_run");
});
