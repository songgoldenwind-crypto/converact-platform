import { resolveBrandEnv } from '../src/config/converact-env.js';
import { fileURLToPath } from 'node:url';

export interface AiAgentConveractCallbackSmokeConfig {
  baseUrl: string;
  converactApiKey: string;
  mediaApiToken: string;
  tenantId: string;
  roomName?: string;
}

export interface AiAgentConveractCallbackSmokeStep {
  name: string;
  status: number;
}

export interface AiAgentConveractCallbackSmokeResult {
  roomName: string;
  actionTaken: string;
  steps: AiAgentConveractCallbackSmokeStep[];
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createAiAgentConveractCallbackSmokeConfigFromEnv(
  env: NodeJS.ProcessEnv
): AiAgentConveractCallbackSmokeConfig {
  const baseUrl = resolveBrandEnv(env, 'BASE_URL') || '';
  const converactApiKey = resolveBrandEnv(env, 'API_KEY') || '';
  const mediaApiToken = resolveBrandEnv(env, 'MEDIA_API_TOKEN') || env.LIVEKIT_MEDIA_API_TOKEN || '';
  const tenantId = resolveBrandEnv(env, 'AI_CALLBACK_SMOKE_TENANT_ID') || resolveBrandEnv(env, 'TENANT_ID') || '';
  if (!baseUrl) throw new Error('CONVERACT_BASE_URL is required');
  if (!converactApiKey) throw new Error('CONVERACT_API_KEY is required');
  if (!mediaApiToken) throw new Error('CONVERACT_MEDIA_API_TOKEN or LIVEKIT_MEDIA_API_TOKEN is required');
  if (!tenantId) throw new Error('CONVERACT_AI_CALLBACK_SMOKE_TENANT_ID or CONVERACT_TENANT_ID is required');
  return {
    baseUrl,
    converactApiKey,
    mediaApiToken,
    tenantId,
    roomName: resolveBrandEnv(env, 'AI_CALLBACK_SMOKE_ROOM_NAME')
  };
}

export async function runAiAgentConveractCallbackSmoke(
  config: AiAgentConveractCallbackSmokeConfig,
  fetchImpl: FetchLike = fetch
): Promise<AiAgentConveractCallbackSmokeResult> {
  const steps: AiAgentConveractCallbackSmokeStep[] = [];
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const roomName = config.roomName || `${config.tenantId}-ai-callback-smoke-${Date.now()}`;
  const converactHeaders = {
    'content-type': 'application/json',
    'x-api-key': config.converactApiKey
  };
  const mediaHeaders = {
    authorization: `Bearer ${config.mediaApiToken}`
  };
  let roomCreated = false;
  let roomClosed = false;

  try {
    await jsonRequest(fetchImpl, steps, 'create_legacy_room', `${baseUrl}/api/livekit/rooms`, {
      method: 'POST',
      headers: converactHeaders,
      body: JSON.stringify({
        tenant_id: config.tenantId,
        purpose: 'pstn_bridge',
        room_name: roomName,
        metadata: {
          business_ref: {
            type: 'ai_callback_smoke',
            id: roomName
          }
        }
      })
    });
    roomCreated = true;

    const dispatch = await jsonRequest(fetchImpl, steps, 'dispatch_transfer_to_human', `${baseUrl}/api/livekit/agent-dispatch`, {
      method: 'POST',
      headers: converactHeaders,
      body: JSON.stringify({
        tenant_id: config.tenantId,
        room_name: roomName,
        action: 'transfer_to_human',
        reason: 'ai callback smoke',
        customer_summary: 'AI callback smoke validation',
        intent_score: 0.8,
        language: 'ja'
      })
    }) as { action_taken?: unknown; data?: { action_taken?: unknown } };
    const actionTaken = readString(dispatch.action_taken) || readString(dispatch.data?.action_taken) || '';
    if (!actionTaken) throw new Error('agent-dispatch did not return action_taken');

    await closeSmokeRoom(fetchImpl, steps, baseUrl, mediaHeaders, roomName, config.tenantId, 'close_room');
    roomClosed = true;

    return {
      roomName,
      actionTaken,
      steps
    };
  } catch (error) {
    if (roomCreated && !roomClosed) {
      try {
        await closeSmokeRoom(fetchImpl, steps, baseUrl, mediaHeaders, roomName, config.tenantId, 'cleanup_room_after_failure');
      } catch (cleanupError) {
        throw appendCleanupFailure(error, cleanupError);
      }
    }
    throw error;
  }
}

async function jsonRequest(
  fetchImpl: FetchLike,
  steps: AiAgentConveractCallbackSmokeStep[],
  name: string,
  url: string,
  init: RequestInit = {},
  okStatuses: number[] = [200, 201]
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  steps.push({ name, status: response.status });
  const payload = await readJson(response);
  if (!okStatuses.includes(response.status)) {
    throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function closeSmokeRoom(
  fetchImpl: FetchLike,
  steps: AiAgentConveractCallbackSmokeStep[],
  baseUrl: string,
  headers: Record<string, string>,
  roomName: string,
  tenantId: string,
  stepName: string
): Promise<void> {
  await jsonRequest(fetchImpl, steps, stepName, mediaUrl(
    baseUrl,
    `/api/media/livekit/rooms/${encodeURIComponent(roomName)}/close`,
    { tenant_id: tenantId }
  ), {
    method: 'POST',
    headers
  });
}

function appendCleanupFailure(error: unknown, cleanupError: unknown): Error {
  const mainMessage = error instanceof Error ? error.message : String(error);
  const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  return new Error(`${mainMessage}; cleanup failed: ${cleanupMessage}`);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function mediaUrl(baseUrl: string, path: string, query: Record<string, string>): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

async function main(): Promise<void> {
  const config = createAiAgentConveractCallbackSmokeConfigFromEnv(process.env);
  const result = await runAiAgentConveractCallbackSmoke(config);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
