import { resolveConveractEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_RUSTPBX_MANAGEMENT_PATHS,
  RustPbxManagementClient
} from '../src/agent-runtime/converact/voice/adapters/rustpbx-management.js';
import { RustPbxRwiClient } from '../src/agent-runtime/converact/voice/adapters/rustpbx-rwi.js';
import { EnvVoiceSecretResolver } from '../src/agent-runtime/converact/voice/secret-resolver.js';

interface ReconciliationDialog {
  id: string;
  call_id: string;
  provider_call_id: string;
  state: string;
  source: 'active_call_registry';
}

export interface RustPbxRwiAcceptanceReport {
  schema_version: 1;
  run_id: string;
  rwi: {
    ready: true;
    protocol: 'rwi-v1';
    capability_source: 'pinned_baseline';
    runtime_version_verified: false;
    protocol_actions: string[];
    effective_capabilities: {
      dtmf_send: boolean;
      park: boolean;
      pickup: boolean;
      conference: {
        create: boolean;
        add: boolean;
        remove: boolean;
        destroy: boolean;
      };
      supervisor: {
        listen: boolean;
        whisper: boolean;
        barge: boolean;
        takeover: boolean;
      };
    };
    ivekit_composed_capabilities: {
      park: boolean;
      pickup: boolean;
      park_primitives: string[];
      pickup_primitives: string[];
    };
    limitations: string[];
    originate_state: 'succeeded';
    deterministic_call_id: true;
    hangup_state: 'succeeded';
  };
  ami_reconciliation: {
    state: 'pending' | 'succeeded';
    provider_state: string;
    provider_call_id: string;
    source: 'active_call_registry';
  };
  hangup_verification: {
    control_plane_state: string;
    control_plane_terminal: true;
    sip_signaling_evidence: 'external_sipp_required';
  };
}

export function findRustPbxReconciliationDialog(
  value: unknown,
  callId: string
): ReconciliationDialog | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!isRecord(item) || item.source !== 'active_call_registry') continue;
    if (item.id !== callId || item.call_id !== callId || item.provider_call_id !== callId) continue;
    if (typeof item.state !== 'string' || !item.state || item.state.length > 128) continue;
    return {
      id: callId,
      call_id: callId,
      provider_call_id: callId,
      state: item.state,
      source: 'active_call_registry'
    };
  }
  return null;
}

export async function runRustPbxRwiAcceptance(
  env: NodeJS.ProcessEnv = process.env
): Promise<RustPbxRwiAcceptanceReport> {
  const runId = required(env, 'IVEKIT_ACCEPTANCE_RUN_ID');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId)) throw new Error('invalid IVEKIT_ACCEPTANCE_RUN_ID');

  const rwiTokenName = 'RUSTPBX_RWI_TOKEN';
  const managementTokenName = 'RUSTPBX_MANAGEMENT_TOKEN';
  const resolver = new EnvVoiceSecretResolver({
    env,
    allowlist: {
      rwi: [rwiTokenName],
      rustpbx_management: [managementTokenName]
    }
  });
  const baseUrl = required(env, 'RUSTPBX_BASE_URL');
  const callId = `ivekit-rwi-${runId}`;
  const rwi = new RustPbxRwiClient({
    url: required(env, 'RUSTPBX_RWI_URL'),
    token_ref: `env://${rwiTokenName}`,
    secret_resolver: resolver,
    internal_service: true,
    connect_timeout_ms: 10_000,
    command_timeout_ms: 30_000
  });
  const management = new RustPbxManagementClient({
    base_url: baseUrl,
    profile_id: `acceptance-${runId}`,
    config_hash: createHash('sha256').update(runId).digest('hex'),
    service_token_ref: `env://${managementTokenName}`,
    secret_resolver: resolver,
    paths: { ...DEFAULT_RUSTPBX_MANAGEMENT_PATHS },
    internal_service: true,
    timeout_ms: 10_000
  });

  let originated = false;
  let hungUp = false;
  try {
    await rwi.connect();
    const preflight = await rwi.preflight();
    if (!preflight.ready) throw new Error('RWI preflight did not converge');
    assertRequiredRwiProtocolActions(preflight.commands);
    const protocolActions = new Set(preflight.commands);
    const originate = await rwi.execute({
      command_id: `originate-${runId}`,
      kind: 'originate',
      call_id: callId,
      payload: {
        destination: required(env, 'RUSTPBX_ACCEPTANCE_DESTINATION'),
        timeout_secs: 20
      }
    });
    if (originate.state !== 'succeeded') throw new Error(`RWI originate failed: ${originate.state}`);
    originated = true;
    if (originate.result.call_id !== callId) throw new Error('RWI originate did not preserve call_id');

    const managementToken = await resolver.resolve(`env://${managementTokenName}`, 'rustpbx_management');
    const rawDialog = await waitFor(async () => {
      const response = await fetch(new URL('/ami/v1/dialogs', baseUrl), {
        headers: { accept: 'application/json', authorization: `Bearer ${managementToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw new Error(`AMI dialogs failed with HTTP ${response.status}`);
      return findRustPbxReconciliationDialog(await response.json(), callId);
    }, 10_000);
    const reconciled = await waitFor(async () => {
      const result = await management.lookupDialog({ provider_call_id: callId });
      if (result.state !== 'succeeded' || !result.provider_call_id) {
        return null;
      }
      return {
        state: result.state,
        provider_state: result.provider_state,
        provider_call_id: result.provider_call_id
      };
    }, 10_000);
    if (reconciled.provider_call_id !== callId) throw new Error('AMI reconciliation changed call_id');

    await rwi.connect();
    const hangup = await rwi.execute({
      command_id: `hangup-${runId}`,
      kind: 'hangup',
      call_id: callId,
      payload: { reason: 'acceptance_complete', code: 200 }
    });
    if (hangup.state !== 'succeeded') throw new Error(`RWI hangup failed: ${hangup.state}`);
    hungUp = true;
    const hangupVerification = await waitFor(async () => {
      const result = await management.lookupDialog({ provider_call_id: callId });
      if (!isTerminalRustPbxHangupState(result.provider_state)) return null;
      return { provider_state: result.provider_state };
    }, 10_000);

    return {
      schema_version: 1,
      run_id: runId,
      rwi: {
        ready: true,
        protocol: preflight.protocol,
        capability_source: preflight.capability_source,
        runtime_version_verified: preflight.runtime_version_verified,
        protocol_actions: [...preflight.commands].sort(),
        effective_capabilities: {
          dtmf_send: preflight.effective_capabilities.dtmf_send,
          park: preflight.effective_capabilities.park,
          pickup: preflight.effective_capabilities.pickup,
          conference: {
            create: preflight.effective_capabilities.conference.create,
            add: preflight.effective_capabilities.conference.add,
            remove: preflight.effective_capabilities.conference.remove,
            destroy: preflight.effective_capabilities.conference.destroy
          },
          supervisor: {
            listen: preflight.effective_capabilities.supervisor.listen,
            whisper: preflight.effective_capabilities.supervisor.whisper,
            barge: preflight.effective_capabilities.supervisor.barge,
            takeover: preflight.effective_capabilities.supervisor.takeover
          }
        },
        ivekit_composed_capabilities: {
          park: protocolActions.has('call.hold'),
          pickup: protocolActions.has('call.unhold') && protocolActions.has('call.bridge'),
          park_primitives: ['call.hold'],
          pickup_primitives: ['call.unhold', 'call.bridge']
        },
        limitations: [...preflight.limitations].sort(),
        originate_state: originate.state,
        deterministic_call_id: true,
        hangup_state: hangup.state
      },
      ami_reconciliation: {
        state: reconciled.state,
        provider_state: reconciled.provider_state,
        provider_call_id: reconciled.provider_call_id,
        source: rawDialog.source
      },
      hangup_verification: {
        control_plane_state: hangupVerification.provider_state,
        control_plane_terminal: true,
        sip_signaling_evidence: 'external_sipp_required'
      }
    };
  } finally {
    if (originated && !hungUp) {
      await rwi.connect()
        .then(() => rwi.execute({
          command_id: `cleanup-${runId}`,
          kind: 'hangup',
          call_id: callId,
          payload: { reason: 'acceptance_cleanup', code: 200 }
        }))
        .catch(() => undefined);
    }
    await rwi.close();
  }
}

export function isTerminalRustPbxHangupState(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['completed', 'ended', 'not_found', 'terminated'].includes(normalized)) return true;
  return /\(terminated(?:\s[^()]*)?\)$/.test(normalized);
}

function assertRequiredRwiProtocolActions(actions: readonly string[]): void {
  const available = new Set(actions);
  const requiredActions = [
    'call.originate', 'call.answer', 'call.hangup', 'call.hold', 'call.unhold', 'call.bridge',
    'call.send_dtmf', 'call.transfer', 'call.transfer.attended',
    'conference.create', 'conference.add', 'conference.remove', 'conference.destroy',
    'record.start', 'record.pause', 'record.resume', 'record.stop',
    'supervisor.listen', 'supervisor.whisper', 'supervisor.barge', 'supervisor.stop'
  ];
  const missing = requiredActions.filter((action) => !available.has(action));
  if (missing.length) throw new Error(`RWI preflight is missing protocol actions: ${missing.join(',')}`);
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== null) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('RustPBX RWI reconciliation timed out');
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(resolveConveractEnv(env, name) || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const mainPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === mainPath) {
  const report = await runRustPbxRwiAcceptance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
