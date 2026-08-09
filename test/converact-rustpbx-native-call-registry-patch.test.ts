import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-call-registry.patch";
const BUILD = "infra/converact/rustpbx/build.sh";

function additions(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("RustPBX binds native Call authority to bounded provider and Dialog indexes", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, "utf8");
  const addedSource = additions(patch);
  assert.match(patch, /src\/proxy\/active_call_registry\.rs/);
  assert.match(patch, /src\/proxy\/proxy_call\/sip_session\.rs/);
  assert.match(addedSource, /ACTIVE_CALLS_HARD_CEILING: usize = 1_000_000/);
  assert.match(addedSource, /CALL_LEGS_HARD_CEILING: usize = 256/);
  assert.match(addedSource, /PROTOCOL_DIALOG_HISTORY_HARD_CEILING: usize = 16/);
  assert.match(addedSource, /slots: DashMap<String, ActiveProxyCallSlot>/);
  assert.match(addedSource, /providers_by_call: DashMap<CallId, Vec<String>>/);
  assert.match(addedSource, /active_count: AtomicUsize/);
  assert.match(addedSource, /fetch_update\(Ordering::AcqRel/);
  assert.match(addedSource, /try_insert/);
  assert.match(addedSource, /try_upsert_authoritative/);
  assert.match(addedSource, /ProviderAlreadyRegistered/);
  assert.match(addedSource, /derive_protocol_dialog_id/);
  assert.match(
    addedSource,
    /Retain the slot guard until both dialog indexes are published/,
  );
  assert.match(addedSource, /StatusCode::ServiceUnavailable/);
  assert.match(addedSource, /"Retry-After"\.to_string\(\), "1"\.to_string\(\)/);
  assert.match(
    addedSource,
    /Active call admission rejected before session start/,
  );
  assert.doesNotMatch(addedSource, /drop\(slot\)/);
  assert.doesNotMatch(
    addedSource,
    /Mutex|RwLock|tokio::spawn\(|unbounded_channel/,
  );
});

test("the exact build applies the native registry after native identity", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.62"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-identity\.patch"[\s\S]*rustpbx-converact-native-call-registry\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-registry\.patch/,
  );
});
