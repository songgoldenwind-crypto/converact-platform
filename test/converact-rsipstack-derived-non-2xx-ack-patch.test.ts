import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-derived-non-2xx-ack.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const PATCH_SHA256 =
  "a10917ee50e38abb7a5eaa34cf3a1ffb23046be2bed77b88396b545c57010371";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.60 applies derived non-2xx ACK authority after peer observation", () => {
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
  assert.match(build, /PATCHSET="ivekit\.65"/);
  assert.match(
    build,
    /rsipstack-converact-protocol-observation\.patch"[\s\S]*rsipstack-converact-derived-non-2xx-ack\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-derived-non-2xx-ack\.patch/,
  );
});

test("automatic non-2xx ACK requires a parent-bound derived permit", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /pub enum EgressDerivedEffectKind/);
  assert.match(source, /ClientNon2xxInviteAck/);
  assert.match(source, /async fn prepare_derived\(/);
  assert.match(source, /SIP egress effect derivation is not authorized/);
  assert.match(source, /prepare_derived_egress_effect/);
  assert.match(source, /send_non_2xx_ack/);
  assert.match(
    source,
    /automatic_non_2xx_ack_uses_parent_bound_derivation_not_ordinary_prepare/,
  );
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|sqlx::|PgPool/);
});

test("cancellation and preparation failure latch reconciliation without blind fallback", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /struct EgressProtocolObservationAttempt/);
  assert.match(source, /automatic_ack_reconciliation_required/);
  assert.match(
    source,
    /cancelled_derived_ack_prepare_keeps_reconcile_latch_and_never_falls_back/,
  );
  assert.match(
    source,
    /client_derived_ack_prepare_failure_requires_reconcile_without_blind_retry/,
  );
  assert.match(source, /if gated_automatic_ack \{/);
  assert.match(source, /self\.automatic_ack_reconciliation_required = true/);
  assert.match(source, /self\.automatic_ack_reconciliation_required = false/);
});

test("documentation keeps unimplemented directions and activation unclaimed", () => {
  const readme = readFileSync(README, "utf8");
  assert.match(readme, /ivekit\.60/);
  assert.match(readme, /200-to-CANCEL[\s\S]*remain `not_run`/i);
  assert.match(readme, /UAS-Core 2xx ACK[\s\S]*`not_run`/i);
  assert.match(readme, /production eligibility remains false/i);
});
