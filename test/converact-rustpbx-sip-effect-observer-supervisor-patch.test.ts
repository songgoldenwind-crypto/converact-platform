import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-sip-effect-observer-supervisor.patch";

test("observer supervisor patch is a fixed-shard default-disabled component slice", () => {
  const source = readFileSync(PATCH, "utf8");
  const changedFiles = [...source.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(
    ([, left, right]) => {
      assert.equal(left, right);
      return left;
    },
  );
  assert.deepEqual(changedFiles, [
    "src/call/adapters/mod.rs",
    "src/call/adapters/rsipstack_sip_effect_gate.rs",
    "src/call/adapters/sip_effect_observer_supervisor.rs",
  ]);
  assert.match(source, /one_fixed_task_per_configured_observation_shard|configured_shards/u);
  assert.match(source, /crate::utils::spawn\(supervise_shard/u);
  assert.match(source, /AssertUnwindSafe\(observer\.persist_next\(\)\)\.catch_unwind\(\)/u);
  assert.match(source, /same_armed_work|retry_backoff/u);
  assert.match(source, /ObservationQuarantined/u);
  assert.match(source, /CancellationToken/u);
  assert.match(source, /fixed_supervisor_owns_exactly_one_worker_for_every_configured_shard/u);
  assert.doesNotMatch(source, /src\/proxy\/server\.rs|src\/config\.rs/u);
  assert.doesNotMatch(source, /tokio::spawn\([^\n]*effect/u);
});

test("ivekit.71 applies and formats the supervisor after the .70 recovery tail", () => {
  const build = readFileSync("infra/converact/rustpbx/build.sh", "utf8");
  assert.match(build, /PATCHSET="ivekit\.85"/u);
  assert.match(
    build,
    /rustpbx-converact-stale-nonterminal-recovery-returning-alias\.patch"[\s\S]*rustpbx-converact-sip-effect-observer-supervisor\.patch"/u,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-sip-effect-observer-supervisor\.patch/u,
  );
});
