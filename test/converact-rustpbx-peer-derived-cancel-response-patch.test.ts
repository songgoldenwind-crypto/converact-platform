import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-peer-derived-cancel-response.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const PATCH_SHA256 =
  "fc56524e5b753d2a4ec354a07fb2f9679de90b0af32a0d9f3ea2a11e489b301c";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.62 applies the bounded capability after derived ACK support", () => {
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
  assert.match(build, /PATCHSET="ivekit\.83"/);
  assert.match(
    build,
    /rustpbx-converact-derived-non-2xx-ack\.patch"[\s\S]*rustpbx-converact-peer-derived-cancel-response\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-peer-derived-cancel-response\.patch/,
  );
});

test("one shared bounded registry owns the one-use peer-derived capability", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /pub fn register_peer_derived\(/);
  assert.match(source, /self\.register_binding\(peer_derived_binding_key/);
  assert.match(source, /sip-peer-derived-intent-v1/);
  assert.match(source, /fn materialize_peer_derived_effect\(/);
  assert.match(source, /TransactionKey::from_request\(cancel, TransactionRole::Server\)/);
  assert.match(source, /response_cseq\.method\(\)\.ok\(\)[\s\S]*Method::Cancel/);
  assert.match(source, /cancel\.via_header\(\)[\s\S]*response\.via_header\(\)/);
  assert.match(source, /COMPLETION_SCOPE_TRANSPORT_TERMINAL/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|std::thread::spawn/);
});

test("validation, replay and commit ambiguity fail closed without a second permit", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(
    source,
    /peer_derived_cancel_ok_rejects_mismatched_response_before_store/,
  );
  assert.match(
    source,
    /peer_derived_cancel_ok_capability_cannot_issue_a_second_permit/,
  );
  assert.match(
    source,
    /peer_derived_commit_ack_loss_consumes_capability_and_requires_reconciliation/,
  );
  assert.match(source, /SipEffectGateError::ReconciliationRequired/);
  assert.match(source, /SipEffectState::TransportCompleted/);
});

test("documentation keeps live activation and current-patch performance unclaimed", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /ivekit\.62/);
  assert.match(readme, /200-to-CANCEL/i);
  assert.match(readme, /live endpoint activation[\s\S]*`not_run`/i);
  assert.match(readme, /production eligibility remains false/i);
});
