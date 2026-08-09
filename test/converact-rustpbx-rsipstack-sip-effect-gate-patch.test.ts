import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-rsipstack-sip-effect-gate.patch";
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

test("durable rsipstack gate patch is exact and build linked", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const bytes = readFileSync(PATCH);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "e41fc2bc6405438b3a4d88598953baa7e1e538c52ce78670a6eded2ae9cd6b6d",
  );
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = bytes.toString("utf8");
  assert.match(patch, /src\/call\/adapters\/mod\.rs/);
  assert.match(patch, /src\/call\/adapters\/rsipstack_sip_effect_gate\.rs/);
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.60"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-live-authority\.patch"[\s\S]*rustpbx-converact-rsipstack-sip-effect-gate\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-rsipstack-sip-effect-gate\.patch/,
  );
});

test("only registered semantic intent can precede one durable wire permit", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  const production = source.split("#[cfg(test)]\nmod tests")[0];
  assert.match(source, /pub struct SipEffectIntentRegistry/);
  assert.match(source, /effect_binding_key\(transaction_key, message\)/);
  assert.match(source, /call_id_header\(\)/);
  assert.match(source, /cseq_header\(\)/);
  assert.match(source, /from_header\(\)/);
  assert.match(source, /to_header\(\)/);
  assert.match(source, /canonical_wire_bytes: canonical_wire_bytes\.to_vec\(\)/);
  assert.match(
    source,
    /\.prepare\(effect\)[\s\S]*"durable-decision"[\s\S]*"send-attempted"[\s\S]*EgressEffectPermit::try_new/,
  );
  assert.match(
    source,
    /send_attempt\.replayed \|\| send_attempt\.record\.state != SipEffectState::SendAttempted/,
  );
  assert.match(source, /requires reconciliation[\s\S]*intent\.consume\(\)/);
  assert.match(source, /IntentMissing/);
  assert.match(source, /IntentConflict/);
  assert.match(source, /ReconciliationRequired/);
  assert.match(production, /pub fn new_postgres\(/);
  assert.match(production, /Arc<PostgresSipEffectStore>/);
  assert.doesNotMatch(production, /InMemorySipEffectLedger/);
});

test("observation path is fixed-shard bounded and never blocks transport", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  const production = source.split("#[cfg(test)]\nmod tests")[0];
  const observe = production.slice(
    production.indexOf("fn observe_transport"),
    production.indexOf("pub struct SipEffectTransportObserver"),
  );
  assert.match(production, /OBSERVATION_SHARDS_HARD_CEILING: usize = 256/);
  assert.match(production, /observation_worker_shards: usize/);
  assert.match(production, /Vec<mpsc::Sender<TransportObservationWork>>/);
  assert.match(production, /mpsc::channel\(shard_capacity\)/);
  assert.match(production, /Semaphore::new\(options\.max_pending_observations\)/);
  assert.match(observe, /\.try_send\(TransportObservationWork/);
  assert.doesNotMatch(observe, /\.await|loop\s*\{|while\s/);
  assert.doesNotMatch(production, /unbounded_channel|tokio::spawn\(|std::thread::spawn/);
  assert.match(source, /observation_overflow_leaves_a_reconcilable_send_attempt/);
  assert.match(source, /closed_observer_leaves_a_reconcilable_send_attempt/);
  assert.match(
    source,
    /observation_capacity_is_exactly_partitioned_across_fixed_workers/,
  );
  assert.match(source, /unknown_transport_result_is_persisted_with_bounded_repair_delay/);
  assert.match(source, /ambiguous_send_attempt_commit_is_consumed_and_never_blindly_retried/);
});

test("runtime adapter remains default-disabled and production eligibility stays false", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  assert.match(readme, /ivekit\.57/);
  assert.match(readme, /default-disabled/i);
  assert.match(readme, /1977 passed[\s\S]*5 ignored/i);
  assert.match(readme, /live endpoint activation[\s\S]*`not_run`/i);
  assert.match(readme, /production eligibility remains false/i);
  assert.equal(
    evidence.entries.find(
      (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
    )?.status,
    "not_run",
  );
});
