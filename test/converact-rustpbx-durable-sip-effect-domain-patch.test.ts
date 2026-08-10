import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { canonicalSipEffectHash } from
  "../src/agent-runtime/converact/voice/sip-foundation/effect-oracle.js";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-durable-sip-effect-domain.patch";
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

test("native SipEffect freezes the shared identity and receipt semantics", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const patch = readFileSync(PATCH, "utf8");
  const source = additions(patch);
  assert.match(patch, /src\/call\/domain\/sip_effect\.rs/);
  assert.match(source, /SIP_EFFECT_SCHEMA_ID: &str = "ivekit\.sip-effect-oracle"/);
  assert.match(source, /SIP_EFFECT_SCHEMA_VERSION: u16 = 1/);
  assert.match(
    source,
    /SIP_EFFECT_WRITER_IDENTITY: &str = "unified-rustpbx\.sip-foundation"/,
  );
  assert.match(source, /pub wire_length_bytes: u32/);
  assert.match(source, /pub owner_epoch: u64/);
  assert.match(source, /pub command_sequence: u64/);
  assert.match(source, /pub fn sip_wire_freeze_sha256/);
  assert.match(source, /semantic_intent != self\.identity\.request_hash/);
  assert.match(source, /SipEffectReceiptSemantic::Accepted/);
  assert.match(source, /SipEffectReceiptSemantic::Completed/);
  assert.match(source, /SipEffectReceiptSemantic::StateObserved/);
  assert.match(source, /#\[cfg\(test\)\]\s+pub struct InMemorySipEffectLedger/);
  assert.match(source, /Production has no in-memory fallback/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|static\s+[^;]*Mutex/);
});

test("Rust fixed vectors are byte-identical to the TypeScript contract", () => {
  const wire = Buffer.from(
    "BYE sip:bob@example.test SIP/2.0\r\nContent-Length: 0\r\n\r\n",
  );
  const requestHash = "a".repeat(64);
  const routeBinding = { transport: "udp" };
  const wireAttemptFacts = {
    attempt: 1,
    semantic_intent_sha256: requestHash,
  };
  const routeBindingHash = canonicalSipEffectHash(routeBinding);
  const wireAttemptFactsHash = canonicalSipEffectHash(wireAttemptFacts);
  const wireBytesHash = createHash("sha256").update(wire).digest("hex");
  const wireFreezeSha256 = canonicalSipEffectHash({
    route_binding_sha256: routeBindingHash,
    wire_attempt_facts_sha256: wireAttemptFactsHash,
    wire_sha256: wireBytesHash,
    wire_length_bytes: wire.byteLength,
  });
  const identity = {
    tenant_id: "tenant-a",
    protocol_effect_id: "effect-a",
    protocol_session_id: "session-a",
    protocol_session_generation: "1",
    decision_id: "decision-a",
    idempotency_key: "tenant-a/session-a/1/bye/1",
    request_hash: requestHash,
    command_id: "command-a",
    adapter_identity_hash: canonicalSipEffectHash({ adapter_id: "rsipstack" }),
    wire_bytes_hash: wireBytesHash,
    wire_length_bytes: wire.byteLength,
    route_binding_hash: routeBindingHash,
    wire_attempt_facts_hash: wireAttemptFactsHash,
    wire_freeze_sha256: wireFreezeSha256,
    owner_epoch: "7",
    command_sequence: "1",
  };
  const identityHash = canonicalSipEffectHash(identity);
  const receiptHash = canonicalSipEffectHash({
    identity,
    receipt_id: "receipt-decision",
    level: "durable_decision",
    failure_code: "",
    repair_delay_ms: null,
  });
  assert.equal(
    identityHash,
    "b8f4c4aca40b76a37cf01f930801f5bd8589e34acb775a4313f2d2bb0067b508",
  );
  assert.equal(
    receiptHash,
    "23249993c72f0fdc45974516d66fea82ec64cd1a66ce9d7afe43b451311e7ff6",
  );
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, new RegExp(identityHash));
  assert.match(source, new RegExp(receiptHash));
});

test("exact build retains the shared SipEffect domain in ivekit.57", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.64"/);
  assert.match(
    build,
    /rustpbx-converact-native-call-runtime-composition\.patch"[\s\S]*rustpbx-converact-durable-sip-effect-domain\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-durable-sip-effect-domain\.patch/,
  );
});

test("domain-only slice does not promote the durable runtime evidence", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  const nativeAuthority = evidence.entries.find(
    (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
  );
  assert.match(readme, /compiled domain contract/);
  assert.match(readme, /durable PostgreSQL writer or\s+live SIP transition dispatch/);
  assert.equal(nativeAuthority?.status, "not_run");
});
