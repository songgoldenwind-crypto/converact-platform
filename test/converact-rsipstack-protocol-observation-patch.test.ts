import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-protocol-observation.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.59 applies protocol observation after canonical wire freeze", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.67"/);
  assert.match(
    build,
    /rsipstack-converact-canonical-wire-freeze\.patch"[\s\S]*rsipstack-converact-protocol-observation\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-protocol-observation\.patch/,
  );
});

test("only exact peer evidence completes the owning transaction effect", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /pub enum EgressEffectProtocolObservation/);
  assert.match(source, /fn observe_protocol\(/);
  assert.match(source, /client_request_is_protocol_completed_only_after_a_final_response/);
  assert.match(source, /server_invite_final_response_is_protocol_completed_only_by_the_matching_ack/);
  assert.match(source, /TransactionKey::from_response\(&resp, TransactionRole::Client\)/);
  assert.match(source, /actual_dialog != expected_dialog/);
  assert.match(
    source,
    /ack_cseq\.seq\(\)\.ok\(\) != original_cseq\.seq\(\)\.ok\(\)/,
  );
  assert.match(source, /timer_h_then_late_ack_keeps_one_protocol_unknown_observation/);
  assert.match(source, /server_invite_2xx_is_not_falsely_completed_by_the_transaction_layer/);
  assert.match(source, /legacy_cancel_is_unknown_because_its_response_has_no_transaction_owner/);
  assert.match(source, /pub\(crate\) tu_sender: TransactionEventSender/);
  assert.match(source, /TransactionEvent::LocalTimeout/);
  assert.match(source, /non_timeout_local_response_cannot_terminate_client_transaction/);
  assert.match(source, /local_client_timeout_is_protocol_unknown_not_completed/);
});

test("transport cancellation and ambiguity cannot leak or blindly resend a permit", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /struct EgressTransportAttempt/);
  assert.match(source, /impl Drop for EgressTransportAttempt/);
  assert.match(source, /EgressEffectOutcome::TransportUnknown/);
  assert.match(source, /initial_effect_attempt_started/);
  for (const regression of [
    "cancelled_primary_transport_send_reports_unknown_exactly_once",
    "cancelled_response_transport_send_reports_unknown_exactly_once",
    "cancelled_cancel_transport_send_reports_unknown_exactly_once",
    "cancelled_ack_transport_send_reports_unknown_exactly_once",
    "transport_unknown_primary_send_cannot_prepare_a_second_effect",
  ]) {
    assert.match(source, new RegExp(regression));
  }
  assert.match(source, /cancel_effect_attempt_started/);
  assert.match(source, /ack_effect_attempt_started/);
  assert.match(source, /final_response_effect_attempt_started/);
  assert.match(source, /connected_flow_rejects_a_destination_that_is_not_its_peer/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|sqlx::|PgPool/);
});

test("documentation leaves the remaining automatic directions and production proof unclaimed", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /ivekit\.59/);
  assert.match(readme, /200-to-CANCEL[\s\S]*remain `not_run`/i);
  assert.match(readme, /UAS-Core 2xx ACK[\s\S]*`not_run`/i);
  assert.match(readme, /production eligibility remains false/i);
});
