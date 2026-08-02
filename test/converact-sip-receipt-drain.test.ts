import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  SIP_FOUNDATION_CAPABILITY_IDS,
  computeBackendCapabilitySetDigest,
  createBackendCapabilitySet
} from '../src/agent-runtime/converact/voice/sip-foundation/capabilities.js';
import {
  classifyProtocolEffectReceipt
} from '../src/agent-runtime/converact/voice/sip-foundation/effect-oracle.js';
import {
  RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES,
  RsipstackFoundationAdapter
} from '../src/agent-runtime/converact/voice/sip-foundation/rsipstack-adapter.js';
import {
  SIP_WIRE_BRANCH_PLACEHOLDER
} from '../src/agent-runtime/converact/voice/sip-foundation/route-binding.js';
import {
  SipFoundationSessionRegistry
} from '../src/agent-runtime/converact/voice/sip-foundation/session-registry.js';
import type {
  BackendCapabilitySetInput,
  SipFoundationCapabilityId,
  SipRouteBinding
} from '../src/agent-runtime/converact/voice/sip-foundation/types.js';

test('persisted level/from_state tuples have non-overlapping receipt semantics', () => {
  assert.equal(classifyProtocolEffectReceipt({
    level: 'transport_accepted',
    from_state: 'send_attempted'
  }), 'accepted');
  assert.equal(classifyProtocolEffectReceipt({
    level: 'protocol_observed',
    from_state: 'transport_accepted'
  }), 'completed');
  assert.equal(classifyProtocolEffectReceipt({
    level: 'protocol_observed',
    from_state: 'send_attempted'
  }), 'completed');
  assert.equal(classifyProtocolEffectReceipt({
    level: 'protocol_observed',
    from_state: 'unknown'
  }), 'state_observed');
  assert.equal(classifyProtocolEffectReceipt({
    level: 'unknown',
    from_state: 'transport_accepted'
  }), 'unknown');
  assert.throws(
    () => classifyProtocolEffectReceipt({
      level: 'transport_accepted',
      from_state: 'unknown'
    }),
    hasCode('sip_effect_validation_failed')
  );
});

test('SipFoundation drain rejects only new sessions and exposes active-zero', () => {
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 2,
    maximum_attempts: 2
  });
  const adapter = new RsipstackFoundationAdapter(capabilitySet());
  const session = registry.openProtocolSession(adapter, {
    protocol_session_id: 'session-existing',
    session_binding: sessionBinding()
  });
  assert.deepEqual(registry.drain_status, {
    state: 'accepting',
    active_session_count: 1,
    active_attempt_count: 0
  });
  assert.deepEqual(registry.startDrain(), {
    state: 'draining',
    active_session_count: 1,
    active_attempt_count: 0
  });
  assert.equal(
    registry.openProtocolSession(adapter, {
      protocol_session_id: 'session-existing',
      session_binding: sessionBinding()
    }),
    session
  );
  assert.throws(
    () => registry.openProtocolSession(adapter, {
      protocol_session_id: 'session-new',
      session_binding: sessionBinding()
    }),
    hasCode('sip_foundation_draining')
  );

  const route = routeBinding();
  assert.doesNotThrow(() => session.prepareEffect({
    effect_id: 'effect-existing',
    command_id: 'command-existing',
    owner_epoch: '1',
    command_sequence: '1',
    route_binding: route,
    wire_attempt_facts: {
      schema_id: 'sip-foundation-wire-attempt-v1',
      schema_version: '1.0.0',
      attempt_id: 'effect-existing',
      transaction_lineage_id: 'effect-existing',
      semantic_intent_sha256: sha256('effect-existing'),
      parent_attempt_id: null,
      lineage_reason: 'transaction_root'
    },
    canonical_wire_template: sipWire(route)
  }));
  assert.equal(registry.startDrain().state, 'draining');
  registry.release(session);
  assert.deepEqual(registry.drain_status, {
    state: 'active_zero',
    active_session_count: 0,
    active_attempt_count: 0
  });
  assert.equal(registry.startDrain().state, 'active_zero');
});

function capabilitySet() {
  const supported = new Set<SipFoundationCapabilityId>(
    RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES
  );
  const payload = {
    schema_id: 'sip-foundation-backend-capability-set-v1' as const,
    schema_version: '1.0.0' as const,
    backend_id: 'rsipstack' as const,
    runtime_attestation_verification: 'not_run' as const,
    production_eligible: false as const,
    capabilities: Object.fromEntries(SIP_FOUNDATION_CAPABILITY_IDS.map((id) => [
      id,
      supported.has(id)
        ? { support: 'supported', verification: 'passed' }
        : { support: 'unsupported', verification: 'not_run' }
    ])) as BackendCapabilitySetInput['capabilities']
  };
  return createBackendCapabilitySet({
    ...payload,
    source_digest: 'a'.repeat(64),
    binary_digest: 'b'.repeat(64),
    config_digest: 'c'.repeat(64),
    capability_set_digest: computeBackendCapabilitySetDigest(payload)
  });
}

function sessionBinding() {
  return {
    schema_id: 'sip-foundation-session-binding-v1' as const,
    schema_version: '1.0.0' as const,
    route: { id: 'route-primary', revision: 1 },
    authorization_identity: null
  };
}

function routeBinding(): SipRouteBinding {
  return {
    schema_id: 'sip-foundation-route-binding-v1',
    schema_version: '1.0.0',
    route: { id: 'route-primary', revision: 1 },
    rfc3263_candidate: 'candidate-primary',
    route_set: [],
    transport: {
      id: 'transport-primary',
      protocol: 'udp',
      next_hop: { address: '192.0.2.20', port: 5060 }
    },
    local_endpoint: { address: '192.0.2.10', port: 5060 },
    advertised_via_sent_by: { host: 'voice.example.invalid', port: 5060 },
    tls_sni: null,
    authorization_identity: null,
    authorization_headers_sha256: []
  };
}

function sipWire(route: SipRouteBinding): Buffer {
  return Buffer.from([
    'OPTIONS sip:service@example.invalid SIP/2.0',
    `Via: SIP/2.0/UDP ${route.advertised_via_sent_by.host}:5060;branch=${SIP_WIRE_BRANCH_PLACEHOLDER}`,
    'From: <sip:probe@example.invalid>;tag=probe',
    'To: <sip:service@example.invalid>',
    'Call-ID: effect-existing@example.invalid',
    'CSeq: 1 OPTIONS',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n'), 'ascii');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasCode(code: string) {
  return (error: unknown) => (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
