import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-outbound-call-admission.patch";
const BUILD = "infra/converact/rustpbx/build.sh";

function additions(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("standalone outbound INVITEs acquire bounded Call and Dialog authority before send", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, "utf8");
  const addedSource = additions(patch);
  assert.match(patch, /src\/proxy\/active_call_registry\.rs/);
  assert.match(patch, /src\/proxy\/proxy_call\/outbound_call_owner\.rs/);
  assert.match(patch, /src\/rwi\/processor\.rs/);
  assert.match(patch, /src\/rwi\/transfer\.rs/);
  assert.match(patch, /src\/proxy\/call\.rs/);
  assert.match(patch, /^-.*\.do_invite\(/m);
  assert.match(addedSource, /ActiveCallAdmissionLease/);
  assert.match(addedSource, /pub fn try_open/);
  assert.match(addedSource, /\.prepare_invite\(/);
  assert.match(addedSource, /\.try_open\(/);
  assert.match(addedSource, /prepared_invite\.send\(\)/);
  assert.match(addedSource, /try_register_dialog/);
  assert.match(addedSource, /ParallelOriginateCandidate/);
  assert.match(addedSource, /candidate\.activate\(\)/);
  assert.match(addedSource, /DialogGuard/);
  assert.match(addedSource, /spawn_confirmed_outbound_owner/);
  assert.match(addedSource, /OUTBOUND_CALL_HARD_LIFETIME/);
  assert.match(
    addedSource,
    /impl Drop for ActiveCallAdmissionLease[\s\S]*self\.registry\.remove/,
  );
  assert.doesNotMatch(addedSource, /pub fn commit|committed: bool/);
  assert.doesNotMatch(
    addedSource,
    /registry\.(?:upsert|register_dialog)\(/,
  );
  assert.doesNotMatch(
    addedSource,
    /Mutex|RwLock|unbounded_channel|tokio::spawn\(|interval\(/,
  );
});

test("the exact build applies outbound admission after the native registry", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.84"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-registry\.patch"[\s\S]*rustpbx-converact-outbound-call-admission\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-outbound-call-admission\.patch/,
  );
});
