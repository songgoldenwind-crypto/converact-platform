import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-protocol-observation.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.59 applies the protocol observer after the durable rsipstack gate", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.61"/);
  assert.match(
    build,
    /rustpbx-converact-rsipstack-sip-effect-gate\.patch"[\s\S]*rustpbx-converact-protocol-observation\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-protocol-observation\.patch/,
  );
});

test("transport and protocol correlation have independent compact bounds", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /max_pending_protocol_observations/);
  assert.match(source, /struct SipEffectObservationLocator/);
  assert.match(source, /pending_transport: DashMap/);
  assert.match(source, /pending_protocol: DashMap/);
  assert.match(source, /mpsc::OwnedPermit<EffectObservationWork>/);
  assert.match(source, /try_reserve_owned\(\)/);
  assert.match(source, /observation_queue_capacity < required_queue_capacity/);
  assert.match(source, /observation_worker_shards > self\.max_pending_observations/);
  assert.match(source, /observation_worker_shards > self\.max_pending_protocol_observations/);
  assert.match(source, /protocol_capacity_is_independent_from_the_transport_callback_window/);
  const testModuleStart = source.indexOf("#[cfg(test)]");
  assert.ok(testModuleStart > 0);
  assert.doesNotMatch(
    source.slice(0, testModuleStart),
    /unbounded_channel|tokio::spawn\(|std::thread::spawn/,
  );
});

test("reserved FIFO work is never dropped on saturation or store acknowledgement loss", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /fn reserve_observation_slot/);
  assert.match(source, /retry_work: Option<EffectObservationWork>/);
  assert.match(source, /shard_state\.retry_work = Some\(work\)/);
  assert.match(source, /persist_observation\(/);
  assert.match(source, /reserved_queue_never_drops_transport_observations/);
  assert.match(source, /reserved_queue_preserves_transport_before_protocol_observation/);
  assert.match(source, /failed_observation_ack_retries_the_same_work_without_reordering/);
  assert.match(source, /closed_observer_fails_new_prepare_before_store_work/);
  assert.match(source, /prepare_for_send\(/);
  assert.match(source, /apply_observation\(/);
  assert.match(source, /flush_receipt_constraint\(/);
  assert.match(source, /postgres_atomic_prepare_and_transport_completion_survive_replay_and_reconnect/);
  assert.match(source, /postgres_prepare_and_terminal_receipts_use_database_clock_under_host_skew/);
  assert.doesNotMatch(source, /pub async fn query_by_identity_hash/);
});

test("runtime and external recovery claims remain gated", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /ivekit\.59/);
  assert.match(readme, /six physical[\s\S]*PostgreSQL cases pass/i);
  assert.match(readme, /exact-source component results/i);
  assert.match(readme, /stale nonterminal recovery[\s\S]*observer-process crash[\s\S]*remain `not_run`/i);
  assert.match(readme, /live endpoint activation[\s\S]*`not_run`/i);
  assert.match(readme, /production eligibility remains false/i);
});
