import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-canonical-wire-freeze.patch";
const patch = readFileSync(PATCH, "utf8");
const build = readFileSync("infra/converact/rustpbx/build.sh", "utf8");
const readme = readFileSync("infra/converact/rustpbx/README.md", "utf8");

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.57 applies canonical wire freeze after the durable egress gate", () => {
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(build, /PATCHSET="ivekit\.71"/);
  assert.match(
    build,
    /rsipstack-converact-durable-egress-effect-gate\.patch"[\s\S]*rsipstack-converact-canonical-wire-freeze\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-canonical-wire-freeze\.patch/,
  );
});

test("one frozen post-inspector image feeds durable prepare and transport", () => {
  const source = additions(patch);
  assert.match(source, /struct FrozenSipMessage/);
  assert.match(source, /canonical_wire_bytes: Vec<u8>/);
  assert.match(source, /let canonical_wire_bytes = message\.to_bytes\(\)/);
  assert.match(
    source,
    /prepare_egress_effect\(&frozen\.message, &frozen\.canonical_wire_bytes\)[\s\S]*send_frozen\([\s\S]*&frozen\.canonical_wire_bytes/,
  );
  assert.match(
    source,
    /canonical_wire_images[\s\S]*the durable gate must receive the exact bytes emitted by the transport/,
  );
  assert.match(source, /supplied bytes are finalized after all message inspectors/);
});

test("network transports send the supplied bytes and listeners fail closed", () => {
  const source = additions(patch);
  assert.match(source, /pub\(crate\) async fn send_frozen\(/);
  assert.match(source, /transport\.send_raw\(canonical_wire_bytes, &destination\)/);
  assert.match(source, /Tcp\(transport\) => transport\.send_raw\(canonical_wire_bytes\)/);
  assert.match(source, /Tls\(transport\) => transport\.send_raw\(canonical_wire_bytes\)/);
  assert.match(source, /transport\.send_text_raw\(canonical_wire_bytes\)/);
  assert.match(source, /Message::Text\(data\.to_owned\(\)\.into\(\)\)/);
  assert.match(source, /SIP listener connection cannot send messages/);
  assert.match(
    source,
    /tcp_send_frozen_writes_the_supplied_canonical_wire_image/,
  );
  assert.match(
    source,
    /listener_connection_cannot_report_a_wire_send_as_accepted/,
  );
});

test("ACK CANCEL and protocol retransmissions reuse bounded frozen images", () => {
  const source = additions(patch);
  assert.match(source, /frozen_initial_request: Option<Arc<FrozenSipMessage>>/);
  assert.match(source, /frozen_cancel_request: Option<Arc<FrozenSipMessage>>/);
  assert.match(source, /frozen_last_ack: Option<Arc<FrozenSipMessage>>/);
  assert.match(source, /frozen_last_response: Option<Arc<FrozenSipMessage>>/);
  assert.match(source, /client_cancel_retry_reuses_the_frozen_wire_image/);
  assert.match(
    patch,
    /client_duplicate_final_retries_ack_after_durable_prepare_recovers/,
  );
  assert.match(source, /peer retransmission must retry the exact frozen ACK wire image/);
  assert.match(source, /initial wire image was not frozen[\s\S]*send_frozen/);
  assert.match(source, /frozen_last_response[\s\S]*send_frozen/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|sqlx::|PgPool/);
});

test("documentation scopes native proof and leaves runtime activation unclaimed", () => {
  assert.match(readme, /ivekit\.56/);
  assert.match(readme, /in-memory `Channel` transport/);
  assert.match(readme, /runtime PostgreSQL\s+gate adapter[\s\S]*remain `not_run`/);
  assert.match(readme, /production eligibility remains false/);
});
