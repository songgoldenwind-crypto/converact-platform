import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-peer-derived-cancel-response.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const PATCH_SHA256 =
  "f14d0a8cbab9d0a104588d78f4f2bc3bf0b48fd8a0e9a1515cbf487318a20eef";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.62 applies peer-derived CANCEL response after sealed ingress", () => {
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
  assert.match(build, /PATCHSET="ivekit\.67"/);
  assert.match(
    build,
    /rsipstack-converact-peer-ingress-proof\.patch"[\s\S]*rsipstack-converact-peer-derived-cancel-response\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-peer-derived-cancel-response\.patch/,
  );
});

test("matched CANCEL needs one peer proof and one pre-authorized effect", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /pub enum EgressEffectPeerDerivedKind/);
  assert.match(source, /ServerInviteCancelOk/);
  assert.match(source, /async fn prepare_peer_derived\(/);
  assert.match(source, /_ingress_proof: PeerIngressProof/);
  assert.match(source, /SIP peer-derived egress effect is not authorized/);
  assert.match(
    source,
    /matched_cancel_uses_one_peer_proven_effect_and_replays_frozen_200/,
  );
  assert.match(source, /duplicate CANCEL must reuse the frozen 200 response/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|DashMap/);
});

test("ambiguous send is Unknown and stable To-tag lineage is retained", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /automatic_cancel_reconciliation_required/);
  assert.match(
    source,
    /cancelled_matched_cancel_send_is_unknown_and_cannot_prepare_again/,
  );
  assert.match(source, /EgressEffectOutcome::TransportUnknown/);
  assert.match(source, /response_to = response_to\.with_tag\(make_tag\(\)\)/);
  assert.match(source, /self\.original[\s\S]*unique_push\(response_to\.clone\(\)\.into\(\)\)/);
  assert.match(source, /EgressEffectProtocolObservation::TransportTerminal/);
});
