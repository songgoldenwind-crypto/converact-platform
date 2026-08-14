import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-durable-egress-effect-gate.patch";
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

test("ivekit.55 installs the durable egress gate after the bounded rsipstack queue", () => {
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(build, /PATCHSET="ivekit\.79"/);
  assert.match(
    build,
    /rsipstack-ivekit-bounded-protocol-mailboxes\.patch"[\s\S]*rsipstack-converact-durable-egress-effect-gate\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-durable-egress-effect-gate\.patch/,
  );
  assert.match(patch, /src\/transaction\/tests\/test_client\.rs/);
});

test("configured gate is fail-closed and sees the finalized post-inspector message", () => {
  const source = additions(patch);
  assert.match(source, /pub trait EgressEffectGate: Send \+ Sync/);
  assert.match(source, /\) -> Result<EgressEffectPermit>;/);
  assert.doesNotMatch(source, /\) -> Result<Option<EgressEffectPermit>>;/);
  assert.match(source, /fn finalize_outbound_message/);
  assert.match(
    source,
    /finalize_outbound_message[\s\S]*prepare_egress_effect\(&message\)\.await\?/,
  );
  assert.match(source, /EGRESS_EFFECT_TOKEN_HARD_CEILING: usize = 256/);
  assert.match(source, /egress_effect_permit_rejects_unbounded_or_ambiguous_tokens/);
});

test("optional gate preserves the existing public EndpointInner constructor", () => {
  assert.match(
    patch,
    /capacity_limits: EndpointCapacityLimits,[\s\S]*?Self::new_with_egress_effect_gate\([\s\S]*?message_inspector,[\s\S]*?None,[\s\S]*?locator/,
  );
  assert.match(patch, /fn new_with_egress_effect_gate\(/);
  assert.doesNotMatch(additions(patch), /pub fn new\(/);
});

test("first visible client and server effects are gated but protocol replay is not", () => {
  const source = additions(patch);
  assert.match(
    source,
    /client_initial_cancel_and_ack_each_require_one_egress_effect_decision/,
  );
  assert.match(source, /client_initial_prepare_failure_emits_no_bytes/);
  assert.match(
    source,
    /client_duplicate_final_retries_ack_after_durable_prepare_recovers/,
  );
  assert.match(
    source,
    /A failed ACK prepare\/send[\s\S]*self\.send_ack\(connection\.clone\(\)\)\.await\.ok\(\)/,
  );
  assert.match(source, /client_timer_retransmission_reuses_frozen_bytes/);
  assert.match(source, /frozen_initial_request/);
  assert.match(source, /egress_effect_gate_bypasses_trying_and_retransmission/);
  assert.match(
    source,
    /response\.status_code == StatusCode::Trying[\s\S]*return Ok\(None\)/,
  );
  assert.match(source, /EgressEffectOutcome::TransportAccepted/);
  assert.match(source, /EgressEffectOutcome::TransportUnknown/);
  assert.match(source, /fn observe_transport\(/);
  assert.doesNotMatch(source, /async fn observe_transport/);
});

test("stateless overload response stays available during durable-store outage", () => {
  const source = additions(patch);
  assert.match(patch, /endpoint_capacity_emergency_503_remains_stateless/);
  assert.match(source, /reject_prepare: true/);
  assert.match(source, /gate\.prepare_calls\.load\(Ordering::SeqCst\), 0/);
  assert.match(source, /deliberately bypass the[\s\S]*durable egress gate/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|sqlx::|PgPool/);
});

test("documentation keeps runtime activation and production eligibility unclaimed", () => {
  assert.match(readme, /ivekit\.55/);
  assert.match(readme, /runtime PostgreSQL gate adapter remains\s+`not_run`/);
  assert.match(readme, /production eligibility remains false/);
});
