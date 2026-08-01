import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterError,
  RustPbxRwiSupervisorControl,
  type RustPbxSupervisorCallBindingResolver
} from '../src/agent-runtime/converact/contact-center/index.js';
import {
  RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
  RUSTPBX_RWI_PROTOCOL_CAPABILITIES,
  VoiceError,
  mapRustPbxRwiSupervisorAction,
  type RustPbxRwiPreflightResult,
  type RustPbxRwiSupervisorActionInput
} from '../src/agent-runtime/converact/voice/index.js';

test('RustPBX supervisor RWI mapping is exact and rejects malformed provider identifiers', () => {
  assert.deepEqual(mapRustPbxRwiSupervisorAction({
    action_id: 'supervisor-session-a', mode: 'listen',
    supervisor_call_id: 'provider-supervisor-a', target_call_id: 'provider-call-a'
  }), {
    action: 'supervisor.listen', action_id: 'supervisor-session-a',
    params: {
      supervisor_call_id: 'provider-supervisor-a', target_call_id: 'provider-call-a'
    }
  });
  assert.deepEqual(mapRustPbxRwiSupervisorAction({
    action_id: 'supervisor-session-b', mode: 'whisper',
    supervisor_call_id: 'provider-supervisor-b', target_call_id: 'provider-call-b',
    agent_leg: 'provider-agent-leg-b'
  }), {
    action: 'supervisor.whisper', action_id: 'supervisor-session-b',
    params: {
      supervisor_call_id: 'provider-supervisor-b', target_call_id: 'provider-call-b',
      agent_leg: 'provider-agent-leg-b'
    }
  });
  assert.deepEqual(mapRustPbxRwiSupervisorAction({
    action_id: 'supervisor-session-c:end', mode: 'stop',
    supervisor_call_id: 'provider-supervisor-c', target_call_id: 'provider-call-c'
  }), {
    action: 'supervisor.stop', action_id: 'supervisor-session-c:end',
    params: {
      supervisor_call_id: 'provider-supervisor-c', target_call_id: 'provider-call-c'
    }
  });
  assert.throws(() => mapRustPbxRwiSupervisorAction({
    action_id: 'bad\ncommand', mode: 'barge', supervisor_call_id: 'sup', target_call_id: 'target'
  }), hasVoiceCode('validation_failed'));
  assert.throws(() => mapRustPbxRwiSupervisorAction({
    action_id: 'unexpected-field', mode: 'listen', supervisor_call_id: 'sup',
    target_call_id: 'target', secret: 'must-not-cross-boundary'
  } as RustPbxRwiSupervisorActionInput), hasVoiceCode('validation_failed'));
});

test('RustPBX supervisor control follows effective preflight and uses opaque durable session ids', async () => {
  const calls: RustPbxRwiSupervisorActionInput[] = [];
  const resolutions: Array<Record<string, unknown>> = [];
  const resolver: RustPbxSupervisorCallBindingResolver = {
    async resolve(input) {
      resolutions.push(structuredClone(input));
      return {
        supervisor_call_id: 'provider-supervisor-a',
        target_call_id: 'provider-target-a',
        agent_leg: 'provider-agent-leg-a'
      };
    }
  };
  const control = new RustPbxRwiSupervisorControl({
    preflight: enabledPreflight(),
    bindings: resolver,
    rwi: {
      async executeSupervisor(input) {
        calls.push(structuredClone(input));
        return { state: 'succeeded', action_id: input.action_id, result: { accepted: true } };
      }
    }
  });
  assert.equal(control.supports('monitor'), true);
  assert.equal(control.supports('whisper'), true);
  assert.equal(control.supports('barge'), true);

  const provider = await control.start({
    session_id: 'supervisor-session-a', tenant_id: 'tenant-a', call_id: 'call-a',
    target_agent_id: 'agent-a', supervisor_identity: 'admin-a', mode: 'whisper',
    authorization_ref: 'policy:42'
  });
  assert.deepEqual(provider, { provider_session_id: 'supervisor-session-a' });
  assert.deepEqual(calls[0], {
    action_id: 'supervisor-session-a', mode: 'whisper',
    supervisor_call_id: 'provider-supervisor-a', target_call_id: 'provider-target-a',
    agent_leg: 'provider-agent-leg-a'
  });
  assert.equal(JSON.stringify(calls).includes('policy:42'), false);

  await control.end({
    tenant_id: 'tenant-a', session_id: 'supervisor-session-a', call_id: 'call-a',
    target_agent_id: 'agent-a', supervisor_identity: 'admin-a', mode: 'whisper',
    provider_session_id: 'supervisor-session-a', idempotency_key: 'supervisor-session-a:end'
  });
  assert.deepEqual(calls[1], {
    action_id: 'supervisor-session-a:end', mode: 'stop',
    supervisor_call_id: 'provider-supervisor-a', target_call_id: 'provider-target-a'
  });
  assert.equal(resolutions.length, 2);
});

test('RustPBX supervisor control fails closed for the pinned baseline and classifies uncertainty', async () => {
  let resolved = false;
  const baseline = new RustPbxRwiSupervisorControl({
    preflight: baselinePreflight(),
    bindings: { async resolve() { resolved = true; throw new Error('must not resolve'); } },
    rwi: { async executeSupervisor() { throw new Error('must not execute'); } }
  });
  assert.equal(baseline.supports('monitor'), false);
  await assert.rejects(() => baseline.start({
    session_id: 'session-a', tenant_id: 'tenant-a', call_id: 'call-a',
    target_agent_id: 'agent-a', supervisor_identity: 'admin-a', mode: 'monitor',
    authorization_ref: 'policy:42'
  }), hasContactCenterCode('capability_unavailable'));
  assert.equal(resolved, false);

  const uncertain = new RustPbxRwiSupervisorControl({
    preflight: enabledPreflight(),
    bindings: {
      async resolve() {
        return { supervisor_call_id: 'provider-supervisor-a', target_call_id: 'provider-target-a' };
      }
    },
    rwi: {
      async executeSupervisor(input) {
        return { state: 'uncertain', action_id: input.action_id, error_code: 'provider_timeout' };
      }
    }
  });
  await assert.rejects(() => uncertain.start({
    session_id: 'session-a', tenant_id: 'tenant-a', call_id: 'call-a',
    target_agent_id: 'agent-a', supervisor_identity: 'admin-a', mode: 'monitor',
    authorization_ref: 'policy:42'
  }), (error: unknown) => error instanceof VoiceError
    && error.code === 'provider_timeout' && error.retryable === true);
});

function baselinePreflight(): RustPbxRwiPreflightResult {
  return {
    ready: true, protocol: 'rwi-v1', commands: [
      'supervisor.listen', 'supervisor.whisper', 'supervisor.barge', 'supervisor.stop'
    ],
    capability_source: 'pinned_baseline', runtime_version_verified: false,
    protocol_capabilities: RUSTPBX_RWI_PROTOCOL_CAPABILITIES,
    effective_capabilities: RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
    limitations: ['supervisor_audio_mixing_unavailable']
  };
}

function enabledPreflight(): RustPbxRwiPreflightResult {
  return {
    ...baselinePreflight(),
    commands: [
      'supervisor.listen', 'supervisor.whisper', 'supervisor.barge', 'supervisor.stop'
    ],
    effective_capabilities: {
      ...RUSTPBX_RWI_EFFECTIVE_CAPABILITIES,
      supervisor: { listen: true, whisper: true, barge: true, takeover: false }
    }
  };
}

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof VoiceError && error.code === code;
}

function hasContactCenterCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ContactCenterError && error.code === code;
}
