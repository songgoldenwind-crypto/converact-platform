import { fileURLToPath } from 'node:url';
import {
  SIP_VOLTE_GATEWAY_DEFINITION,
  createSipVolteGateway
} from '../src/agent-runtime/media-gateway/adapters/sip-volte-gateway.js';
import type { MediaJoinPlan } from '../src/agent-runtime/media-gateway/index.js';

export interface SipVolteReadinessConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sipBridgeTarget: string;
  rustpbxLiveKitTrunk: string;
  rustpbxRwiUrl: string;
  rustpbxRwiToken: string;
  roomName: string;
  customerPhone?: string;
  requireActiveGateway?: boolean;
  gatewayStatusUrl?: string;
  gatewayStatusToken?: string;
}

export interface SipVolteReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SipVolteReadinessResult {
  gatewayStatus: 'active' | 'planned';
  activationRequired: boolean;
  dialPlan: Extract<MediaJoinPlan, { mode: 'sip_bridge' }>;
  checks: SipVolteReadinessCheck[];
}

export type SipVolteReadinessFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class SipVolteReadinessError extends Error {
  readonly result: SipVolteReadinessResult;

  constructor(message: string, result: SipVolteReadinessResult) {
    super(message);
    this.name = 'SipVolteReadinessError';
    this.result = result;
  }
}

export function createSipVolteReadinessConfigFromEnv(
  env: NodeJS.ProcessEnv
): SipVolteReadinessConfig {
  const livekitUrl = requiredEnv(env, 'LIVEKIT_URL').replace(/\/+$/, '');
  const livekitApiKey = requiredEnv(env, 'LIVEKIT_API_KEY');
  const livekitApiSecret = requiredEnv(env, 'LIVEKIT_API_SECRET');
  const sipBridgeTarget = requiredEnv(env, 'LIVEKIT_SIP_BRIDGE_TARGET');
  const rustpbxLiveKitTrunk = requiredEnv(env, 'RUSTPBX_LIVEKIT_TRUNK');
  const rustpbxRwiUrl = requiredEnv(env, 'RUSTPBX_RWI_URL');
  const rustpbxRwiToken = requiredEnv(env, 'RUSTPBX_RWI_TOKEN');
  const roomName =
    env.OPC_SIP_VOLTE_SMOKE_ROOM_NAME ||
    `sip-volte-readiness-${Date.now()}`;
  return {
    livekitUrl,
    livekitApiKey,
    livekitApiSecret,
    sipBridgeTarget,
    rustpbxLiveKitTrunk,
    rustpbxRwiUrl,
    rustpbxRwiToken,
    roomName,
    customerPhone: env.OPC_SIP_VOLTE_SMOKE_CUSTOMER_PHONE,
    requireActiveGateway: env.OPC_SIP_VOLTE_REQUIRE_ACTIVE === '1',
    gatewayStatusUrl: env.OPC_SIP_VOLTE_GATEWAY_STATUS_URL,
    gatewayStatusToken: env.OPC_SIP_VOLTE_GATEWAY_STATUS_TOKEN
  };
}

export async function runSipVolteReadiness(
  config: SipVolteReadinessConfig,
  fetchImpl: SipVolteReadinessFetch = fetch
): Promise<SipVolteReadinessResult> {
  const previousBridgeTarget = process.env.LIVEKIT_SIP_BRIDGE_TARGET;
  const previousTrunk = process.env.RUSTPBX_LIVEKIT_TRUNK;
  process.env.LIVEKIT_SIP_BRIDGE_TARGET = config.sipBridgeTarget;
  process.env.RUSTPBX_LIVEKIT_TRUNK = config.rustpbxLiveKitTrunk;
  try {
    const dialPlan = await createSipVolteGateway().prepareJoin({
      tenantId: 'sip-volte-readiness',
      roomName: config.roomName,
      identity: 'sip-volte-customer',
      role: 'customer',
      media: 'video',
      contact: { phone: config.customerPhone }
    });
    if (dialPlan.mode !== 'sip_bridge') {
      throw new Error('sip_volte gateway did not return a sip_bridge dial plan');
    }
    const runtimeStatus = await probeRuntimeGatewayStatus(config, fetchImpl);
    const gatewayStatus = runtimeStatus?.status || SIP_VOLTE_GATEWAY_DEFINITION.status;
    const result: SipVolteReadinessResult = {
      gatewayStatus,
      activationRequired: gatewayStatus !== 'active',
      dialPlan,
      checks: [
        {
          name: 'livekit_server_config',
          ok: true,
          detail: `${config.livekitUrl} (${config.livekitApiKey})`
        },
        {
          name: 'livekit_sip_bridge_target',
          ok: Boolean(config.sipBridgeTarget),
          detail: config.sipBridgeTarget
        },
        {
          name: 'rustpbx_livekit_trunk',
          ok: Boolean(config.rustpbxLiveKitTrunk),
          detail: config.rustpbxLiveKitTrunk
        },
        {
          name: 'rustpbx_rwi_config',
          ok: Boolean(config.rustpbxRwiUrl && config.rustpbxRwiToken),
          detail: config.rustpbxRwiUrl
        },
        {
          name: 'sip_volte_gateway_status',
          ok: gatewayStatus === 'active',
          detail: runtimeStatus
            ? `${gatewayStatus} (runtime probe)`
            : SIP_VOLTE_GATEWAY_DEFINITION.status
        },
        ...(runtimeStatus
          ? [
              {
                name: 'sip_volte_runtime_status',
                ok: runtimeStatus.ok,
                detail: runtimeStatus.detail
              }
            ]
          : []),
        {
          name: 'sip_bridge_dial_plan',
          ok: true,
          detail: dialPlan.sipDialTarget
        }
      ]
    };
    if (config.requireActiveGateway && result.activationRequired) {
      throw new SipVolteReadinessError(
        'sip_volte gateway is still planned but OPC_SIP_VOLTE_REQUIRE_ACTIVE=1',
        result
      );
    }
    return result;
  } finally {
    restoreEnv('LIVEKIT_SIP_BRIDGE_TARGET', previousBridgeTarget);
    restoreEnv('RUSTPBX_LIVEKIT_TRUNK', previousTrunk);
  }
}

async function probeRuntimeGatewayStatus(
  config: SipVolteReadinessConfig,
  fetchImpl: SipVolteReadinessFetch
): Promise<{ status: 'active' | 'planned'; ok: boolean; detail: string } | null> {
  if (!config.gatewayStatusUrl) return null;
  const response = await fetchImpl(config.gatewayStatusUrl, {
    headers: {
      accept: 'application/json',
      ...(config.gatewayStatusToken ? { authorization: `Bearer ${config.gatewayStatusToken}` } : {})
    }
  });
  const payload = await readJson(response);
  const status = readStatus(payload);
  const sipBridgeTarget = readString(payload, 'sip_bridge_target') || readString(payload, 'sipBridgeTarget');
  const trunk = readString(payload, 'rustpbx_livekit_trunk') || readString(payload, 'rustpbxLivekitTrunk') || readString(payload, 'trunk');
  const video = readBoolean(payload, 'video');
  const ok =
    response.ok &&
    status === 'active' &&
    sipBridgeTarget === config.sipBridgeTarget &&
    trunk === config.rustpbxLiveKitTrunk &&
    video === true;
  return {
    status: ok ? 'active' : 'planned',
    ok,
    detail: `status=${status || 'unknown'} http=${response.status} target=${sipBridgeTarget || 'unspecified'} trunk=${trunk || 'unspecified'} video=${video === undefined ? 'unspecified' : String(video)}`
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readStatus(payload: Record<string, unknown>): 'active' | 'planned' | null {
  const raw = String(payload.status || payload.gateway_status || payload.gatewayStatus || '').toLowerCase();
  if (raw === 'active' || raw === 'ready' || raw === 'healthy') return 'active';
  if (raw === 'planned' || raw === 'inactive' || raw === 'unhealthy' || raw === 'down') return 'planned';
  return null;
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value ? value : undefined;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

async function main(): Promise<void> {
  const config = createSipVolteReadinessConfigFromEnv(process.env);
  let result: SipVolteReadinessResult;
  try {
    result = await runSipVolteReadiness(config);
  } catch (error) {
    if (error instanceof SipVolteReadinessError) {
      console.log(JSON.stringify(error.result, null, 2));
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.activationRequired) {
    console.error(
      "sip_volte gateway is still planned. Keep this as a readiness check until the bridge is activated intentionally."
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
