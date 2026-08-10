import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery.patch";
const MIGRATION =
  "src/migrations/115_converact_sip_effect_stale_nonterminal_recovery.sql";
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

test("stale nonterminal recovery is successor-fenced and batch bounded", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const bytes = readFileSync(PATCH);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "290e77c2aae31df2c5f217ad39e6ce8616fe7c82b0c1b0a61414ed7d33ac2056",
  );

  const source = additions(bytes.toString("utf8"));
  assert.match(source, /const MAX_STALE_NONTERMINAL_BATCH_SIZE: usize = 100/);
  assert.match(source, /pub async fn recover_stale_nonterminal_batch\(/);
  assert.match(source, /state IN \('send_attempted', 'transport_accepted'\)/);
  assert.match(source, /protocol_session_id = \$2/);
  assert.match(source, /protocol_session_generation = \$3/);
  assert.match(source, /owner_epoch < \$5::numeric/);
  assert.match(
    source,
    /updated_at <= statement_timestamp\(\) -[\s\S]*INTERVAL '1 millisecond'/,
  );
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /SipEffectReceiptLevel::Unknown/);
  assert.match(source, /stale-nonterminal/);
  assert.match(source, /postgres_stale_nonterminal_recovery_is_bounded_and_fenced/);
  assert.match(source, /postgres_stale_nonterminal_recovery_survives_pool_recreation/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel/);
  const selectionSql = source.match(
    /const STALE_NONTERMINAL_SELECT_SQL:[\s\S]*?\n\);/,
  )?.[0];
  assert.ok(selectionSql);
  assert.doesNotMatch(selectionSql, /clock_timestamp\(\)/);
});

test("stale nonterminal selection has a rolling partial index", () => {
  assert.equal(existsSync(MIGRATION), true, `${MIGRATION} is required`);
  const migration = readFileSync(MIGRATION, "utf8");
  const runner = readFileSync("src/postgres-migrations.ts", "utf8");
  const schema = readFileSync("src/schema.sql", "utf8");

  for (const source of [migration, schema]) {
    assert.match(source, /idx_ivekit_sip_effect_stale_nonterminal/);
    assert.match(
      source,
      /tenant_id,[\s\S]*protocol_session_id,[\s\S]*protocol_session_generation,[\s\S]*updated_at,[\s\S]*protocol_effect_id/,
    );
    assert.match(source, /state IN \('send_attempted', 'transport_accepted'\)/);
  }
  assert.match(runner, /prepareSipEffectStaleNonterminalIndex/);
  assert.match(runner, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(runner, /indisvalid/);
  assert.match(runner, /expectedPredicate/);
});

test("ivekit.66 applies and formats stale recovery after ivekit.65", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.66"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-recovery-identity\.patch"[\s\S]*rustpbx-converact-stale-nonterminal-recovery\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-stale-nonterminal-recovery\.patch/,
  );
});

test("stale recovery remains default-disabled until live owner fencing is proved", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  assert.match(readme, /ivekit\.66/);
  assert.match(readme, /stale\s+`send_attempted` and `transport_accepted`/i);
  assert.match(readme, /live successor-owner wiring[\s\S]*`not_run`/i);
  assert.equal(
    evidence.entries.find(
      (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
    )?.status,
    "not_run",
  );
  assert.equal(
    evidence.entries.find((entry) => entry.evidence_id === "G03-E10-FAULT")
      ?.status,
    "not_run",
  );
});
