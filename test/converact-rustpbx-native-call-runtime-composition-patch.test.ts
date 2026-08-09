import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-call-runtime-composition.patch";
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

test("the existing active registry composes one bounded native Call authority", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, "utf8");
  const source = additions(patch);
  assert.match(patch, /src\/call\/domain\/native_call\.rs/);
  assert.match(patch, /src\/proxy\/active_call_registry\.rs/);
  assert.match(source, /native_calls: DashMap<CallId, Arc<NativeCallCell>>/);
  assert.match(source, /state: Mutex<NativeCallCellState>/);
  assert.match(source, /NATIVE_CALL_REGISTRATION_RETRIES: usize = 3/);
  assert.match(source, /pub fn matches_authority/);
  assert.match(source, /pub fn native_call_snapshot/);
  assert.match(source, /Arc::ptr_eq\(candidate, &binding\.cell\)/);
  assert.match(
    source,
    /authoritative_registration_composes_native_call_leg_and_dialog_authority/,
  );
  assert.match(
    source,
    /native_leg_capacity_failure_rolls_back_all_secondary_indexes/,
  );
  assert.match(
    source,
    /concurrent_same_call_leg_publication_and_close_leave_no_orphan_cell/,
  );
  assert.match(source, /poisoned_native_call_isolated_from_other_call_authority/);
  assert.ok(
    source.indexOf("NativeCall::new") <
      source.indexOf("match self.native_calls.entry"),
    "fresh Call allocation must happen before the DashMap shard is acquired",
  );
  assert.doesNotMatch(source, /tokio::sync::Mutex|RwLock|tokio::spawn\(/);
  assert.doesNotMatch(source, /unbounded_channel|static\s+[^;]*Mutex/);
  assert.doesNotMatch(source, /pub struct [A-Za-z]+Registry/);
});

test("the exact build applies runtime composition after the native model", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.63"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-leg-model\.patch"[\s\S]*rustpbx-converact-native-call-runtime-composition\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-runtime-composition\.patch/,
  );
});

test("runtime composition does not promote unimplemented SIP effects", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const nativeAuthority = evidence.entries.find(
    (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
  );
  assert.match(readme, /admission and index composition only/);
  assert.match(
    readme,
    /live SIP transition dispatch\s+and durable SipEffect writer remain `not_run`/,
  );
  assert.equal(nativeAuthority?.status, "not_run");
});
