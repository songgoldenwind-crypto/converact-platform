import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-call-leg-model.patch";
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

test("RustPBX compiles the bounded fenced native Call and Leg model", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, "utf8");
  const addedSource = additions(patch);
  assert.match(patch, /src\/call\/domain\/native_call\.rs/);
  assert.match(patch, /src\/call\/domain\/mod\.rs/);
  assert.match(addedSource, /pub struct NativeCall \{/);
  assert.match(addedSource, /pub struct NativeCallFence \{/);
  assert.match(addedSource, /LEGS_PER_CALL_DEFAULT: usize = 32/);
  assert.match(addedSource, /LEGS_PER_CALL_HARD_CEILING: usize = 256/);
  assert.match(addedSource, /FORK_BRANCHES_PER_ATTEMPT_HARD_CEILING: usize = 32/);
  assert.match(addedSource, /MAILBOX_PER_CALL_DEFAULT: usize = 256/);
  assert.match(addedSource, /DEDUPE_RECEIPTS_PER_CALL_HARD_CEILING: usize = 2_048/);
  assert.match(addedSource, /HashMap<LegId, NativeLeg>/);
  assert.match(addedSource, /VecDeque<NativeCallWorkItem>/);
  assert.match(addedSource, /fn resolve_authority/);
  assert.match(addedSource, /fn resolve_fence/);
  assert.match(addedSource, /fn find_replay/);
  assert.match(addedSource, /pub fn observe_fork_winner/);
  assert.match(addedSource, /pub fn commit_transfer_selection/);
  assert.match(addedSource, /NativeRequiredEffect::AckThenBye/);
  assert.match(addedSource, /NativeRequiredEffect::Retry491Bounded/);
  assert.match(addedSource, /format!\("leg-event:\{\}", event\.as_str\(\)\)/);
  assert.match(
    addedSource,
    /revision_overflow_and_invalid_bounds_never_partially_mutate/,
  );
  assert.doesNotMatch(
    addedSource,
    /Mutex|RwLock|tokio::spawn\(|unbounded_channel|interval\(|unsafe\s*\{/,
  );
  assert.doesNotMatch(addedSource, /leg-event:\{event:\?\}/);
});

test("the exact build applies the model after outbound admission", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.77"/);
  assert.match(
    build,
    /rustpbx-converact-outbound-call-admission\.patch"[\s\S]*rustpbx-converact-native-call-leg-model\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-leg-model\.patch/,
  );
});

test("compiled model status does not prematurely promote native authority", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const nativeAuthority = evidence.entries.find(
    (entry: { evidence_id: string }) =>
      entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
  );
  assert.match(readme, /compiled native model, not a claim/);
  assert.equal(nativeAuthority?.status, "not_run");
});
