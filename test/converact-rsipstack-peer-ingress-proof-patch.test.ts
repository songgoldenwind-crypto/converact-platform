import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-peer-ingress-proof.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const PATCH_SHA256 =
  "218b0b6704f681a2a384a2a131c239876f245b0e85fb15c072525ab55797073f";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.61 applies sealed peer ingress after derived ACK authority", () => {
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
  assert.match(build, /PATCHSET="ivekit\.72"/);
  assert.match(
    build,
    /rsipstack-converact-derived-non-2xx-ack\.patch"[\s\S]*rsipstack-converact-peer-ingress-proof\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-peer-ingress-proof\.patch/,
  );
});

test("only Endpoint transport ingress can mint peer observation proof", () => {
  const patch = readFileSync(PATCH, "utf8");
  const source = additions(patch);

  assert.match(source, /pub struct PeerIngressProof \{\s*_private: \(\),\s*\}/);
  assert.match(source, /fn from_transport\(\) -> Self/);
  assert.match(source, /#\[cfg\(test\)\][\s\S]*pub\(crate\) fn test_only/);
  assert.match(source, /async fn on_received_message\(/);
  assert.doesNotMatch(source, /pub async fn on_received_message\(/);
  assert.match(patch, /-    pub async fn on_received_message\(/);
  assert.match(source, /tu_receiver: TransactionEventReceiver/);
  assert.doesNotMatch(source, /pub tu_receiver: TransactionEventReceiver/);
  assert.match(
    source,
    /TransactionEvent::Received\(msg, connection, ingress_proof\)/,
  );
  assert.match(source, /network ACK is missing Endpoint ingress proof/);
});

test("peer proof is one-use, allocation-free and exercised by durable ACK tests", () => {
  const patch = readFileSync(PATCH, "utf8");
  const source = additions(patch);

  assert.match(source, /size_of::<PeerIngressProof>\(\), 0/);
  assert.match(source, /take_initial_peer_ingress_proof\(\)/);
  assert.match(source, /the peer proof must be one-use/);
  assert.match(source, /async fn deliver_peer_message\(/);
  assert.match(source, /on_received_message_for_test\(/);
  assert.match(
    patch,
    /automatic_non_2xx_ack_uses_parent_bound_derivation_not_ordinary_prepare/,
  );
  assert.doesNotMatch(
    source,
    /tokio::spawn\(|unbounded_channel|DashMap|Mutex</,
  );
});
