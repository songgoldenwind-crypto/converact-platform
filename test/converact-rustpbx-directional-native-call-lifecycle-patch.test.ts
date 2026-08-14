import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-directional-native-call-lifecycle.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const CONTRACT =
  "architecture-foundation/execution/goal-03/call-leg-state-machine-v1.json";
const EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence-index-v1.json";

function additions(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("the native Call transition key includes SIP direction", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(
    readFileSync(PATCH, "utf8"),
    /src\/proxy\/active_call_registry\.rs/,
  );
  assert.match(source, /AwaitingAck/);
  assert.match(source, /AwaitingAckTerminate/);
  assert.match(source, /InboundInviteObserved/);
  assert.match(source, /Invite2xxAckObserved/);
  assert.match(source, /RemoteCancelObserved/);
  assert.match(source, /RemoteByeObserved/);
  assert.match(
    source,
    /transition\(leg\.direction, leg\.state, event\)/,
  );
  assert.match(
    source,
    /Direction::Outbound,[\s\S]*Event::Final2xx[\s\S]*Effect::Ack2xx/,
  );
  assert.match(
    source,
    /Direction::Inbound,[\s\S]*Event::Final2xx[\s\S]*State::AwaitingAck/,
  );
  assert.match(source, /leg\.direction != NativeLegDirection::Outbound/);
  assert.match(source, /incoming_direction != binding\.direction/);
  assert.match(
    source,
    /inbound_uas_and_outbound_uac_keep_ack_ownership_directional/,
  );
  assert.match(
    source,
    /authoritative_native_leg_direction_cannot_be_relabelled/,
  );
  assert.doesNotMatch(
    readFileSync(PATCH, "utf8"),
    /live_native_identity|try_upsert_slot/,
  );
  assert.doesNotMatch(
    source,
    /tokio::spawn\(|unbounded_channel|interval\(|unsafe\s*\{|Mutex|RwLock/,
  );
});

test("the versioned contract freezes UAS and UAC semantics separately", () => {
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
    version: string;
    direction_semantics: Record<string, string>;
    leg_states: string[];
    transitions: Array<{
      directions: string[];
      from: string;
      event: string;
      to: string;
      required_effect: string;
    }>;
  };
  assert.equal(contract.version, "1.1.0");
  assert.equal(contract.direction_semantics.fork, "outbound_only");
  assert.equal(
    contract.direction_semantics.registry_update,
    "authoritative_direction_immutable_fail_closed",
  );
  assert.ok(contract.leg_states.includes("awaiting_ack"));

  const outbound2xx = contract.transitions.find(
    (rule) =>
      rule.directions.length === 1 &&
      rule.directions[0] === "outbound" &&
      rule.from === "inviting" &&
      rule.event === "final_2xx",
  );
  assert.deepEqual(outbound2xx, {
    directions: ["outbound"],
    from: "inviting",
    event: "final_2xx",
    to: "confirmed",
    required_effect: "ack_2xx",
  });
  const inbound2xx = contract.transitions.find(
    (rule) =>
      rule.directions.length === 1 &&
      rule.directions[0] === "inbound" &&
      rule.from === "inviting" &&
      rule.event === "final_2xx",
  );
  assert.deepEqual(inbound2xx, {
    directions: ["inbound"],
    from: "inviting",
    event: "final_2xx",
    to: "awaiting_ack",
    required_effect: "none",
  });
});

test("ivekit.58 compiles the directional model without promoting activation", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.85"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-runtime-composition\.patch"[\s\S]*rustpbx-converact-directional-native-call-lifecycle\.patch"/,
  );
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  assert.equal(
    evidence.entries.find(
      (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
    )?.status,
    "not_run",
  );
});
