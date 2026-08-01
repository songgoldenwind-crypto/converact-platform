import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SipFoundationRecoveryError,
  evaluateSipFoundationRecoveryEligibility,
  type SipFoundationRecoverySnapshot
} from '../src/agent-runtime/converact/voice/sip-foundation/recovery.js';
import {
  SIP_FOUNDATION_CAPABILITY_IDS,
  computeBackendCapabilitySetDigest,
  createBackendCapabilitySet
} from '../src/agent-runtime/converact/voice/sip-foundation/capabilities.js';
import type {
  BackendCapabilitySet,
  BackendCapabilitySetInput,
  BackendRuntimeIdentity
} from '../src/agent-runtime/converact/voice/sip-foundation/types.js';

const CAPABILITY_SET = capabilitySet();
const SESSION_GENERATION = '018f7f19-1a2b-7c3d-8e4f-123456789abc';

function snapshot(
  override: Partial<SipFoundationRecoverySnapshot> = {}
): SipFoundationRecoverySnapshot {
  return {
    schema_version: '1.0.0',
    protocol_session_id: 'protocol-session-a',
    protocol_session_generation: SESSION_GENERATION,
    adapter_identity: runtimeIdentity(CAPABILITY_SET),
    owner_epoch: '7',
    command_sequence: '11',
    dialog_state: 'confirmed',
    quiescence: {
      active_invite_transactions: 0,
      active_non_invite_transactions: 0,
      pending_2xx_ack: false,
      pending_prack: false,
      pending_dns_lookups: 0,
      pending_candidate_attempts: 0,
      pending_connect_attempts: 0,
      active_timers: 0,
      unknown_effects: 0,
      connection_state: 'not_applicable'
    },
    captured_wall_at: '2026-07-30T00:00:00.000Z',
    deadline_policies: [{
      policy_id: 'session-refresh',
      duration_ms: 60_000,
      elapsed_ms_at_capture: 10_000
    }],
    ...override
  };
}

test('SIP recovery eligibility accepts only a confirmed quiescent dialog without claiming restore authority', () => {
  const result = evaluateSipFoundationRecoveryEligibility({
    snapshot: snapshot(),
    target_capability_set: CAPABILITY_SET,
    accepted_schema_version: '1.0.0',
    downtime_elapsed_evidence_ms: 5_000,
    ntp_offset_evidence_ms: 37
  });

  assert.deepEqual(result, {
    schema_version: '1.0.0',
    protocol_session_id: 'protocol-session-a',
    protocol_session_generation: SESSION_GENERATION,
    backend_id: 'rsipstack',
    owner_epoch: '7',
    command_sequence: '11',
    eligibility_state: 'confirmed_quiescent',
    required_authority: 'durable_session_generation_cas',
    production_eligible: false,
    deadlines: [{
      policy_id: 'session-refresh',
      deadline_after_ms: 45_000
    }],
    ntp_offset_evidence_ms: 37
  });
  assert.equal(
    JSON.stringify(result).includes('monotonic'),
    false,
    'a runtime monotonic Instant must never enter a durable or restored value'
  );
});

test('SIP foundation recovery does not let wall-clock jumps change a deadline', () => {
  const baseline = evaluateSipFoundationRecoveryEligibility({
    snapshot: snapshot(),
    target_capability_set: CAPABILITY_SET,
    accepted_schema_version: '1.0.0',
    downtime_elapsed_evidence_ms: 5_000,
    ntp_offset_evidence_ms: 0
  });
  const afterNtpJump = evaluateSipFoundationRecoveryEligibility({
    snapshot: {
      ...snapshot(),
      captured_wall_at: '2038-01-19T03:14:07.000Z'
    },
    target_capability_set: CAPABILITY_SET,
    accepted_schema_version: '1.0.0',
    downtime_elapsed_evidence_ms: 5_000,
    ntp_offset_evidence_ms: -30_000
  });

  assert.deepEqual(afterNtpJump.deadlines, baseline.deadlines);
});

test('SIP foundation recovery rejects every non-quiescent state independently', () => {
  const cases: Array<{
    name: string;
    value: SipFoundationRecoverySnapshot;
    code: string;
  }> = [
    {
      name: 'early dialog',
      value: snapshot({ dialog_state: 'early' }),
      code: 'sip_recovery_early_dialog'
    },
    {
      name: 'active INVITE transaction',
      value: snapshot({
        quiescence: {
          ...snapshot().quiescence,
          active_invite_transactions: 1
        }
      }),
      code: 'sip_recovery_active_transaction'
    },
    {
      name: 'active non-INVITE transaction',
      value: snapshot({
        quiescence: {
          ...snapshot().quiescence,
          active_non_invite_transactions: 1
        }
      }),
      code: 'sip_recovery_active_transaction'
    },
    {
      name: 'pending ACK',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, pending_2xx_ack: true }
      }),
      code: 'sip_recovery_pending_ack'
    },
    {
      name: 'pending PRACK',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, pending_prack: true }
      }),
      code: 'sip_recovery_pending_prack'
    },
    {
      name: 'active timers',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, active_timers: 1 }
      }),
      code: 'sip_recovery_active_timers'
    },
    {
      name: 'unknown effect',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, unknown_effects: 1 }
      }),
      code: 'sip_recovery_unknown_effect'
    },
    {
      name: 'pending DNS lookup',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, pending_dns_lookups: 1 }
      }),
      code: 'sip_recovery_pending_dns'
    },
    {
      name: 'pending RFC 3263 candidate',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, pending_candidate_attempts: 1 }
      }),
      code: 'sip_recovery_pending_candidate'
    },
    {
      name: 'pending connect attempt',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, pending_connect_attempts: 1 }
      }),
      code: 'sip_recovery_pending_connect'
    },
    {
      name: 'live runtime connection without reconnect receipt',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, connection_state: 'connected' }
      }),
      code: 'sip_recovery_connection_unrestorable'
    },
    {
      name: 'dead connection',
      value: snapshot({
        quiescence: { ...snapshot().quiescence, connection_state: 'dead' }
      }),
      code: 'sip_recovery_dead_connection'
    }
  ];

  for (const item of cases) {
    assert.throws(
      () => evaluateSipFoundationRecoveryEligibility({
        snapshot: item.value,
        target_capability_set: CAPABILITY_SET,
        accepted_schema_version: '1.0.0',
        downtime_elapsed_evidence_ms: 0,
        ntp_offset_evidence_ms: 0
      }),
      (error: unknown) => {
        assert.ok(error instanceof SipFoundationRecoveryError, item.name);
        assert.equal(error.code, item.code, item.name);
        return true;
      }
    );
  }
});

test('SIP foundation recovery rejects schema and adapter identity drift', () => {
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: snapshot(),
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0,
      target_protocol_session_generation: SESSION_GENERATION
    } as never),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );

  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: snapshot(),
      target_capability_set: capabilitySet('rvoip'),
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_cross_adapter_forbidden');
      return true;
    }
  );

  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: snapshot(),
      target_capability_set: capabilitySet('rsipstack', {
        config_digest: '5'.repeat(64)
      }),
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_adapter_identity_mismatch');
      return true;
    }
  );

  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: snapshot({ schema_version: '1.1.0' as '1.0.0' }),
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_schema_incompatible');
      return true;
    }
  );

  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: snapshot(),
      target_capability_set: capabilitySet('rsipstack', {}, false),
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_capability_unavailable');
      return true;
    }
  );

  const future = {
    ...snapshot(),
    schema_version: '1.1.0',
    captured_wall_at: 'not-a-timestamp'
  };
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: future as unknown as SipFoundationRecoverySnapshot,
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.1.0' as '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_schema_incompatible');
      return true;
    }
  );

  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility(Object.assign({
      snapshot: snapshot(),
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0' as const,
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }, { permit_cross_adapter: true }) as unknown as Parameters<
      typeof evaluateSipFoundationRecoveryEligibility
    >[0]),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );
});

test('SIP foundation recovery bounds deadline work and rejects persisted runtime instants', () => {
  const tooManyPolicies = Array.from({ length: 17 }, (_, index) => ({
    policy_id: `policy-${index}`,
    duration_ms: 1_000,
    elapsed_ms_at_capture: 0
  }));
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: snapshot({ deadline_policies: tooManyPolicies }),
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );

  const withRuntimeInstant = {
    ...snapshot(),
    runtime_monotonic_instant: 123
  } as SipFoundationRecoverySnapshot;
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: withRuntimeInstant,
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );

  let pendingAckReads = 0;
  const accessorQuiescence = {
    ...snapshot().quiescence
  };
  Object.defineProperty(accessorQuiescence, 'pending_2xx_ack', {
    enumerable: true,
    get() {
      pendingAckReads += 1;
      return pendingAckReads === 1;
    }
  });
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: snapshot({
        quiescence: accessorQuiescence
      }),
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );
  assert.equal(pendingAckReads, 0);

  const symbolSnapshot = snapshot() as SipFoundationRecoverySnapshot & {
    [key: symbol]: unknown;
  };
  symbolSnapshot[Symbol('shadow')] = true;
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: symbolSnapshot,
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );

  const nonEnumerableSnapshot = snapshot();
  Object.defineProperty(nonEnumerableSnapshot, 'owner_epoch', {
    enumerable: false,
    value: '7'
  });
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: nonEnumerableSnapshot,
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );

  const proxiedSnapshot = new Proxy(snapshot(), {});
  assert.throws(
    () => evaluateSipFoundationRecoveryEligibility({
      snapshot: proxiedSnapshot,
      target_capability_set: CAPABILITY_SET,
      accepted_schema_version: '1.0.0',
      downtime_elapsed_evidence_ms: 0,
      ntp_offset_evidence_ms: 0
    }),
    (error: unknown) => {
      assert.ok(error instanceof SipFoundationRecoveryError);
      assert.equal(error.code, 'sip_recovery_snapshot_invalid');
      return true;
    }
  );
});

test('SIP foundation recovery expires deadlines deterministically and returns detached data', () => {
  const inputSnapshot = snapshot();
  const result = evaluateSipFoundationRecoveryEligibility({
    snapshot: inputSnapshot,
    target_capability_set: CAPABILITY_SET,
    accepted_schema_version: '1.0.0',
    downtime_elapsed_evidence_ms: 60_000,
    ntp_offset_evidence_ms: 0
  });

  inputSnapshot.deadline_policies[0]!.duration_ms = 1;
  assert.deepEqual(result.deadlines, [{
    policy_id: 'session-refresh',
    deadline_after_ms: 0
  }]);
});

function capabilitySet(
  backendId: 'rsipstack' | 'rvoip' = 'rsipstack',
  identityOverride: Partial<Pick<
    BackendCapabilitySetInput,
    'source_digest' | 'binary_digest' | 'config_digest'
  >> = {},
  snapshotRestore = true
): BackendCapabilitySet {
  const payload = {
    schema_id: 'sip-foundation-backend-capability-set-v1' as const,
    schema_version: '1.0.0' as const,
    backend_id: backendId,
    runtime_attestation_verification: 'not_run' as const,
    production_eligible: false as const,
    capabilities: Object.fromEntries(SIP_FOUNDATION_CAPABILITY_IDS.map((capability) => [
      capability,
      capability === 'snapshot_restore' && snapshotRestore
        ? { support: 'supported', verification: 'passed' }
        : { support: 'unsupported', verification: 'not_run' }
    ])) as BackendCapabilitySetInput['capabilities']
  };
  return createBackendCapabilitySet({
    ...payload,
    source_digest: identityOverride.source_digest ?? '1'.repeat(64),
    binary_digest: identityOverride.binary_digest ?? '2'.repeat(64),
    config_digest: identityOverride.config_digest ?? '3'.repeat(64),
    capability_set_digest: computeBackendCapabilitySetDigest(payload)
  });
}

function runtimeIdentity(set: BackendCapabilitySet): BackendRuntimeIdentity {
  return {
    backend_id: set.backend_id,
    source_digest: set.source_digest,
    binary_digest: set.binary_digest,
    config_digest: set.config_digest,
    capability_set_digest: set.capability_set_digest,
    runtime_attestation_verification:
      set.runtime_attestation_verification,
    production_eligible: set.production_eligible
  };
}
