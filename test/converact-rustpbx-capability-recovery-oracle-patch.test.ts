import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-capability-recovery-oracle.patch';
const MIGRATION = 'src/migrations/116_converact_sip_capability_recovery_fence.sql';
const BUILD = 'infra/converact/rustpbx/build.sh';
const EVIDENCE =
  'architecture-foundation/execution/goal-03/evidence/raw/capability-recovery-oracle-204f4d5-17/README.md';
const PHYSICAL =
  'architecture-foundation/execution/goal-03/evidence/raw/capability-recovery-oracle-204f4d5-17/physical.sql';
const PATCH_SHA256 =
  'a56d3bbe49da1cc6f3acfc6d2e3958e21c71a502134d5da6f5f3ec1c2592a3b3';
const MIGRATION_SHA256 =
  '69eb22f100587136a9ce512dae578ab3b51d1ef515e863524079035829eb374a';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.77 applies the PostgreSQL recovery oracle after the component seam', () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.77"/u);
  assert.match(
    build,
    /rustpbx-converact-native-call-capability-recovery\.patch"[\s\S]*rustpbx-converact-capability-recovery-oracle\.patch"/u,
  );
});

test('oracle uses one fenced transaction and exactly two predecessor effect keys', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /impl NativeSipCapabilityRecoveryOracle for PostgresSipEffectStore/u);
  assert.match(source, /fence_predecessor_and_probe_capabilities/u);
  assert.match(source, /sip-cancel-ok-/u);
  assert.match(source, /sip-invite-487-/u);
  assert.match(source, /protocol_effect_id = ANY\(\$2::text\[\]\)/u);
  assert.match(source, /SIP_EFFECT_SESSION_FENCE_LOCK_SQL/u);
  assert.match(source, /ensure_effect_session_fence_locked/u);
  assert.match(source, /capability_recovery_replay_fence_matches/u);
  assert.match(
    source,
    /if let Some\(row\)[\s\S]{0,500}capability_recovery_replay_fence_matches/u,
  );
  assert.match(source, /VisibleOrAmbiguous/u);
  assert.match(source, /NoVisibleEffect/u);
  assert.match(source, /transaction\.commit\(\)/u);
  assert.doesNotMatch(source, /protocol_effect_id\s+LIKE|unbounded_channel|std::thread::spawn/u);
});

test('migration freezes tenant-scoped session fences and immutable replay receipts', () => {
  assert.equal(existsSync(MIGRATION), true, `${MIGRATION} is required`);
  const migration = readFileSync(MIGRATION, 'utf8');
  assert.equal(
    createHash('sha256').update(migration).digest('hex'),
    MIGRATION_SHA256,
  );
  assert.match(migration, /CREATE TABLE ivekit_sip_effect_session_fences/u);
  assert.match(migration, /CREATE TABLE ivekit_sip_capability_recovery_receipts/u);
  assert.match(migration, /PRIMARY KEY \(tenant_id, protocol_session_id\)/u);
  assert.match(migration, /PRIMARY KEY \(tenant_id, recovery_request_sha256\)/u);
  assert.match(migration, /outcome IN \('no_visible_effect', 'visible_or_ambiguous'\)/u);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /BEFORE INSERT ON ivekit_sip_protocol_effects/u);
  assert.match(migration, /SIP effect session fence is stale/u);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION ivekit_sip_effect_send_attempt_fence_guard/u,
  );
  assert.match(
    migration,
    /BEFORE UPDATE OF state ON ivekit_sip_protocol_effects/u,
  );
  assert.match(migration, /NEW\.state = 'send_attempted'/u);
  assert.match(migration, /OLD\.state <> 'send_attempted'/u);
  assert.match(migration, /stale SIP effect cannot enter send_attempted/u);
  assert.match(migration, /TO opc_sip_effect_executor, opc_admin/u);
  assert.match(migration, /GRANT SELECT, INSERT ON[\s\S]*ivekit_sip_capability_recovery_receipts/u);
  assert.doesNotMatch(
    migration,
    /GRANT UPDATE[\s\S]*ON ivekit_sip_capability_recovery_receipts/u,
  );
  assert.doesNotMatch(migration, /transaction_key\s+TEXT/u);
});

test('isolated server evidence stays functional-only and zero-impact', () => {
  assert.equal(existsSync(EVIDENCE), true, `${EVIDENCE} is required`);
  assert.equal(existsSync(PHYSICAL), true, `${PHYSICAL} is required`);
  const evidence = readFileSync(EVIDENCE, 'utf8');
  const physical = readFileSync(PHYSICAL, 'utf8');
  assert.match(evidence, /g03_77_capability_recovery_physical_passed/u);
  assert.match(evidence, /network=none/u);
  assert.match(evidence, /existing workload/u);
  assert.match(evidence, /Production eligible: `false`/u);
  assert.match(evidence, /Performance evidence: `false`/u);
  assert.match(evidence, /Rust adapter physical PostgreSQL ignored tests[^\n]*not executed/u);
  assert.match(evidence, /Load, CPS, latency, concurrency, capacity,[\s\S]*not run/u);
  assert.match(physical, /receipt-clean-attempt/u);
  assert.match(physical, /stale SIP effect cannot enter send_attempted/u);
  assert.match(physical, /state = 'durable_decision'/u);
  assert.match(physical, /stale send attempt was not rolled back atomically/u);
});
