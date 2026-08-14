import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATCH =
  'infra/converact/rustpbx/patches/rustpbx-converact-durable-sip-runtime-composition.patch';
const PREDECESSOR =
  'infra/converact/rustpbx/patches/rustpbx-converact-capability-recovery-oracle.patch';
const BUILD = 'infra/converact/rustpbx/build.sh';
const PATCH_SHA256 =
  '42281dbbd689f2c3dfc64b55724b723a90471e9540e9bed9056a37919b595ea7';

function additions(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('ivekit.78 applies the Rust durable composition after the recovery oracle', () => {
  assert.equal(existsSync(PATCH), true, `${PATCH} is required`);
  assert.equal(existsSync(PREDECESSOR), true, `${PREDECESSOR} is required`);
  const patch = readFileSync(PATCH, 'utf8');
  assert.equal(createHash('sha256').update(patch).digest('hex'), PATCH_SHA256);

  const build = readFileSync(BUILD, 'utf8');
  assert.match(build, /PATCHSET="ivekit\.81"/u);
  assert.match(
    build,
    /rustpbx-converact-capability-recovery-oracle\.patch"[\s\S]*rustpbx-converact-durable-sip-runtime-composition\.patch"/u,
  );
});

test('composition is closed, default-disabled and fails startup before SIP service', () => {
  const patch = readFileSync(PATCH, 'utf8');
  const source = additions(patch);
  assert.match(source, /struct NativeSipEffectConfig/u);
  assert.match(source, /serde\(default, deny_unknown_fields\)/u);
  assert.match(source, /pub enabled: bool/u);
  assert.match(source, /validated_database_url/u);
  assert.match(source, /matches!\(scheme, "postgres" \| "postgresql"\)/u);
  assert.match(patch, /build_native_sip_effect_runtime[\s\S]*let storage_config/u);
  assert.match(source, /disabled_native_sip_effect_runtime_performs_no_database_work/u);
  assert.match(source, /native_sip_effect_configuration_cannot_change_during_live_reload/u);
  assert.match(source, /try_with_native_sip_effect_runtime/u);
  assert.match(source, /durable_native_sip_effect_runtime_cannot_be_injected_twice/u);
  assert.doesNotMatch(source, /MemorySipEffect|fallback_to_memory|fallback_to_typescript/u);
});

test('one PostgreSQL store owns send observations and recovery for the server lifetime', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /let store = Arc::new\([\s\S]*PostgresSipEffectStore::connect/u);
  assert.match(
    source,
    /DurableRsipstackEgressGate::new_postgres\([\s\S]*store\.clone\(\)/u,
  );
  assert.match(
    source,
    /let recovery_oracle: Arc<dyn NativeSipCapabilityRecoveryOracle> = store\.clone\(\)/u,
  );
  assert.match(source, /NativeSipEffectDurablePostgres/u);
  assert.match(source, /_observation_supervisor: SipEffectObservationSupervisor/u);
  assert.match(source, /parent_cancel\.is_cancelled\(\)/u);
  assert.match(source, /verify_runtime_contract/u);
  assert.match(source, /begin_tenant_transaction\("sip-foundation-startup-contract"\)/u);
  assert.match(source, /STARTUP_CONTRACT_WAIT[^;]*Duration::from_secs\(2\)/u);
  assert.match(source, /run_with_store_deadline\(STARTUP_CONTRACT_WAIT/u);
  assert.match(source, /SET LOCAL statement_timeout = '2s'/u);
  assert.match(source, /startup_contract_budget_does_not_widen_the_call_store_slo/u);
  assert.match(source, /relforcerowsecurity/u);
  assert.match(source, /has_column_privilege/u);
  assert.match(
    source,
    /ivekit_sip_effect_session_fences'[\s\S]*'SELECT'[\s\S]*ivekit_sip_effect_session_fences'[\s\S]*'INSERT'/u,
  );
  assert.match(
    source,
    /ivekit_sip_capability_recovery_receipts'[\s\S]*'SELECT'[\s\S]*ivekit_sip_capability_recovery_receipts'[\s\S]*'INSERT'/u,
  );
  assert.doesNotMatch(source, /'SELECT,INSERT'/u);
  assert.match(source, /durable_postgres_composition_connects_to_a_verified_physical_contract/u);
  assert.doesNotMatch(source, /unbounded_channel|std::thread::spawn|tokio::spawn\([^\n]*effect/u);
});

test('the slice remains functional-only and makes no activation or performance claim', () => {
  const source = additions(readFileSync(PATCH, 'utf8'));
  assert.match(source, /enabled = false/u);
  assert.match(
    source,
    /ignore = "requires an isolated PostgreSQL 16 database with migrations 001-116 and elected v2 writer"/u,
  );
  assert.doesNotMatch(
    source,
    /criterion|requests_per_second|calls_per_second|throughput_benchmark|production_eligible/u,
  );
});
