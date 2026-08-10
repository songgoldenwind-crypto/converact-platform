import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-postgres-sip-effect-store.patch";
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

test("native PostgreSQL SipEffect store is bounded and fail closed", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, "utf8");
  const source = additions(patch);
  assert.match(patch, /src\/call\/adapters\/postgres_sip_effect\.rs/);
  assert.match(source, /const MAX_STORE_IN_FLIGHT: usize = 256/);
  assert.match(source, /const MAX_STORE_QUEUE_DEPTH: usize = 1_024/);
  assert.match(source, /const MAX_STORE_WAIT: Duration = Duration::from_millis\(250\)/);
  assert.match(source, /try_acquire_owned\(\)/);
  assert.match(source, /tokio::time::timeout\(self\.wait_timeout/);
  assert.match(source, /PoolExhausted/);
  assert.match(source, /PoolTimeout/);
  assert.match(source, /SchemaIncompatible/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|InMemorySipEffectLedger/);
});

test("native writer enforces tenant, role, schema and immutable wire identity", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /SET LOCAL ROLE opc_sip_effect_executor/);
  assert.match(source, /app\.current_tenant/);
  assert.match(source, /app\.sip_effect_writer_identity/);
  assert.match(source, /ivekit_assert_sip_effect_writer/);
  assert.match(source, /SIP_EFFECT_SCHEMA_HASH/);
  assert.match(source, /protocol_effect_identity_hash/);
  assert.match(source, /wire_freeze_sha256/);
  assert.match(source, /canonical_wire_bytes/);
  assert.match(source, /ON CONFLICT DO NOTHING/);
  assert.match(source, /const PREPARE_INSERT_SQL: &str = concat!/);
  assert.match(source, /const PREPARE_CONFLICT_SQL: &str = concat!/);
  assert.match(source, /const QUERY_SQL: &str = concat!/);
  assert.doesNotMatch(source, /fn prepare_insert_sql\(\) -> String|AssertSqlSafe/);
});

test("isolated PostgreSQL recovery evidence has an explicit executable test", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(
    source,
    /postgres_prepare_replay_and_query_survive_pool_recreation/,
  );
  assert.match(source, /CONVERACT_SIP_EFFECT_TEST_DATABASE_URL/);
  assert.match(source, /CONVERACT_SIP_EFFECT_TEST_RUN_ID/);
  assert.match(source, /first_store\.pool\.close\(\)\.await/);
  assert.match(source, /recovered_store[\s\S]*\.query\(&effect\.identity\)/);
});

test("exact build retains the PostgreSQL store in ivekit.57", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.69"/);
  assert.match(
    build,
    /rustpbx-converact-durable-sip-effect-domain\.patch"[\s\S]*rustpbx-converact-postgres-sip-effect-store\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-postgres-sip-effect-store\.patch/,
  );
});

test("ivekit.50 prepare/query slice stopped before transitions and live authority", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const nativeAuthority = evidence.entries.find(
    (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
  );
  assert.match(readme, /ivekit\.50/);
  assert.match(readme, /prepare and query/);
  assert.match(
    readme,
    /Receipt transition,[\s\S]*repair claim\/reconcile and live SIP dispatch/,
  );
  assert.equal(nativeAuthority?.status, "not_run");
});
