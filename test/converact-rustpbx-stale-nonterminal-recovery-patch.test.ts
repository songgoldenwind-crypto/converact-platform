import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery.patch";
const FIXTURE_PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery-test-fixture.patch";
const ROLE_SCOPED_FIXTURE_PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-stale-nonterminal-recovery-role-scoped-fixture.patch";
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

test("ivekit.68 applies both immutable-ledger fixture guards after stale recovery", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.68"/);
  assert.match(
    build,
    /rustpbx-converact-stale-nonterminal-recovery\.patch"[\s\S]*rustpbx-converact-stale-nonterminal-recovery-test-fixture\.patch"[\s\S]*rustpbx-converact-stale-nonterminal-recovery-role-scoped-fixture\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-stale-nonterminal-recovery-test-fixture\.patch/,
  );
  const fixturePatch = readFileSync(FIXTURE_PATCH, "utf8");
  assert.equal(
    createHash("sha256").update(fixturePatch).digest("hex"),
    "837b63848c3abfa6e7a72d3fbc876d5c92e9f3e011d6ba2832b6599c89ac7eaa",
  );
  const parsedFixture = spawnSync("git", ["apply", "--numstat", FIXTURE_PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsedFixture.status, 0, parsedFixture.stderr);
  assert.match(fixturePatch, /SET revision = revision \+ 1/);
  assert.match(fixturePatch, /updated_at = statement_timestamp\(\) - INTERVAL '60 seconds'/);
  assert.doesNotMatch(
    fixturePatch,
    /\+\s+SET updated_at = statement_timestamp\(\) - INTERVAL '60 seconds'/,
  );
  const roleScopedFixturePatch = readFileSync(ROLE_SCOPED_FIXTURE_PATCH, "utf8");
  assert.equal(
    createHash("sha256").update(roleScopedFixturePatch).digest("hex"),
    "d285ea5643eb07e419b833e786f4f4d87d7c447e4243de81f5e2fafc744bd50f",
  );
  const parsedRoleScopedFixture = spawnSync(
    "git",
    ["apply", "--numstat", ROLE_SCOPED_FIXTURE_PATCH],
    { encoding: "utf8" },
  );
  assert.equal(parsedRoleScopedFixture.status, 0, parsedRoleScopedFixture.stderr);
  const roleScopedAdditions = additions(roleScopedFixturePatch);
  assert.match(roleScopedAdditions, /begin_tenant_transaction/);
  assert.match(roleScopedAdditions, /execute\(&mut \*transaction\)/);
  assert.doesNotMatch(roleScopedAdditions, /admin_database_url|admin_pool/);
});

test("stale recovery remains default-disabled until live owner fencing is proved", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  assert.match(readme, /ivekit\.68/);
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
