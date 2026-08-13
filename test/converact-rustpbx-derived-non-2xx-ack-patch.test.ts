import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-derived-non-2xx-ack.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const PATCH_SHA256 =
  "3eccf50d126a25c3032836c560f84a0fd7dd6a24ae00b840b1646751f00a8724";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.60 applies the durable child after protocol observation", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  assert.equal(
    createHash("sha256").update(readFileSync(PATCH)).digest("hex"),
    PATCH_SHA256,
  );
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.74"/);
  assert.match(
    build,
    /rustpbx-converact-protocol-observation\.patch"[\s\S]*rustpbx-converact-derived-non-2xx-ack\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-derived-non-2xx-ack\.patch/,
  );
});

test("one parent INVITE atomically materializes one exact ACK child", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /struct SipEffectDerivedAttempt/);
  assert.match(source, /fn materialize_derived_effect\(/);
  assert.match(source, /async fn prepare_derived_for_send\(/);
  assert.match(source, /sqlx::query\(TRANSITION_LOCK_SQL\)/);
  assert.match(source, /parent_effect_identity_sha256/);
  assert.match(source, /derivation_binding_hash/);
  assert.match(source, /client_non_2xx_invite_ack/);
  assert.match(
    source,
    /postgres_atomically_derives_one_non_2xx_ack_from_its_parent_effect/,
  );
});

test("exact trigger mismatch, Unknown parent and replay fail closed", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(
    source,
    /SipEffectState::SendAttempted[\s\S]*SipEffectState::TransportAccepted[\s\S]*SipEffectState::ProtocolObserved/,
  );
  assert.match(
    source,
    /derived_ack_rejects_a_mismatched_peer_trigger_before_child_prepare/,
  );
  assert.match(
    source,
    /derived_ack_waits_for_reconciliation_when_parent_transport_is_unknown/,
  );
  assert.match(source, /derived_ack_replay_never_issues_a_second_wire_permit/);
  assert.match(
    source,
    /One parent INVITE owns at most one transaction-layer non-2xx ACK/,
  );
  assert.doesNotMatch(
    source,
    /tokio::spawn\(|unbounded_channel|std::thread::spawn/,
  );
});

test("component evidence does not promote live endpoint or production", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /exact-source component results/i);
  assert.match(readme, /parent.*Unknown[\s\S]*reconcil/i);
  assert.match(readme, /live endpoint activation[\s\S]*`not_run`/i);
  assert.match(readme, /production eligibility remains false/i);
});
