import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-postgres-sip-effect-repair-batch.patch";
const BUILD = "infra/converact/rustpbx/build.sh";
const README = "infra/converact/rustpbx/README.md";
const EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence-index-v1.json";
const RAW_EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence/raw/native-postgres-repair-batch-9688027-03";
const LOCK_EVIDENCE =
  "architecture-foundation/execution/goal-03/evidence/raw/native-rust-locked-library-9688027-04";

function additions(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("repair batch patch is exact and bounded by one hundred rows", () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const bytes = readFileSync(PATCH);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "18b7b9ca1248eb63a0c75d83ac231efcb3db4ed9c8c52ec255fd303dbea10f1f",
  );
  const parsed = spawnSync("git", ["apply", "--numstat", PATCH], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);

  const source = additions(bytes.toString("utf8"));
  assert.match(source, /const MAX_REPAIR_BATCH_SIZE: usize = 100/);
  assert.match(source, /const MAX_REPAIR_TOKEN_PREFIX_BYTES: usize = 128/);
  assert.match(source, /pub async fn claim_unknown_batch\(/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /LIMIT \$3/);
  assert.match(source, /repair_attempts <= 8/);
  assert.match(source, /from unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\]\)/i);
  assert.match(
    source,
    /effect\.protocol_effect_id = candidate\.candidate_effect_id/,
  );
  assert.match(source, /if due_rows\.len\(\) > usize::try_from\(limit\)/);
  assert.doesNotMatch(source, /unbounded_channel|tokio::spawn\(/);
});

test("controlled PostgreSQL evidence matches the final exact source", () => {
  const readme = readFileSync(`${RAW_EVIDENCE}/README.md`, "utf8");
  const testLog = readFileSync(`${RAW_EVIDENCE}/postgres-tests.log`, "utf8");
  const restart = readFileSync(
    `${RAW_EVIDENCE}/database-after-restart.txt`,
    "utf8",
  );
  const manifest = readFileSync(`${RAW_EVIDENCE}/host-manifest.txt`, "utf8");
  const secretScan = readFileSync(
    `${RAW_EVIDENCE}/secret-scan-status.txt`,
    "utf8",
  );

  assert.equal(
    readFileSync(`${RAW_EVIDENCE}/postgres-tests.exit-code`, "utf8").trim(),
    "0",
  );
  assert.match(readme, /Status: `verified_controlled`/);
  assert.match(
    readme,
    /Candidate source commit: `32955cb43a974d751fc2546ec38d0cad278853e2`/,
  );
  assert.match(
    manifest,
    /source_tree=387240d4b95c3580c038267e967b2495fe06829e/,
  );
  assert.match(
    manifest,
    /18b7b9ca1248eb63a0c75d83ac231efcb3db4ed9c8c52ec255fd303dbea10f1f\s+rustpbx-converact-postgres-sip-effect-repair-batch\.patch/,
  );
  assert.match(testLog, /test result: ok\. 4 passed; 0 failed/);
  assert.match(restart, /effect_state=unknown\|effect_revision=21/);
  assert.match(restart, /operator_attention=true/);
  assert.match(restart, /repair_due_cleared=true/);
  assert.match(restart, /repair_owner_cleared=true/);
  assert.match(restart, /repair_token_cleared=true/);
  assert.match(restart, /receipt_count=11/);
  assert.match(secretScan, /sensitive_file_match_count=0/);
});

test("strict Rust 1.94 evidence binds the repaired lock and exact source", () => {
  const preFix = readFileSync(`${LOCK_EVIDENCE}/pre-lock-fix.log`, "utf8");
  const strict = readFileSync(
    `${LOCK_EVIDENCE}/strict-full-library.log`,
    "utf8",
  );
  const manifest = readFileSync(`${LOCK_EVIDENCE}/host-manifest.txt`, "utf8");
  const verification = readFileSync(`${LOCK_EVIDENCE}/verification.txt`, "utf8");
  const secretScan = readFileSync(
    `${LOCK_EVIDENCE}/secret-scan-status.txt`,
    "utf8",
  );
  const artifactManifest = readFileSync(
    `${LOCK_EVIDENCE}/remote-artifacts.sha256`,
    "utf8",
  );

  for (const line of artifactManifest.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
    assert.ok(match, `invalid evidence manifest row: ${line}`);
    const [, expected, relativePath] = match;
    assert.equal(
      createHash("sha256")
        .update(readFileSync(`${LOCK_EVIDENCE}/${relativePath}`))
        .digest("hex"),
      expected,
      relativePath,
    );
  }

  assert.match(preFix, /cannot update the lock file[\s\S]*--locked was passed/);
  assert.match(
    strict,
    /test result: ok\. 1964 passed; 0 failed; 5 ignored;/,
  );
  assert.match(manifest, /rustc_version=rustc 1\.94\.1 /);
  assert.match(
    manifest,
    /cargo_lock_sha256=ae2fa0bd8475d2d86e810c2288c52bfa59f3cc72e8fde5433eda173652501a9c/,
  );
  assert.match(
    manifest,
    /postgres_adapter_sha256=40cabf1dc5290220e6c4345ce3b02a3f463dd31a5a6d4851f00e083fae7c085b/,
  );
  assert.match(
    manifest,
    /sip_effect_domain_sha256=fc0bf2870cc34e4c2a29a2e55709a476541cf381afb356a3b69aa6d92576e772/,
  );
  assert.match(
    manifest,
    /repair_batch_patch_sha256=18b7b9ca1248eb63a0c75d83ac231efcb3db4ed9c8c52ec255fd303dbea10f1f/,
  );
  assert.match(verification, /strict_result_verified=true/);
  assert.match(secretScan, /sensitive_file_match_count=0/);
  assert.equal(
    createHash("sha256")
      .update(readFileSync("infra/converact/rustpbx/Cargo.lock"))
      .digest("hex"),
    "ae2fa0bd8475d2d86e810c2288c52bfa59f3cc72e8fde5433eda173652501a9c",
  );
});

test("attempt eight becomes a durable operator-attention fact", () => {
  const source = additions(readFileSync(PATCH, "utf8"));
  assert.match(source, /SIP_EFFECT_REPAIR_ATTEMPT_CEILING: u8 = 8/);
  assert.match(source, /repair_attempts = 8/);
  assert.match(source, /repair_due_at = NULL/);
  assert.match(source, /repair_exhausted_at = statement_timestamp\(\)/);
  assert.match(source, /operator_attention_required = TRUE/);
  assert.match(source, /sip_effect_repair_exhaustion_hash\(/);
  assert.match(
    source,
    /fd547d1498fdfc68617bf81305d9bb02e5d06c166e12904bf94a2f8f4e11ac88/,
  );
  assert.match(
    source,
    /postgres_repair_batch_exhausts_after_eight_bounded_attempts/,
  );
});

test("exact build retains bounded repair batches in ivekit.57", () => {
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.62"/);
  assert.match(
    build,
    /rustpbx-converact-postgres-sip-effect-reconciliation\.patch"[\s\S]*rustpbx-converact-postgres-sip-effect-repair-batch\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-postgres-sip-effect-repair-batch\.patch/,
  );
});

test("repair batch slice leaves live native authority and host evidence not_run", () => {
  const readme = readFileSync(README, "utf8");
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
    entries: Array<{ evidence_id: string; status: string }>;
  };
  assert.match(readme, /ivekit\.54/);
  assert.match(readme, /bounded batch/i);
  assert.match(readme, /operator\s+attention/i);
  assert.match(readme, /live SIP dispatch[\s\S]*`not_run`/i);
  assert.equal(
    evidence.entries.find(
      (entry) => entry.evidence_id === "G03-E16-NATIVE-AUTHORITY",
    )?.status,
    "not_run",
  );
  assert.equal(
    evidence.entries.find(
      (entry) => entry.evidence_id === "G03-E10-FAULT",
    )?.status,
    "not_run",
  );
});
