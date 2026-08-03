import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-postgres-sip-effect-transitions.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence-index-v1.json";
const PHYSICAL_EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence/raw/native-postgres-transition-a0ade99-01";

function additions(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("native PostgreSQL transition commits receipt and effect atomically", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /const TRANSITION_LOCK_SQL: &str = concat!/);
  assert.match(source, /const RECEIPT_INSERT_SQL: &str = r#/);
  assert.match(source, /const TRANSITION_UPDATE_SQL: &str = concat!/);
  assert.match(source, /pub async fn apply\(/);
  assert.match(
    source,
    /begin_tenant_transaction[\s\S]*TRANSITION_LOCK_SQL[\s\S]*RECEIPT_INSERT_SQL[\s\S]*TRANSITION_UPDATE_SQL[\s\S]*transaction\.commit\(\)/,
  );
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel/);
});

test("transition rejects stale, terminal and semantically conflicting receipts", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /if current\.state\.is_terminal\(\)/);
  assert.match(source, /current\.revision != receipt\.fence\.expected_revision/);
  assert.match(source, /RepairFenceRequired/);
  assert.match(source, /repair_lease_until > statement_timestamp\(\)/);
  assert.match(source, /validate_receipt_replay/);
  assert.match(source, /ReceiptConflict/);
  assert.match(source, /effect_identity_hash/);
  assert.match(source, /ON CONFLICT \(tenant_id, receipt_id\) DO NOTHING/);
});

test("transition recovery has an isolated real PostgreSQL test", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(
    source,
    /postgres_receipt_transition_is_atomic_replayable_and_recoverable/,
  );
  assert.match(source, /CONVERACT_SIP_EFFECT_TEST_DATABASE_URL/);
  assert.match(source, /store\.pool\.close\(\)\.await/);
  assert.match(
    source,
    /recovered_store[\s\S]*\.query\(&effect\.identity\)[\s\S]*assert_eq!\(recovered, completed\.record\)/,
  );
});

test("controlled PostgreSQL transition evidence is exact and remains scoped", () => {
  const log = readFileSync(`${PHYSICAL_EVIDENCE}/postgres-tests.log`);
  const report = readFileSync(`${PHYSICAL_EVIDENCE}/README.md`, "utf8");
  const database = readFileSync(
    `${PHYSICAL_EVIDENCE}/database-after-restart.txt`,
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(log).digest("hex"),
    "d0ae89f2e87c77a4e692cb393a9609ae9e4e2f6b9da66186c0f32f28904441cf",
  );
  assert.equal(
    readFileSync(`${PHYSICAL_EVIDENCE}/postgres-tests.exit-code`, "utf8"),
    "0\n",
  );
  assert.match(
    log.toString("utf8"),
    /postgres_prepare_replay_and_query_survive_pool_recreation \.\.\. ok[\s\S]*postgres_receipt_transition_is_atomic_replayable_and_recoverable \.\.\. ok[\s\S]*postgres_restart_recovery=passed/,
  );
  assert.match(database, /postgres_container=running\/healthy/);
  assert.match(database, /effect_state=protocol_observed/);
  assert.match(database, /effect_revision=5/);
  assert.match(database, /receipt_count=4/);
  assert.match(report, /Status: `verified_controlled`/);
  assert.match(report, /Repair claim\/reconcile[\s\S]*remain[\s\S]*`not_run`/i);
  assert.match(report, /does not promote `G03-E16-NATIVE-AUTHORITY`/);
});

test("exact build applies ivekit.52 after the PostgreSQL prepare store", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.52"/);
  assert.match(
    build,
    /rustpbx-converact-postgres-sip-effect-store\.patch"[\s\S]*rustpbx-converact-postgres-sip-effect-transitions\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-postgres-sip-effect-transitions\.patch/,
  );
});

test("ivekit.51 atomic transition slice stopped before repair and live authority", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const nativeAuthority = evidence.entries.find(
    (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
  );
  assert.match(readme, /ivekit\.51/);
  assert.match(readme, /atomic/i);
  assert.match(readme, /repair claim\/reconcile[\s\S]*live SIP dispatch/);
  assert.equal(nativeAuthority?.status, "not_run");
});
