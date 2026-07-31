import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SIP_FOUNDATION_CAPABILITY_IDS,
  backendRuntimeIdentityFromCapabilitySet,
  computeBackendCapabilitySetDigest,
  createBackendCapabilitySet,
  selectSipFoundationAdapter,
  validateBackendRuntimeIdentity
} from '../src/agent-runtime/converact/voice/sip-foundation/capabilities.js';
import {
  RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES,
  RsipstackFoundationAdapter,
  decodePreparedWireBytes
} from '../src/agent-runtime/converact/voice/sip-foundation/rsipstack-adapter.js';
import {
  SipFoundationSessionRegistry
} from '../src/agent-runtime/converact/voice/sip-foundation/session-registry.js';
import {
  SIP_WIRE_BRANCH_PLACEHOLDER,
  sipRouteBindingSha256,
  sipWireAttemptFactsSha256,
  sipWireFreezeSha256
} from '../src/agent-runtime/converact/voice/sip-foundation/route-binding.js';
import {
  SipFoundationError,
  type BackendCapabilitySet,
  type BackendCapabilitySetInput,
  type SipFoundationAdapterSelection,
  type SipFoundationCapabilityId,
  type SipProtocolSessionBinding,
  type SipRouteBinding
} from '../src/agent-runtime/converact/voice/sip-foundation/types.js';

const SOURCE_DIGEST = 'a'.repeat(64);
const BINARY_DIGEST = 'b'.repeat(64);
const CONFIG_DIGEST = 'c'.repeat(64);

test('capability digest helper canonicalizes the closed payload without mutating it', () => {
  const input = capabilitySetInput();
  const reversedCapabilities = Object.fromEntries(
    [...SIP_FOUNDATION_CAPABILITY_IDS]
      .reverse()
      .map((id) => [id, input.capabilities[id]])
  ) as BackendCapabilitySetInput['capabilities'];
  const reversed = {
    schema_id: input.schema_id,
    schema_version: input.schema_version,
    backend_id: input.backend_id,
    runtime_attestation_verification:
      input.runtime_attestation_verification,
    production_eligible: input.production_eligible,
    capabilities: reversedCapabilities
  };

  assert.equal(
    computeBackendCapabilitySetDigest(capabilityPayload(input)),
    computeBackendCapabilitySetDigest(reversed)
  );
  assert.match(computeBackendCapabilitySetDigest(reversed), /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(reversed.capabilities), [...SIP_FOUNDATION_CAPABILITY_IDS].reverse());
});

test('BackendCapabilitySet is closed, versioned, cloned and deeply immutable', () => {
  const input = capabilitySetInput();
  const capabilitySet = createBackendCapabilitySet(input);

  assert.equal(capabilitySet.schema_id, 'sip-foundation-backend-capability-set-v1');
  assert.equal(capabilitySet.schema_version, '1.0.0');
  assert.equal(capabilitySet.source_digest, SOURCE_DIGEST);
  assert.equal(capabilitySet.binary_digest, BINARY_DIGEST);
  assert.equal(capabilitySet.runtime_attestation_verification, 'not_run');
  assert.equal(capabilitySet.production_eligible, false);
  assert.throws(
    () => createBackendCapabilitySet({
      ...input,
      runtime_attestation_verification: 'passed',
      production_eligible: true
    }),
    hasCode('sip_foundation_capability_set_invalid')
  );
  assert.equal(capabilitySet.config_digest, CONFIG_DIGEST);
  assert.equal(
    capabilitySet.capability_set_digest,
    computeBackendCapabilitySetDigest(capabilityPayload(input))
  );
  assert.deepEqual(Object.keys(capabilitySet.capabilities).sort(), [...SIP_FOUNDATION_CAPABILITY_IDS].sort());
  assert.equal(Object.isFrozen(capabilitySet), true);
  assert.equal(Object.isFrozen(capabilitySet.capabilities), true);
  assert.equal(Object.isFrozen(capabilitySet.capabilities.prepare_effect), true);

  input.capabilities.prepare_effect.support = 'unsupported';
  assert.equal(capabilitySet.capabilities.prepare_effect.support, 'supported');

  const missing = capabilitySetInput();
  delete (missing.capabilities as Record<string, unknown>).prepare_effect;
  assert.throws(
    () => createBackendCapabilitySet(missing),
    hasCode('sip_foundation_capability_set_invalid')
  );

  const unexpected = capabilitySetInput() as BackendCapabilitySetInput & {
    capabilities: Record<string, unknown>;
  };
  unexpected.capabilities.unregistered_runtime_escape = {
    support: 'supported',
    verification: 'passed'
  };
  assert.throws(
    () => createBackendCapabilitySet(unexpected),
    hasCode('sip_foundation_capability_set_invalid')
  );

  const forged = capabilitySetInput();
  forged.capability_set_digest = 'f'.repeat(64);
  assert.throws(
    () => createBackendCapabilitySet(forged),
    hasCode('sip_foundation_capability_set_digest_invalid')
  );

  const tampered = capabilitySetInput();
  tampered.capabilities.prepare_effect.support = 'unsupported';
  assert.throws(
    () => createBackendCapabilitySet(tampered),
    hasCode('sip_foundation_capability_set_digest_invalid')
  );

  const coercible = capabilitySetInput();
  coercible.capabilities.prepare_effect.support = {
    toString: () => 'supported'
  } as unknown as 'supported';
  assert.throws(
    () => createBackendCapabilitySet(coercible),
    hasCode('sip_foundation_capability_set_invalid')
  );

  let capabilityDigestReads = 0;
  const accessorCapabilitySet = capabilitySetInput();
  Object.defineProperty(accessorCapabilitySet, 'source_digest', {
    enumerable: true,
    get() {
      capabilityDigestReads += 1;
      return capabilityDigestReads === 1
        ? SOURCE_DIGEST
        : 'not-a-digest';
    }
  });
  assert.throws(
    () => createBackendCapabilitySet(accessorCapabilitySet),
    hasCode('sip_foundation_capability_set_invalid')
  );
  assert.equal(capabilityDigestReads, 0);

  let identityDigestReads = 0;
  const accessorIdentity = {
    ...backendRuntimeIdentityFromCapabilitySet(capabilitySet)
  };
  Object.defineProperty(accessorIdentity, 'source_digest', {
    enumerable: true,
    get() {
      identityDigestReads += 1;
      return identityDigestReads === 1
        ? SOURCE_DIGEST
        : 'not-a-digest';
    }
  });
  assert.throws(
    () => validateBackendRuntimeIdentity(accessorIdentity),
    hasCode('sip_foundation_input_invalid')
  );
  assert.equal(identityDigestReads, 0);
});

test('selection binds exactly one eligible adapter to a Protocol Session', () => {
  const adapter = new RsipstackFoundationAdapter(capabilitySet());
  const selection = selectionFor(adapter.capability_set);
  const selected = selectSipFoundationAdapter(selection, [adapter]);
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 8,
    maximum_attempts: 512
  });
  const route = routeBinding();
  const session = registry.openProtocolSession(selected, {
    protocol_session_id: 'protocol-session-1',
    session_binding: sessionBinding(route)
  });

  assert.equal(session.backend_id, 'rsipstack');
  assert.deepEqual(
    session.adapter_identity,
    backendRuntimeIdentityFromCapabilitySet(adapter.capability_set)
  );
  assert.equal(session.protocol_session_id, 'protocol-session-1');
  assert.equal(Object.isFrozen(session.session_binding), true);
  assert.deepEqual(session.session_binding, sessionBinding(route));

  assert.throws(
    () => selectSipFoundationAdapter(selection, [adapter, adapter]),
    hasCode('sip_foundation_adapter_ambiguous')
  );
  assert.throws(
    () => selectSipFoundationAdapter(selection, []),
    hasCode('sip_foundation_adapter_not_found')
  );
  assert.throws(
    () => selectSipFoundationAdapter({
      ...selection,
      require_production_eligible: true
    }, [adapter]),
    hasCode('sip_foundation_runtime_attestation_unverified')
  );

  const shadowedSelection = Object.assign(selectionFor(adapter.capability_set), {
    runtime_digest: BINARY_DIGEST
  });
  assert.throws(
    () => selectSipFoundationAdapter(shadowedSelection, [adapter]),
    hasCode('sip_foundation_input_invalid')
  );

  let iteratorCalls = 0;
  const attackerControlledRequired: SipFoundationCapabilityId[] = [];
  Object.defineProperty(attackerControlledRequired, Symbol.iterator, {
    enumerable: false,
    value() {
      iteratorCalls += 1;
      return {
        next: () => ({ done: false, value: 'prepare_effect' })
      };
    }
  });
  assert.throws(
    () => selectSipFoundationAdapter({
      ...selection,
      required_capabilities: attackerControlledRequired
    }, [adapter]),
    hasCode('sip_foundation_input_invalid')
  );
  assert.equal(iteratorCalls, 0);

  let proxyLengthReads = 0;
  const proxiedRequired = new Proxy([] as SipFoundationCapabilityId[], {
    get(target, property, receiver) {
      if (property === 'length') proxyLengthReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => selectSipFoundationAdapter({
      ...selection,
      required_capabilities: proxiedRequired
    }, [adapter]),
    hasCode('sip_foundation_input_invalid')
  );
  assert.equal(proxyLengthReads, 0);

  let adapterFilterCalls = 0;
  const attackerControlledAdapters = [adapter];
  Object.defineProperty(attackerControlledAdapters, 'filter', {
    enumerable: true,
    value() {
      adapterFilterCalls += 1;
      return [adapter];
    }
  });
  assert.throws(
    () => selectSipFoundationAdapter(
      selection,
      attackerControlledAdapters
    ),
    hasCode('sip_foundation_input_invalid')
  );
  assert.equal(adapterFilterCalls, 0);
  assert.equal(Object.isFrozen(SIP_FOUNDATION_CAPABILITY_IDS), true);
});

test('Protocol Session registry is bounded, idempotent and rejects identity or route drift', () => {
  const firstSet = capabilitySet();
  const first = new RsipstackFoundationAdapter(firstSet);
  const secondInput = capabilitySetInput();
  secondInput.binary_digest = 'd'.repeat(64);
  const second = new RsipstackFoundationAdapter(createBackendCapabilitySet(secondInput));
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 1,
    maximum_attempts: 8
  });
  const input = {
    protocol_session_id: 'protocol-session-authority',
    session_binding: sessionBinding(routeBinding())
  };
  assert.throws(
    () => first.createProtocolSession(
      input,
      {
        generation: 'fake-generation',
        assertActive() {},
        reserveAttempt() {}
      }
    ),
    hasCode('sip_foundation_input_invalid')
  );
  const failingAdapter = {
    ...first,
    createProtocolSession(
      _input: typeof input,
      lease: {
        reserveAttempt(): void;
      }
    ) {
      lease.reserveAttempt();
      throw new Error('injected adapter construction failure');
    }
  };
  assert.throws(
    () => registry.openProtocolSession(failingAdapter as never, input),
    /injected adapter construction failure/
  );
  assert.equal(registry.active_attempt_count, 0);
  assert.equal(registry.active_session_count, 0);
  let backendAuthorityReads = 0;
  const backendCandidate = {
    prepareEffect() {
      throw new Error('not exercised');
    },
    verifyPreparedEffect() {
      throw new Error('not exercised');
    }
  } as Record<string, unknown>;
  Object.defineProperty(backendCandidate, 'protocol_session_id', {
    enumerable: true,
    get() {
      backendAuthorityReads += 1;
      return 'backend-controlled-session-id';
    }
  });
  Object.freeze(backendCandidate);
  const backendOwnedStateAdapter = {
    backend_id: first.backend_id,
    runtime_identity: first.runtime_identity,
    capability_set: first.capability_set,
    createProtocolSession() {
      return backendCandidate;
    }
  };
  const detachedRegistry = new SipFoundationSessionRegistry({
    maximum_sessions: 1,
    maximum_attempts: 1
  });
  const detached = detachedRegistry.openProtocolSession(
    backendOwnedStateAdapter as never,
    {
      protocol_session_id: 'registry-owned-session-id',
      session_binding: sessionBinding(routeBinding())
    }
  );
  assert.equal(detached.protocol_session_id, 'registry-owned-session-id');
  assert.equal(detached.backend_id, first.backend_id);
  assert.equal(backendAuthorityReads, 0);
  assert.notEqual(detached, backendCandidate);
  assert.equal(Object.isFrozen(detached), true);
  detachedRegistry.release(detached);
  const mutableBackendAdapter = {
    ...backendOwnedStateAdapter,
    createProtocolSession() {
      return {
        prepareEffect() {
          throw new Error('not exercised');
        },
        verifyPreparedEffect() {
          throw new Error('not exercised');
        }
      };
    }
  };
  assert.throws(
    () => detachedRegistry.openProtocolSession(
      mutableBackendAdapter as never,
      {
        protocol_session_id: 'mutable-backend-session',
        session_binding: sessionBinding(routeBinding())
      }
    ),
    hasCode('sip_foundation_adapter_identity_mismatch')
  );
  const originalPrototypeOpen =
    SipFoundationSessionRegistry.prototype.openProtocolSession;
  assert.equal(
    Reflect.set(
      SipFoundationSessionRegistry.prototype,
      'openProtocolSession',
      () => {
        throw new Error('registry open must not be replaceable');
      }
    ),
    false
  );
  assert.equal(
    SipFoundationSessionRegistry.prototype.openProtocolSession,
    originalPrototypeOpen
  );
  const original = registry.openProtocolSession(first, {
    protocol_session_id: 'protocol-session-authority',
    session_binding: sessionBinding(routeBinding())
  });
  const replay = registry.openProtocolSession(first, {
    protocol_session_id: 'protocol-session-authority',
    session_binding: sessionBinding(routeBinding())
  });

  assert.equal(replay, original);
  assert.equal(registry.active_session_count, 1);
  assert.throws(
    () => registry.openProtocolSession(second, {
      protocol_session_id: 'protocol-session-authority',
      session_binding: sessionBinding(routeBinding())
    }),
    hasCode('sip_foundation_session_identity_conflict')
  );

  const changedRoute = routeBinding();
  changedRoute.route.revision += 1;
  assert.throws(
    () => registry.openProtocolSession(first, {
      protocol_session_id: 'protocol-session-authority',
      session_binding: sessionBinding(changedRoute)
    }),
    hasCode('sip_foundation_session_binding_conflict')
  );
  assert.throws(
    () => registry.openProtocolSession(first, {
      protocol_session_id: 'protocol-session-capacity',
      session_binding: sessionBinding(routeBinding())
    }),
    hasCode('sip_foundation_session_capacity_exhausted')
  );

  const preparedBeforeRelease = original.prepareEffect({
    effect_id: 'effect-before-release',
    command_id: 'command-before-release',
    owner_epoch: '1',
    command_sequence: '1',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('effect-before-release'),
    canonical_wire_template: sipWire(wireAttempt('effect-before-release'))
  });
  assert.equal(registry.active_attempt_count, 1);
  registry.release(original);
  assert.equal(registry.active_session_count, 0);
  assert.equal(registry.active_attempt_count, 0);
  assert.throws(
    () => original.prepareEffect({
      effect_id: 'effect-after-release',
      command_id: 'command-after-release',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-after-release'),
      canonical_wire_template: sipWire(wireAttempt('effect-after-release'))
    }),
    hasCode('sip_foundation_session_closed')
  );
  assert.throws(
    () => decodePreparedWireBytes(preparedBeforeRelease, original),
    hasCode('sip_foundation_session_closed')
  );
  assert.throws(
    () => registry.verifyPreparedEffect(preparedBeforeRelease),
    hasCode('sip_foundation_session_closed')
  );
  const successor = registry.openProtocolSession(second, {
    protocol_session_id: 'protocol-session-authority',
    session_binding: sessionBinding(routeBinding())
  });
  assert.notEqual(
    successor.protocol_session_generation,
    original.protocol_session_generation
  );
  assert.throws(
    () => decodePreparedWireBytes(preparedBeforeRelease, successor),
    hasCode('sip_foundation_wire_invalid')
  );
});

test('Protocol Session registry applies an O(1) global attempt budget and releases it with the session', () => {
  const adapter = new RsipstackFoundationAdapter(capabilitySet());
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 2,
    maximum_attempts: 1
  });
  const first = registry.openProtocolSession(adapter, {
    protocol_session_id: 'protocol-session-budget-a',
    session_binding: sessionBinding(routeBinding())
  });
  const second = registry.openProtocolSession(adapter, {
    protocol_session_id: 'protocol-session-budget-b',
    session_binding: sessionBinding(routeBinding())
  });
  first.prepareEffect({
    effect_id: 'effect-budget-a',
    command_id: 'command-budget-a',
    owner_epoch: '1',
    command_sequence: '1',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('effect-budget-a'),
    canonical_wire_template: sipWire(wireAttempt('effect-budget-a'))
  });
  assert.equal(registry.active_attempt_count, 1);
  assert.throws(
    () => second.prepareEffect({
      effect_id: 'effect-budget-b',
      command_id: 'command-budget-b',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-budget-b'),
      canonical_wire_template: sipWire(wireAttempt('effect-budget-b'))
    }),
    hasCode('sip_foundation_session_capacity_exhausted')
  );
  registry.release(first);
  assert.equal(registry.active_attempt_count, 0);
  second.prepareEffect({
    effect_id: 'effect-budget-b',
    command_id: 'command-budget-b',
    owner_epoch: '1',
    command_sequence: '1',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('effect-budget-b'),
    canonical_wire_template: sipWire(wireAttempt('effect-budget-b'))
  });
  assert.equal(registry.active_attempt_count, 1);
});

test('the adapter owns collision-resistant Via branches across live Protocol Sessions', () => {
  const adapter = new RsipstackFoundationAdapter(capabilitySet());
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 2,
    maximum_attempts: 2
  });
  const first = registry.openProtocolSession(adapter, {
    protocol_session_id: 'branch-session-a',
    session_binding: sessionBinding(routeBinding())
  });
  const second = registry.openProtocolSession(adapter, {
    protocol_session_id: 'branch-session-b',
    session_binding: sessionBinding(routeBinding())
  });
  const prepare = (session: typeof first) => session.prepareEffect({
    effect_id: 'shared-caller-effect-id',
    command_id: 'shared-command-id',
    owner_epoch: '1',
    command_sequence: '1',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('shared-caller-effect-id'),
    canonical_wire_template: sipWire(wireAttempt('shared-caller-effect-id'))
  });
  const firstPrepared = prepare(first);
  const secondPrepared = prepare(second);
  assert.notEqual(
    firstPrepared.wire_attempt_facts.via_branch,
    secondPrepared.wire_attempt_facts.via_branch
  );
  assert.notEqual(
    firstPrepared.wire_attempt_facts.via_branch,
    SIP_WIRE_BRANCH_PLACEHOLDER
  );
  assert.match(
    firstPrepared.wire_attempt_facts.via_branch,
    /^z9hG4bK-opc-[a-f0-9]{40}$/
  );
});

test('selection fails closed for unsupported, unknown and unverified required capabilities', () => {
  for (const [state, code] of [
    [
      { support: 'unsupported', verification: 'passed' },
      'sip_foundation_capability_unsupported'
    ],
    [
      { support: 'unknown', verification: 'passed' },
      'sip_foundation_capability_unknown'
    ],
    [
      { support: 'supported', verification: 'not_run' },
      'sip_foundation_capability_unverified'
    ],
    [
      { support: 'supported', verification: 'failed' },
      'sip_foundation_capability_unverified'
    ]
  ] as const) {
    const input = capabilitySetInput();
    input.capabilities.prepare_effect = state;
    input.capability_set_digest = computeBackendCapabilitySetDigest(capabilityPayload(input));
    const capabilitySet = createBackendCapabilitySet(input);
    const adapter = new RsipstackFoundationAdapter(capabilitySet);
    assert.throws(
      () => selectSipFoundationAdapter(
        selectionFor(capabilitySet, ['prepare_effect']),
        [adapter]
      ),
      hasCode(code),
      `${state.support}/${state.verification}`
    );
  }

  const baselineSet = capabilitySet();
  const baselineAdapter = new RsipstackFoundationAdapter(baselineSet);
  assert.equal(
    baselineSet.capabilities.owner_fence.support,
    'unsupported',
    'the adapter only carries fence fields; the durable effect oracle owns fencing'
  );
  assert.equal(baselineSet.capabilities.owner_fence.verification, 'not_run');
  assert.throws(
    () => selectSipFoundationAdapter(
      selectionFor(baselineSet, ['owner_fence']),
      [baselineAdapter]
    ),
    hasCode('sip_foundation_capability_unsupported')
  );
});

test('selection compares every authoritative runtime capability identity digest', () => {
  const set = capabilitySet();
  const adapter = new RsipstackFoundationAdapter(set);
  for (const [field, code] of [
    ['source_digest', 'sip_foundation_source_identity_mismatch'],
    ['binary_digest', 'sip_foundation_runtime_identity_mismatch'],
    ['config_digest', 'sip_foundation_config_identity_mismatch'],
    ['capability_set_digest', 'sip_foundation_capability_set_identity_mismatch']
  ] as const) {
    const selection = {
      ...selectionFor(set),
      [field]: 'd'.repeat(64)
    };
    assert.throws(
      () => selectSipFoundationAdapter(selection, [adapter]),
      hasCode(code),
      field
    );
  }
});

test('prepare freezes exact wire identity, route binding, owner epoch and command sequence', () => {
  const adapter = new RsipstackFoundationAdapter(capabilitySet());
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 8,
    maximum_attempts: 512
  });
  const route = routeBinding();
  const session = registry.openProtocolSession(adapter, {
    protocol_session_id: 'protocol-session-2',
    session_binding: sessionBinding(route)
  });
  const wire = sipWire(wireAttempt('effect-1'), route, 'INVITE');
  const prepared = session.prepareEffect({
    effect_id: 'effect-1',
    command_id: 'command-1',
    owner_epoch: '42',
    command_sequence: '7',
    route_binding: route,
    wire_attempt_facts: wireAttempt('effect-1'),
    canonical_wire_template: wire
  });

  route.route.revision = 99;
  route.transport.next_hop.address = '2001:db8::99';
  wire.fill(0);

  const expectedWire = materializeSipWire(
    sipWire(wireAttempt('effect-1'), prepared.route_binding, 'INVITE'),
    prepared.wire_attempt_facts.via_branch
  );

  assert.equal(prepared.wire_identity.protocol_session_id, 'protocol-session-2');
  assert.equal(
    prepared.wire_identity.protocol_session_generation,
    session.protocol_session_generation
  );
  assert.notEqual(
    prepared.wire_attempt_facts.via_branch,
    SIP_WIRE_BRANCH_PLACEHOLDER
  );
  assert.equal(prepared.wire_identity.effect_id, 'effect-1');
  assert.equal(prepared.wire_identity.command_id, 'command-1');
  assert.equal(prepared.wire_identity.owner_epoch, '42');
  assert.equal(prepared.wire_identity.command_sequence, '7');
  assert.deepEqual(prepared.adapter_identity, session.adapter_identity);
  assert.equal(
    prepared.wire_identity.wire_sha256,
    createHash('sha256').update(expectedWire).digest('hex')
  );
  assert.equal(
    prepared.wire_identity.route_binding_sha256,
    sipRouteBindingSha256(prepared.route_binding)
  );
  assert.equal(
    prepared.wire_identity.wire_attempt_facts_sha256,
    sipWireAttemptFactsSha256(prepared.wire_attempt_facts)
  );
  assert.equal(
    prepared.wire_identity.wire_freeze_sha256,
    sipWireFreezeSha256({
      route_binding_sha256: prepared.wire_identity.route_binding_sha256,
      wire_attempt_facts_sha256:
        prepared.wire_identity.wire_attempt_facts_sha256,
      wire_sha256: prepared.wire_identity.wire_sha256,
      wire_length_bytes: prepared.wire_identity.wire_length_bytes
    })
  );
  assert.equal(prepared.wire_identity.wire_length_bytes, expectedWire.byteLength);
  assert.equal(prepared.route_binding.route.revision, 3);
  assert.equal(
    prepared.route_binding.transport.next_hop.address,
    '2001:db8::20'
  );
  assert.deepEqual(decodePreparedWireBytes(prepared, session), expectedWire);
  assert.deepEqual(registry.verifyPreparedEffect(prepared), expectedWire);
  assert.throws(
    () => registry.verifyPreparedEffect(structuredClone(prepared)),
    hasCode('sip_foundation_wire_invalid')
  );

  const decoded = decodePreparedWireBytes(prepared, session);
  decoded.fill(0);
  assert.deepEqual(decodePreparedWireBytes(prepared, session), expectedWire);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.wire_identity), true);
  assert.equal(Object.isFrozen(prepared.route_binding.transport.next_hop), true);
  assert.equal(Object.isFrozen(prepared.route_binding.route_set), true);
  assert.equal(Object.isFrozen(prepared.wire_attempt_facts), true);
  assert.match(expectedWire.toString('utf8'), /测试用户/u);

  const authenticatedRoute = routeBinding();
  const authorizationHeaders = [
    {
      name: 'Authorization' as const,
      value:
        'Digest username="trunk-a", realm="carrier.example", response="abc"'
    },
    {
      name: 'Proxy-Authorization' as const,
      value:
        'Digest username="trunk-a", realm="proxy.example", response="def"'
    }
  ];
  authenticatedRoute.authorization_headers_sha256 =
    authorizationHeaders.map((header) =>
      createHash('sha256')
        .update(header.name.toLowerCase())
        .update(':')
        .update(header.value)
        .digest('hex')
    );
  const authenticated = session.prepareEffect({
    effect_id: 'effect-authenticated-wire',
    command_id: 'command-authenticated-wire',
    owner_epoch: '42',
    command_sequence: '8',
    route_binding: authenticatedRoute,
    wire_attempt_facts: wireAttempt('effect-authenticated-wire'),
    canonical_wire_template: sipWire(
      wireAttempt('effect-authenticated-wire'),
      authenticatedRoute,
      'OPTIONS',
      undefined,
      authorizationHeaders
    )
  });
  assert.deepEqual(
    authenticated.route_binding.authorization_headers_sha256,
    authenticatedRoute.authorization_headers_sha256
  );
  const disconnectedAuthorization = routeBinding();
  disconnectedAuthorization.authorization_headers_sha256 =
    authenticatedRoute.authorization_headers_sha256;
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-missing-authorization-wire',
      command_id: 'command-missing-authorization-wire',
      owner_epoch: '42',
      command_sequence: '9',
      route_binding: disconnectedAuthorization,
      wire_attempt_facts: wireAttempt('effect-missing-authorization-wire'),
      canonical_wire_template: sipWire(
        wireAttempt('effect-missing-authorization-wire'),
        disconnectedAuthorization
      )
    }),
    hasCode('sip_foundation_wire_invalid')
  );

  const cloned = structuredClone(prepared);
  (cloned.route_binding.route as { id: string }).id = 'clone-mutated';
  assert.equal(prepared.route_binding.route.id, 'route-primary');
});

test('route, fence, identity and wire inputs are bounded with stable error codes', () => {
  const adapter = new RsipstackFoundationAdapter(capabilitySet());
  const registry = new SipFoundationSessionRegistry({
    maximum_sessions: 32,
    maximum_attempts: 512
  });
  assert.throws(
    () => registry.openProtocolSession(adapter, {
      protocol_session_id: 'x'.repeat(129),
      session_binding: sessionBinding(routeBinding())
    }),
    hasCode('sip_foundation_input_invalid')
  );
  const invalidSessionBinding = sessionBinding(routeBinding());
  invalidSessionBinding.route.id = '';
  assert.throws(
    () => registry.openProtocolSession(adapter, {
      protocol_session_id: 'protocol-session-3',
      session_binding: invalidSessionBinding
    }),
    hasCode('sip_foundation_route_binding_invalid')
  );
  const zeroRevision = sessionBinding(routeBinding());
  zeroRevision.route.revision = 0;
  assert.throws(
    () => registry.openProtocolSession(adapter, {
      protocol_session_id: 'protocol-session-zero-revision',
      session_binding: zeroRevision
    }),
    hasCode('sip_foundation_route_binding_invalid')
  );
  for (const addShadowField of [
    (binding: SipProtocolSessionBinding) =>
      Object.assign(binding, { shadow_route: true }),
    (binding: SipProtocolSessionBinding) =>
      Object.assign(binding.route, { shadow_revision: 4 })
  ]) {
    const shadowedBinding = sessionBinding(routeBinding());
    addShadowField(shadowedBinding);
    assert.throws(
      () => registry.openProtocolSession(adapter, {
        protocol_session_id: 'protocol-session-shadowed-route',
        session_binding: shadowedBinding
      }),
      hasCode('sip_foundation_route_binding_invalid')
    );
  }

  const session = registry.openProtocolSession(adapter, {
    protocol_session_id: 'protocol-session-4',
    session_binding: sessionBinding(routeBinding())
  });
  const invalidEffectRoute = routeBinding();
  invalidEffectRoute.local_endpoint.address = 'not-an-ip-address';
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-invalid-route',
      command_id: 'command-invalid-route',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: invalidEffectRoute,
      wire_attempt_facts: wireAttempt('effect-invalid-route'),
      canonical_wire_template: sipWire(wireAttempt('effect-invalid-route'))
    }),
    hasCode('sip_foundation_route_binding_invalid')
  );
  const shadowedEffectRoute = routeBinding();
  Object.assign(shadowedEffectRoute.transport.next_hop, {
    shadow_host: 'attacker.invalid'
  });
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-shadowed-route',
      command_id: 'command-shadowed-route',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: shadowedEffectRoute,
      wire_attempt_facts: wireAttempt('effect-shadowed-route'),
      canonical_wire_template: sipWire(wireAttempt('effect-shadowed-route'))
    }),
    hasCode('sip_foundation_route_binding_invalid')
  );
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-missing-parent',
      command_id: 'command-missing-parent',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt(
        'effect-missing-parent',
        'effect-does-not-exist'
      ),
      canonical_wire_template: sipWire(wireAttempt(
        'effect-missing-parent',
        'effect-does-not-exist'
      ))
    }),
    hasCode('sip_foundation_wire_attempt_invalid')
  );
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-2',
      command_id: 'command-2',
      owner_epoch: '18446744073709551616',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-2'),
      canonical_wire_template: sipWire(wireAttempt('effect-2'))
    }),
    hasCode('sip_foundation_fence_invalid')
  );
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-3',
      command_id: 'command-3',
      owner_epoch: '1',
      command_sequence: '0',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-3'),
      canonical_wire_template: sipWire(wireAttempt('effect-3'))
    }),
    hasCode('sip_foundation_fence_invalid')
  );
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-numeric-fence',
      command_id: 'command-numeric-fence',
      owner_epoch: 1 as unknown as string,
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-numeric-fence'),
      canonical_wire_template: sipWire(wireAttempt('effect-numeric-fence'))
    }),
    hasCode('sip_foundation_fence_invalid')
  );
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-leading-zero',
      command_id: 'command-leading-zero',
      owner_epoch: '01',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-leading-zero'),
      canonical_wire_template: sipWire(wireAttempt('effect-leading-zero'))
    }),
    hasCode('sip_foundation_fence_invalid')
  );
  assert.throws(
    () => session.prepareEffect(Object.assign({
      effect_id: 'effect-extra',
      command_id: 'command-extra',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-extra'),
      canonical_wire_template: sipWire(wireAttempt('effect-extra'))
    }, { shadow_send: true })),
    hasCode('sip_foundation_input_invalid')
  );
  const maximumWire = session.prepareEffect({
    effect_id: 'effect-maximum-wire',
    command_id: 'command-maximum-wire',
    owner_epoch: '18446744073709551615',
    command_sequence: '18446744073709551615',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('effect-maximum-wire'),
    canonical_wire_template: sipWire(
      wireAttempt('effect-maximum-wire'),
      routeBinding(),
      'OPTIONS',
      65_535
    )
  });
  assert.equal(
    decodePreparedWireBytes(maximumWire, session).byteLength,
    65_535
  );
  assert.equal(registry.active_attempt_count, 1);
  const oversizedBodyHeaders = sipWire(
    wireAttempt('effect-oversized-body')
  ).toString('utf8').replace(
    'Content-Length: 0',
    'Content-Length: 32769'
  );
  const oversizedBody = Buffer.concat([
    Buffer.from(oversizedBodyHeaders, 'utf8'),
    Buffer.alloc(32_769)
  ]);
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-oversized-body',
      command_id: 'command-oversized-body',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-oversized-body'),
      canonical_wire_template: oversizedBody
    }),
    hasCode('sip_foundation_wire_invalid')
  );
  assert.equal(registry.active_attempt_count, 1);
  const wireLimitCases = [
    {
      id: 'header-count',
      template: insertSipHeaders(
        sipWire(wireAttempt('effect-header-count')),
        Array.from({ length: 125 }, (_, index) =>
          `X-Count-${index}: value`
        )
      )
    },
    {
      id: 'header-line',
      template: insertSipHeaders(
        sipWire(wireAttempt('effect-header-line')),
        [`X-Oversized: ${'x'.repeat(8_180)}`]
      )
    },
    {
      id: 'header-section',
      template: insertSipHeaders(
        sipWire(wireAttempt('effect-header-section')),
        Array.from({ length: 5 }, (_, index) =>
          `X-Section-${index}: ${'x'.repeat(7_000)}`
        )
      )
    }
  ];
  for (const wireLimitCase of wireLimitCases) {
    assert.throws(
      () => session.prepareEffect({
        effect_id: `effect-${wireLimitCase.id}`,
        command_id: `command-${wireLimitCase.id}`,
        owner_epoch: '1',
        command_sequence: '1',
        route_binding: routeBinding(),
        wire_attempt_facts: wireAttempt(`effect-${wireLimitCase.id}`),
        canonical_wire_template: wireLimitCase.template
      }),
      hasCode('sip_foundation_wire_invalid'),
      wireLimitCase.id
    );
  }
  assert.equal(registry.active_attempt_count, 1);
  const mismatchedIntent = wireAttempt(
    'effect-mismatched-intent',
    'effect-maximum-wire'
  );
  mismatchedIntent.semantic_intent_sha256 = 'f'.repeat(64);
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-mismatched-intent',
      command_id: 'command-mismatched-intent',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: mismatchedIntent,
      canonical_wire_template: new Uint8Array(1)
    }),
    hasCode('sip_foundation_wire_attempt_invalid')
  );
  assert.equal(registry.active_attempt_count, 1);
  const maximumWireReplay = session.prepareEffect({
    effect_id: 'effect-maximum-wire',
    command_id: 'command-maximum-wire',
    owner_epoch: '18446744073709551615',
    command_sequence: '18446744073709551615',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('effect-maximum-wire'),
    canonical_wire_template: sipWire(
      wireAttempt('effect-maximum-wire'),
      routeBinding(),
      'OPTIONS',
      65_535
    )
  });
  assert.equal(
    maximumWireReplay.wire_identity.wire_freeze_sha256,
    maximumWire.wire_identity.wire_freeze_sha256
  );
  assert.equal(registry.active_attempt_count, 1);
  const mismatchedBranchWire = sipWire(
    wireAttempt('effect-wire-branch-mismatch')
  );
  const placeholderOffset = mismatchedBranchWire.indexOf(
    SIP_WIRE_BRANCH_PLACEHOLDER
  );
  assert.notEqual(placeholderOffset, -1);
  mismatchedBranchWire.write(
    `z9hG4bK-opc-${'f'.repeat(40)}`,
    placeholderOffset,
    'ascii'
  );
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-wire-branch-mismatch',
      command_id: 'command-wire-branch-mismatch',
      owner_epoch: '18446744073709551615',
      command_sequence: '18446744073709551615',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-wire-branch-mismatch'),
      canonical_wire_template: mismatchedBranchWire
    }),
    hasCode('sip_foundation_wire_invalid')
  );
  const reboundRoute = routeBinding();
  reboundRoute.rfc3263_candidate = 'candidate-tls-secondary';
  reboundRoute.transport.next_hop.address = '2001:db8::21';
  const rebound = session.prepareEffect({
    effect_id: 'effect-route-rebind',
    command_id: 'command-route-rebind',
    owner_epoch: '18446744073709551615',
    command_sequence: '18446744073709551615',
    route_binding: reboundRoute,
    wire_attempt_facts: wireAttempt(
      'effect-route-rebind',
      'effect-maximum-wire'
    ),
    canonical_wire_template: sipWire(
      wireAttempt(
        'effect-route-rebind',
        'effect-maximum-wire'
      ),
      reboundRoute
    )
  });
  assert.equal(
    rebound.route_binding.rfc3263_candidate,
    'candidate-tls-secondary'
  );
  assert.notEqual(
    rebound.wire_identity.route_binding_sha256,
    maximumWire.wire_identity.route_binding_sha256
  );
  const independentTransaction = session.prepareEffect({
    effect_id: 'effect-independent-root',
    command_id: 'command-independent-root',
    owner_epoch: '18446744073709551615',
    command_sequence: '18446744073709551615',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('effect-independent-root'),
    canonical_wire_template: sipWire(wireAttempt('effect-independent-root'))
  });
  assert.equal(
    independentTransaction.wire_attempt_facts.parent_attempt_id,
    null
  );
  assert.equal(registry.active_attempt_count, 3);
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-4',
      command_id: 'command-4',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-4'),
      canonical_wire_template: new Uint8Array(65_536)
    }),
    hasCode('sip_foundation_wire_invalid')
  );
  let wireReads = 0;
  const accessorWireInput = {
    effect_id: 'effect-accessor-wire',
    command_id: 'command-accessor-wire',
    owner_epoch: '1',
    command_sequence: '1',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt('effect-accessor-wire')
  } as Record<string, unknown>;
  Object.defineProperty(accessorWireInput, 'canonical_wire_template', {
    enumerable: true,
    get() {
      wireReads += 1;
      return wireReads < 4
        ? new Uint8Array(1)
        : new Uint8Array(100_000);
    }
  });
  assert.throws(
    () => session.prepareEffect(
      accessorWireInput as unknown as Parameters<
        typeof session.prepareEffect
      >[0]
    ),
    hasCode('sip_foundation_input_invalid')
  );
  assert.equal(wireReads, 0);
  let typedArrayGetterReads = 0;
  class AccessorBytes extends Uint8Array {
    override get byteLength(): number {
      typedArrayGetterReads += 1;
      return 1;
    }
  }
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-byte-subclass',
      command_id: 'command-byte-subclass',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-byte-subclass'),
      canonical_wire_template: new AccessorBytes(1)
    }),
    hasCode('sip_foundation_wire_invalid')
  );
  assert.equal(typedArrayGetterReads, 0);
  const ownAccessorBytes = new Uint8Array(1);
  Object.defineProperty(ownAccessorBytes, 'byteLength', {
    configurable: true,
    get() {
      typedArrayGetterReads += 1;
      return 1;
    }
  });
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-byte-own-accessor',
      command_id: 'command-byte-own-accessor',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-byte-own-accessor'),
      canonical_wire_template: ownAccessorBytes
    }),
    hasCode('sip_foundation_wire_invalid')
  );
  assert.equal(typedArrayGetterReads, 0);
  let proxiedByteReads = 0;
  const proxiedBytes = new Proxy(new Uint8Array(1), {
    get(target, property, receiver) {
      proxiedByteReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => session.prepareEffect({
      effect_id: 'effect-byte-proxy',
      command_id: 'command-byte-proxy',
      owner_epoch: '1',
      command_sequence: '1',
      route_binding: routeBinding(),
      wire_attempt_facts: wireAttempt('effect-byte-proxy'),
      canonical_wire_template: proxiedBytes
    }),
    hasCode('sip_foundation_wire_invalid')
  );
  assert.equal(proxiedByteReads, 0);

  const prepared = session.prepareEffect({
    effect_id: 'effect-replay-validation',
    command_id: 'command-replay-validation',
    owner_epoch: '1',
    command_sequence: '2',
    route_binding: routeBinding(),
    wire_attempt_facts: wireAttempt(
      'effect-replay-validation',
      'effect-route-rebind',
      'effect-maximum-wire'
    ),
    canonical_wire_template: sipWire(wireAttempt(
      'effect-replay-validation',
      'effect-route-rebind',
      'effect-maximum-wire'
    ))
  });
  const routeTamper = structuredClone(prepared);
  (routeTamper.route_binding.route as { revision: number }).revision += 1;
  (routeTamper.wire_identity as { route_binding_sha256: string })
    .route_binding_sha256 = sipRouteBindingSha256(
      routeTamper.route_binding
    );
  (routeTamper.wire_identity as { wire_freeze_sha256: string })
    .wire_freeze_sha256 = sipWireFreezeSha256({
      route_binding_sha256:
        routeTamper.wire_identity.route_binding_sha256,
      wire_attempt_facts_sha256:
        routeTamper.wire_identity.wire_attempt_facts_sha256,
      wire_sha256: routeTamper.wire_identity.wire_sha256,
      wire_length_bytes: routeTamper.wire_identity.wire_length_bytes
    });
  assert.throws(
    () => decodePreparedWireBytes(routeTamper, session),
    hasCode('sip_foundation_wire_invalid')
  );
  const extraIdentity = structuredClone(prepared);
  Object.assign(extraIdentity.wire_identity, { shadow_hash: '0'.repeat(64) });
  assert.throws(
    () => decodePreparedWireBytes(extraIdentity, session),
    hasCode('sip_foundation_wire_invalid')
  );
  const oversizedBase64 = structuredClone(prepared);
  (oversizedBase64 as { wire_bytes_base64: string }).wire_bytes_base64 =
    'A'.repeat(87_384);
  assert.throws(
    () => decodePreparedWireBytes(oversizedBase64, session),
    hasCode('sip_foundation_wire_invalid')
  );
});

test('the OPC-owned seam does not import rvoip implementation types', () => {
  for (const file of [
    'src/agent-runtime/converact/voice/sip-foundation/types.ts',
    'src/agent-runtime/converact/voice/sip-foundation/capabilities.ts',
    'src/agent-runtime/converact/voice/sip-foundation/rsipstack-adapter.ts'
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?:import|from)[^'"]*['"][^'"]*rvoip[^'"]*['"]/i, file);
  }
});

function capabilitySet() {
  return createBackendCapabilitySet(capabilitySetInput());
}

function capabilitySetInput(): BackendCapabilitySetInput {
  const supported = new Set<SipFoundationCapabilityId>(
    RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES
  );
  const payload = {
    schema_id: 'sip-foundation-backend-capability-set-v1' as const,
    schema_version: '1.0.0' as const,
    backend_id: 'rsipstack' as const,
    runtime_attestation_verification: 'not_run' as const,
    production_eligible: false as const,
    capabilities: Object.fromEntries(SIP_FOUNDATION_CAPABILITY_IDS.map((capability) => [
      capability,
      supported.has(capability)
        ? { support: 'supported', verification: 'passed' }
        : { support: 'unsupported', verification: 'not_run' }
    ])) as BackendCapabilitySetInput['capabilities']
  };
  return {
    ...payload,
    source_digest: SOURCE_DIGEST,
    binary_digest: BINARY_DIGEST,
    config_digest: CONFIG_DIGEST,
    capability_set_digest: computeBackendCapabilitySetDigest(payload)
  };
}

function capabilityPayload(
  input: Pick<
    BackendCapabilitySetInput,
    'schema_id' | 'schema_version' | 'backend_id' |
    'runtime_attestation_verification' | 'production_eligible' |
    'capabilities'
  >
) {
  return {
    schema_id: input.schema_id,
    schema_version: input.schema_version,
    backend_id: input.backend_id,
    runtime_attestation_verification:
      input.runtime_attestation_verification,
    production_eligible: input.production_eligible,
    capabilities: input.capabilities
  };
}

function selectionFor(
  capabilitySet: BackendCapabilitySet,
  requiredCapabilities: readonly SipFoundationCapabilityId[] =
    RSIPSTACK_BASELINE_REQUIRED_CAPABILITIES
): SipFoundationAdapterSelection {
  return {
    backend_id: capabilitySet.backend_id,
    source_digest: capabilitySet.source_digest,
    binary_digest: capabilitySet.binary_digest,
    config_digest: capabilitySet.config_digest,
    capability_set_digest: capabilitySet.capability_set_digest,
    require_production_eligible: false,
    required_capabilities: requiredCapabilities
  };
}

function routeBinding(): SipRouteBinding {
  return {
    schema_id: 'sip-foundation-route-binding-v1',
    schema_version: '1.0.0',
    route: {
      id: 'route-primary',
      revision: 3
    },
    rfc3263_candidate: 'candidate-tls-primary',
    route_set: ['sip:edge.carrier.example;lr'],
    transport: {
      id: 'transport-tls-primary',
      protocol: 'tls',
      next_hop: {
        address: '2001:db8::20',
        port: 5061
      }
    },
    local_endpoint: {
      address: '2001:db8::10',
      port: 5061
    },
    advertised_via_sent_by: {
      host: 'voice.example.test',
      port: 5061
    },
    tls_sni: 'sip.carrier.example',
    authorization_identity: 'trunk-a',
    authorization_headers_sha256: []
  };
}

function wireAttempt(
  attemptId: string,
  parentAttemptId: string | null = null,
  transactionLineageId: string = parentAttemptId ?? attemptId,
  semanticIntentSha256: string = createHash('sha256')
    .update(transactionLineageId)
    .digest('hex')
) {
  return {
    schema_id: 'sip-foundation-wire-attempt-v1' as const,
    schema_version: '1.0.0' as const,
    attempt_id: attemptId,
    transaction_lineage_id: transactionLineageId,
    semantic_intent_sha256: semanticIntentSha256,
    parent_attempt_id: parentAttemptId,
    lineage_reason: parentAttemptId === null
      ? 'transaction_root' as const
      : 'derived_attempt' as const
  };
}

function sipWire(
  _attempt: ReturnType<typeof wireAttempt>,
  route: SipRouteBinding = routeBinding(),
  method = 'OPTIONS',
  totalLength?: number,
  authorizationHeaders: readonly {
    name: 'Authorization' | 'Proxy-Authorization';
    value: string;
  }[] = []
): Buffer {
  const sentByHost = route.advertised_via_sent_by.host.includes(':')
    ? `[${route.advertised_via_sent_by.host}]`
    : route.advertised_via_sent_by.host;
  const startAndHeaders = (
    bodyLength: number,
    paddingHeaders: readonly string[] = []
  ) => [
    `${method} sip:1001@example.test SIP/2.0`,
    `Via: SIP/2.0/${route.transport.protocol.toUpperCase()} ` +
      `${sentByHost}:${route.advertised_via_sent_by.port};` +
      `branch=${SIP_WIRE_BRANCH_PLACEHOLDER}`,
    'From: "测试用户" <sip:1001@example.test>',
    ...route.route_set.map((value) => `Route: <${value}>`),
    ...authorizationHeaders.map((header) =>
      `${header.name}: ${header.value}`
    ),
    ...paddingHeaders,
    `Content-Length: ${bodyLength}`,
    '',
    ''
  ].join('\r\n');
  if (totalLength === undefined) {
    return Buffer.from(startAndHeaders(0), 'utf8');
  }
  const bodyLength = Math.min(32_768, Math.max(
    0,
    totalLength - Buffer.byteLength(startAndHeaders(0), 'utf8')
  ));
  const baseHeaders = Buffer.from(startAndHeaders(bodyLength), 'utf8');
  let paddingBytes = totalLength - bodyLength - baseHeaders.byteLength;
  if (paddingBytes < 0 || (paddingBytes > 0 && paddingBytes < 13)) {
    throw new Error('requested SIP wire is too small');
  }
  const paddingHeaders: string[] = [];
  while (paddingBytes > 0) {
    let lineBytes = Math.min(8_192, paddingBytes);
    const remainder = paddingBytes - lineBytes;
    if (remainder > 0 && remainder < 13) lineBytes -= 13 - remainder;
    if (lineBytes < 13) throw new Error('invalid SIP padding budget');
    paddingHeaders.push(`X-Padding: ${'x'.repeat(lineBytes - 13)}`);
    paddingBytes -= lineBytes;
  }
  const headers = Buffer.from(
    startAndHeaders(bodyLength, paddingHeaders),
    'utf8'
  );
  assert.equal(headers.byteLength + bodyLength, totalLength);
  return Buffer.concat([headers, Buffer.alloc(bodyLength)], totalLength);
}

function materializeSipWire(
  template: Uint8Array,
  viaBranch: string
): Buffer {
  assert.equal(viaBranch.length, SIP_WIRE_BRANCH_PLACEHOLDER.length);
  const bytes = Buffer.from(template);
  const offset = bytes.indexOf(SIP_WIRE_BRANCH_PLACEHOLDER);
  assert.notEqual(offset, -1);
  bytes.write(viaBranch, offset, 'ascii');
  return bytes;
}

function insertSipHeaders(
  template: Uint8Array,
  headers: readonly string[]
): Buffer {
  const bytes = Buffer.from(template);
  const marker = Buffer.from('Content-Length:', 'ascii');
  const offset = bytes.indexOf(marker);
  assert.notEqual(offset, -1);
  return Buffer.concat([
    bytes.subarray(0, offset),
    Buffer.from(`${headers.join('\r\n')}\r\n`, 'utf8'),
    bytes.subarray(offset)
  ]);
}

function sessionBinding(
  route: SipRouteBinding
): SipProtocolSessionBinding {
  return {
    schema_id: 'sip-foundation-session-binding-v1',
    schema_version: '1.0.0',
    route: {
      id: route.route.id,
      revision: route.route.revision
    },
    authorization_identity: route.authorization_identity
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof SipFoundationError && error.code === code;
}
