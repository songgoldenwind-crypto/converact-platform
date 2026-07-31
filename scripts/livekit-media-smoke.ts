import { fileURLToPath } from 'node:url';

export interface LiveKitMediaSmokeConfig {
  baseUrl: string;
  mediaApiToken: string;
  tenantId: string;
  roomName?: string;
  closeRoomOnExit?: boolean;
  requireConfiguredLiveKit?: boolean;
  requireSignedCustomerJoinPath?: boolean;
  verifyRecordingObject?: boolean;
  recordingObjectTimeoutMs?: number;
  recordingObjectPollIntervalMs?: number;
}

export interface LiveKitMediaSmokeStep {
  name: string;
  status: number;
}

export interface LiveKitMediaSmokeResult {
  roomName: string;
  recordingId: string;
  egressId: string;
  customerJoinPath?: string;
  closeRoomOnExit: boolean;
  recordingObjectStatus?: string;
  recordingExportBytes?: number;
  steps: LiveKitMediaSmokeStep[];
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createLiveKitMediaSmokeConfigFromEnv(env: NodeJS.ProcessEnv): LiveKitMediaSmokeConfig {
  const baseUrl = env.OPC_BASE_URL || '';
  const mediaApiToken = env.OPC_MEDIA_API_TOKEN || env.LIVEKIT_MEDIA_API_TOKEN || '';
  const tenantId = env.OPC_MEDIA_SMOKE_TENANT_ID || env.OPC_TENANT_ID || '';
  if (!baseUrl) throw new Error('OPC_BASE_URL is required');
  if (!mediaApiToken) throw new Error('OPC_MEDIA_API_TOKEN or LIVEKIT_MEDIA_API_TOKEN is required');
  if (!tenantId) throw new Error('OPC_MEDIA_SMOKE_TENANT_ID or OPC_TENANT_ID is required');
  return {
    baseUrl,
    mediaApiToken,
    tenantId,
    roomName: env.OPC_MEDIA_SMOKE_ROOM_NAME,
    closeRoomOnExit: env.OPC_MEDIA_SMOKE_KEEP_ROOM_OPEN !== '1',
    requireConfiguredLiveKit: env.OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT === '1',
    requireSignedCustomerJoinPath: Boolean(env.OPC_MEDIA_INVITE_SECRET || env.LIVEKIT_MEDIA_INVITE_SECRET),
    verifyRecordingObject: env.OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT === '1',
    recordingObjectTimeoutMs: positiveInteger(env.OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS, 60_000),
    recordingObjectPollIntervalMs: positiveInteger(env.OPC_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS, 2_000)
  };
}

export async function runLiveKitMediaSmoke(
  config: LiveKitMediaSmokeConfig,
  fetchImpl: FetchLike = fetch
): Promise<LiveKitMediaSmokeResult> {
  const steps: LiveKitMediaSmokeStep[] = [];
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const roomName = config.roomName || `${config.tenantId}-media-smoke-${Date.now()}`;
  const closeRoomOnExit = config.closeRoomOnExit !== false;
  const headers = {
    authorization: `Bearer ${config.mediaApiToken}`,
    'content-type': 'application/json'
  };
  let roomCreated = false;
  let roomClosed = false;
  let recordingObjectStatus: string | undefined;
  let recordingExportBytes: number | undefined;

  try {
    await jsonRequest(fetchImpl, steps, 'create_room', `${baseUrl}/api/media/livekit/rooms`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenant_id: config.tenantId,
        purpose: 'video_service',
        room_name: roomName,
        metadata: {
          business_ref: {
            type: 'media_smoke',
            id: roomName
          }
        }
      })
    });
    roomCreated = true;

    const issuedToken = await jsonRequest(fetchImpl, steps, 'issue_token', mediaUrl(baseUrl, '/api/media/livekit/token', {
      room_name: roomName,
      identity: 'agent_token_smoke',
      role: 'agent',
      tenant_id: config.tenantId
    }), { headers });
    assertConfiguredLiveKitToken(config, 'issue_token', issuedToken);

    await jsonRequest(fetchImpl, steps, 'agent_dispatch', `${baseUrl}/api/media/livekit/agent-dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenant_id: config.tenantId,
        room_name: roomName,
        agent_name: 'media-smoke-agent',
        metadata: {
          business_ref: `media_smoke:${roomName}`
        }
      })
    });

    const agentJoin = await jsonRequest(fetchImpl, steps, 'agent_join', mediaUrl(baseUrl, '/api/media/livekit/join', {
      channel: 'webrtc',
      room_name: roomName,
      identity: 'agent_smoke',
      role: 'agent',
      tenant_id: config.tenantId,
      media: 'video'
    }), { headers });
    assertConfiguredJoinToken(config, 'agent_join', agentJoin);

    const customerJoin = await jsonRequest(fetchImpl, steps, 'customer_join', mediaUrl(baseUrl, '/api/media/livekit/join', {
      channel: 'webrtc',
      room_name: roomName,
      identity: 'customer_smoke',
      role: 'customer',
      tenant_id: config.tenantId,
      media: 'video'
    }), { headers }) as { joinPath?: unknown; join_path?: unknown };
    assertConfiguredJoinToken(config, 'customer_join', customerJoin);
    const customerJoinPath = readString(customerJoin.joinPath) || readString(customerJoin.join_path);
    assertSignedCustomerJoinPath(config, 'customer_join', customerJoinPath);

    const recording = await jsonRequest(fetchImpl, steps, 'start_recording', `${baseUrl}/api/media/livekit/recordings/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenant_id: config.tenantId,
        room_name: roomName,
        business_ref: {
          type: 'media_smoke',
          id: roomName,
          display_name: 'Media smoke test'
        },
        format: 'mp4',
        has_video: true
      })
    }) as { id?: unknown; egress_id?: unknown };

    const recordingId = String(recording.id || '');
    const egressId = String(recording.egress_id || '');
    if (!recordingId) throw new Error('recordings/start did not return id');
    if (!egressId) throw new Error('recordings/start did not return egress_id');

    await jsonRequest(fetchImpl, steps, 'fetch_recording', mediaUrl(
      baseUrl,
      `/api/media/livekit/recordings/${encodeURIComponent(recordingId)}`,
      { tenant_id: config.tenantId }
    ), { headers });

    await jsonRequest(fetchImpl, steps, 'stop_recording', mediaUrl(
      baseUrl,
      `/api/media/livekit/recordings/${encodeURIComponent(egressId)}/stop`,
      { tenant_id: config.tenantId }
    ), { method: 'POST', headers });

    if (config.verifyRecordingObject) {
      const inspection = await waitForReadableRecordingObject(
        fetchImpl,
        steps,
        mediaUrl(
          baseUrl,
          `/api/media/livekit/recordings/${encodeURIComponent(recordingId)}/object`,
          { tenant_id: config.tenantId }
        ),
        headers,
        config.recordingObjectTimeoutMs || 60_000,
        config.recordingObjectPollIntervalMs || 2_000
      );
      recordingObjectStatus = readString(inspection.status) || 'readable';
      recordingExportBytes = await binaryRequest(
        fetchImpl,
        steps,
        'export_recording',
        mediaUrl(
          baseUrl,
          `/api/media/livekit/recordings/${encodeURIComponent(recordingId)}/export`,
          { tenant_id: config.tenantId }
        ),
        { headers }
      );
    }

    await jsonRequest(fetchImpl, steps, 'list_participants', mediaUrl(
      baseUrl,
      `/api/media/livekit/rooms/${encodeURIComponent(roomName)}/participants`,
      { tenant_id: config.tenantId, include_left: '1' }
    ), { headers });

    if (closeRoomOnExit) {
      await closeSmokeRoom(fetchImpl, steps, baseUrl, headers, roomName, config.tenantId, 'close_room');
      roomClosed = true;

      await jsonRequest(fetchImpl, steps, 'closed_room_rejects_join', mediaUrl(baseUrl, '/api/media/livekit/join', {
        channel: 'webrtc',
        room_name: roomName,
        identity: 'customer_after_close',
        role: 'customer',
        tenant_id: config.tenantId,
        media: 'video'
      }), { headers }, [409]);
    }

    return {
      roomName,
      recordingId,
      egressId,
      customerJoinPath,
      closeRoomOnExit,
      recordingObjectStatus,
      recordingExportBytes,
      steps
    };
  } catch (error) {
    if (closeRoomOnExit && roomCreated && !roomClosed) {
      try {
        await closeSmokeRoom(fetchImpl, steps, baseUrl, headers, roomName, config.tenantId, 'cleanup_room_after_failure');
      } catch (cleanupError) {
        throw appendCleanupFailure(error, cleanupError);
      }
    }
    throw error;
  }
}

async function waitForReadableRecordingObject(
  fetchImpl: FetchLike,
  steps: LiveKitMediaSmokeStep[],
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  while (true) {
    const response = await fetchImpl(url, { headers });
    const payload = asRecord(await readJson(response)) || {};
    lastStatus = readString(payload.status) || `http_${response.status}`;
    if (response.status !== 200) {
      throw new Error(`check_recording_object failed with ${response.status}: ${JSON.stringify(payload)}`);
    }
    if (payload.readable === true && lastStatus === 'readable') {
      steps.push({ name: 'check_recording_object', status: response.status });
      return payload;
    }
    if (Date.now() >= deadline) {
      throw new Error(`recording object was not readable before timeout: ${lastStatus}`);
    }
    await delay(pollIntervalMs);
  }
}

async function binaryRequest(
  fetchImpl: FetchLike,
  steps: LiveKitMediaSmokeStep[],
  name: string,
  url: string,
  init: RequestInit = {}
): Promise<number> {
  const response = await fetchImpl(url, init);
  steps.push({ name, status: response.status });
  if (response.status !== 200) {
    throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(await readJson(response))}`);
  }
  const size = (await response.arrayBuffer()).byteLength;
  if (size < 1) throw new Error(`${name} returned an empty recording object`);
  return size;
}

async function jsonRequest(
  fetchImpl: FetchLike,
  steps: LiveKitMediaSmokeStep[],
  name: string,
  url: string,
  init: RequestInit = {},
  okStatuses: number[] = [200]
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
  steps: LiveKitMediaSmokeStep[],
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
  ), { method: 'POST', headers });
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

function assertConfiguredJoinToken(
  config: LiveKitMediaSmokeConfig,
  stepName: string,
  payload: unknown
): void {
  if (!config.requireConfiguredLiveKit) return;
  const token = asRecord(payload)?.token;
  assertConfiguredLiveKitToken(config, stepName, token);
}

function assertConfiguredLiveKitToken(
  config: LiveKitMediaSmokeConfig,
  stepName: string,
  payload: unknown
): void {
  if (!config.requireConfiguredLiveKit) return;
  const token = asRecord(payload);
  const tokenValue = readString(token?.token);
  if (!token || token.configured !== true || tokenValue?.startsWith('dev-token:')) {
    throw new Error(`${stepName} returned an unconfigured LiveKit token`);
  }
}

function assertSignedCustomerJoinPath(
  config: LiveKitMediaSmokeConfig,
  stepName: string,
  joinPath: string | undefined
): void {
  if (!config.requireSignedCustomerJoinPath) return;
  if (!joinPath) {
    throw new Error(`${stepName} did not return a signed customer join path`);
  }
  const url = new URL(joinPath, 'http://opc.local');
  if (!url.searchParams.get('invite') || !url.searchParams.get('expires_at')) {
    throw new Error(`${stepName} did not return a signed customer join path`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('media smoke timing values must be positive integers');
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = createLiveKitMediaSmokeConfigFromEnv(process.env);
  const result = await runLiveKitMediaSmoke(config);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
