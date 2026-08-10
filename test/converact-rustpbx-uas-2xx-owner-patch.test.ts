import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const RSIPSTACK_PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-uas-2xx-owner.patch";
const RUSTPBX_PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-uas-2xx-owner.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.64 applies the UAS 2xx owner after peer-derived CANCEL support", () => {
  const patches = [
    [RSIPSTACK_PATCH, "062a3f84280ff7048720cb43268aac4dc23098283fee79def7b4d54dba980805"],
    [RUSTPBX_PATCH, "8205d52b99a03649716254f08f3d7e58f11e36ef56a33645e935b64380b572a9"],
  ] as const;
  for (const [path, digest] of patches) {
    assert.equal(existsSync(path), true, `${path} is required`);
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      digest,
    );
    const parsed = spawnSync("git", ["apply", "--numstat", path], {
      encoding: "utf8",
    });
    assert.equal(parsed.status, 0, parsed.stderr);
  }

  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.71"/);
  assert.match(
    build,
    /rsipstack-converact-peer-derived-cancel-response\.patch"[\s\S]*rsipstack-converact-uas-2xx-owner\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /rustpbx-converact-peer-derived-cancel-response\.patch"[\s\S]*rustpbx-converact-uas-2xx-owner\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-uas-2xx-owner\.patch/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-uas-2xx-owner\.patch/,
  );
});

test("one bounded owner retains one frozen 2xx and one durable permit", () => {
  const source = additions(readFileSync(RSIPSTACK_PATCH, "utf8"));
  assert.match(source, /struct ServerInvite2xxOwner/);
  assert.match(source, /response: Arc<FrozenSipMessage>/);
  assert.match(source, /permit: Option<EgressEffectPermit>/);
  assert.match(source, /TimerUas2xxRetransmit/);
  assert.match(source, /TimerUas2xxDeadline/);
  assert.match(source, /duration \* 2\)\.min\(self\.endpoint_inner\.option\.t2\)/);
  assert.match(source, /server_invite_2xx_deadline_marks_the_same_permit_unknown_once/);
  assert.match(source, /udp_server_invite_2xx_retransmits_the_same_frozen_wire_under_one_permit/);
  assert.match(source, /reliable_server_invite_2xx_waits_for_ack_without_retransmitting/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|std::thread::spawn/);
});

test("only exact Endpoint-proven ACK completes the deferred 2xx scope", () => {
  const rsipstack = additions(readFileSync(RSIPSTACK_PATCH, "utf8"));
  const rustpbx = additions(readFileSync(RUSTPBX_PATCH, "utf8"));
  assert.match(rsipstack, /ack_dialog_id: DialogId/);
  assert.match(rsipstack, /ack_cseq: u32/);
  assert.match(rsipstack, /owner\.matches_ack\(request\)/);
  assert.match(rsipstack, /Endpoint-proven peer ingress/);
  assert.match(rsipstack, /EgressEffectProtocolObservation::Completed/);
  assert.match(rustpbx, /COMPLETION_SCOPE_UAS_CORE_DEFERRED/);
  assert.match(rustpbx, /uas_core_ack_completion_resolves_the_deferred_2xx_permit/);
  assert.match(rustpbx, /SipEffectState::ProtocolObserved/);
});

test("documentation keeps crash recovery and production activation unclaimed", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /ivekit\.64/);
  assert.match(readme, /UAS[- ]Core|UAS 2xx/i);
  assert.match(readme, /crash[\s\S]{0,240}`not_run`/i);
  assert.match(readme, /production eligibility remains false/i);
});
