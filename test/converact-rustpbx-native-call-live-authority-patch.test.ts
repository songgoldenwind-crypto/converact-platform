import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-native-call-live-authority.patch";
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

test("every live SIP call resolves exactly one native identity and admission authority", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, "utf8");
  const source = additions(patch);
  assert.match(patch, /src\/call\/domain\/foundation_identity\.rs/);
  assert.match(patch, /src\/proxy\/active_call_registry\.rs/);
  assert.doesNotMatch(patch, /src\/call\/domain\/native_call\.rs/);
  assert.match(source, /pub fn standalone\(/);
  assert.match(source, /live_native_identity\(&provider_call_id\)/);
  assert.match(source, /live_native_identity\(&session_id\)/);
  assert.match(
    source,
    /self\.try_upsert_authoritative\(entry, handle\.clone\(\), identity\)/,
  );
  assert.match(
    source,
    /live_standalone_registration_uses_native_identity_and_admission_authority/,
  );
  assert.match(
    source,
    /assert_eq!\(unchanged\.legs\[0\]\.state, NativeLegState::Planned\)/,
  );
  assert.doesNotMatch(source, /NativeLegEvent::(?:StartInvite|Final2xx)/);
  assert.doesNotMatch(source, /pub fn try_update/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|sqlx::|PgPool/);
  assert.doesNotMatch(source, /\.iter\(\).*native_calls|native_calls.*\.iter\(/s);
});

test("ivekit.57 retains native admission authority before durable egress activation", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.61"/);
  assert.match(
    build,
    /rustpbx-converact-postgres-sip-effect-repair-batch\.patch"[\s\S]*rustpbx-converact-native-call-live-authority\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-native-call-live-authority\.patch/,
  );
});

test("native admission activation does not overclaim lifecycle or durable effects", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const nativeAuthority = evidence.entries.find(
    (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
  );
  assert.match(
    readme,
    /live standalone SIP\s+Calls enter the native identity and admission\s+authority/i,
  );
  assert.match(readme, /lifecycle event activation remains `not_run`/i);
  assert.match(readme, /durable SipEffect\s+writer remain `not_run`/);
  assert.equal(nativeAuthority?.status, "not_run");
});
