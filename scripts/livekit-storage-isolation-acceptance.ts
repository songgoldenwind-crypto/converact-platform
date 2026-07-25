import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AccessToken,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient
} from 'livekit-server-sdk';

export interface LiveKitStorageIsolationConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  composeProject: string;
  composeFiles: string[];
  composeEnvFile: string;
  storageService: string;
  storageInitService: string;
  outputFile: string;
  timeoutMs: number;
}

export interface LiveKitMediaPeerSnapshot {
  identity: string;
  state: string;
  remoteParticipants: number;
  remotePublications: number;
  localPublications: number;
  inboundAudioBytes: number;
  inboundVideoBytes: number;
  outboundAudioBytes: number;
  outboundVideoBytes: number;
  inboundPackets: number;
  outboundPackets: number;
  videoFramesDecoded: number;
}

export interface LiveKitStorageIsolationRuntime {
  createRoom(roomName: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  openPeers(roomName: string): Promise<void>;
  closePeers(): Promise<void>;
  snapshotPeers(): Promise<readonly LiveKitMediaPeerSnapshot[]>;
  startRecording(roomName: string, objectKey: string): Promise<{ egressId: string }>;
  getRecording(egressId: string): Promise<{ status: 'starting' | 'active' | 'complete' | 'failed' | 'aborted'; error: string }>;
  stopRecording(egressId: string): Promise<void>;
  stopStorage(): Promise<void>;
  restoreStorage(): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

export interface LiveKitStorageIsolationResult {
  schema_version: 1;
  status: 'passed_controlled_runtime';
  room_name: string;
  egress_id: string;
  media_before: readonly LiveKitMediaPeerSnapshot[];
  media_during_storage_outage: readonly LiveKitMediaPeerSnapshot[];
  media_after_recording_failure: readonly LiveKitMediaPeerSnapshot[];
  media_after_storage_recovery: readonly LiveKitMediaPeerSnapshot[];
  recording_terminal_status: 'failed';
  recording_failure_code: string;
  media_transport_progress_verified: true;
  recovery_egress_id: string;
  recovery_recording_terminal_status: 'complete';
  storage_recovered: true;
}

interface BrowserPageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  addScriptTag(options: { path: string }): Promise<unknown>;
  evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>;
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>;
}

interface BrowserContextLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<BrowserLike>;
  };
}

const execFileAsync = promisify(execFile);

export async function runLiveKitStorageIsolationAcceptance(
  config: LiveKitStorageIsolationConfig,
  runtime: LiveKitStorageIsolationRuntime
): Promise<LiveKitStorageIsolationResult> {
  const roomName = `ivekit-storage-isolation-${Date.now().toString(36)}`;
  let roomCreated = false;
  let peersOpened = false;
  let storageStopped = false;
  let egressId = '';
  let recoveryEgressId = '';
  let recordingTerminal = false;
  let recoveryRecordingTerminal = false;

  try {
    await runtime.createRoom(roomName);
    roomCreated = true;
    peersOpened = true;
    await runtime.openPeers(roomName);

    const mediaBefore = await waitForMediaContinuity(runtime, Date.now() + config.timeoutMs);
    ({ egressId } = await runtime.startRecording(roomName, `audit/${roomName}.mp4`));
    await waitForRecording(runtime, egressId, Date.now() + config.timeoutMs, ['active']);

    await runtime.stopStorage();
    storageStopped = true;
    const mediaDuringStorageOutage = await waitForMediaProgress(
      runtime,
      mediaBefore,
      Date.now() + config.timeoutMs
    );

    try {
      await runtime.stopRecording(egressId);
    } catch {
      // Storage failure can make the stop request race the terminal Egress update.
    }
    const terminal = await waitForRecording(
      runtime,
      egressId,
      Date.now() + config.timeoutMs,
      ['complete', 'failed', 'aborted']
    );
    if (terminal.status !== 'failed') {
      throw new Error(`recording did not fail during storage outage: ${terminal.status}`);
    }
    recordingTerminal = true;
    const recordingFailureCode = classifyLiveKitEgressFailure(terminal.error);
    if (recordingFailureCode !== 'storage_upload_failed') {
      throw new Error('recording failure was not caused by storage upload');
    }

    const mediaAfterRecordingFailure = await waitForMediaProgress(
      runtime,
      mediaDuringStorageOutage,
      Date.now() + config.timeoutMs
    );
    await runtime.restoreStorage();
    storageStopped = false;

    ({ egressId: recoveryEgressId } = await runtime.startRecording(
      roomName,
      `recovery/${roomName}.mp4`
    ));
    await waitForRecording(
      runtime,
      recoveryEgressId,
      Date.now() + config.timeoutMs,
      ['active']
    );
    const mediaAfterStorageRecovery = await waitForMediaProgress(
      runtime,
      mediaAfterRecordingFailure,
      Date.now() + config.timeoutMs
    );
    await runtime.stopRecording(recoveryEgressId);
    const recoveryTerminal = await waitForRecording(
      runtime,
      recoveryEgressId,
      Date.now() + config.timeoutMs,
      ['complete', 'failed', 'aborted']
    );
    if (recoveryTerminal.status !== 'complete') {
      throw new Error(`recording did not recover after storage restore: ${recoveryTerminal.status}`);
    }
    recoveryRecordingTerminal = true;

    return {
      schema_version: 1,
      status: 'passed_controlled_runtime',
      room_name: roomName,
      egress_id: egressId,
      media_before: mediaBefore,
      media_during_storage_outage: mediaDuringStorageOutage,
      media_after_recording_failure: mediaAfterRecordingFailure,
      media_after_storage_recovery: mediaAfterStorageRecovery,
      recording_terminal_status: 'failed',
      recording_failure_code: recordingFailureCode,
      media_transport_progress_verified: true,
      recovery_egress_id: recoveryEgressId,
      recovery_recording_terminal_status: 'complete',
      storage_recovered: true
    };
  } finally {
    if (recoveryEgressId && !recoveryRecordingTerminal) {
      await runtime.stopRecording(recoveryEgressId).catch(() => undefined);
    }
    if (egressId && !recordingTerminal) {
      await runtime.stopRecording(egressId).catch(() => undefined);
    }
    if (storageStopped) {
      await runtime.restoreStorage().catch(() => undefined);
    }
    if (peersOpened) {
      await runtime.closePeers().catch(() => undefined);
    }
    if (roomCreated) {
      await runtime.deleteRoom(roomName).catch(() => undefined);
    }
  }
}

export async function createDefaultLiveKitStorageIsolationRuntime(
  config: LiveKitStorageIsolationConfig
): Promise<LiveKitStorageIsolationRuntime> {
  const httpUrl = toHttpUrl(config.livekitUrl);
  const roomService = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
  const egressService = new EgressClient(httpUrl, config.apiKey, config.apiSecret);
  const playwright = await loadLocalPlaywright();
  const livekitClientPath = resolveClientDependency('livekit-client');
  let browser: BrowserLike | undefined;
  const contexts: BrowserContextLike[] = [];
  const pages: BrowserPageLike[] = [];

  return {
    async createRoom(roomName) {
      await roomService.createRoom({ name: roomName, maxParticipants: 2, emptyTimeout: 60 });
    },
    async deleteRoom(roomName) {
      await roomService.deleteRoom(roomName);
    },
    async openPeers(roomName) {
      browser = await playwright.chromium.launch({
        headless: true,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream'
        ]
      });
      for (const identity of ['agent-a', 'agent-b']) {
        const token = await createParticipantToken(config, roomName, identity);
        const context = await browser.newContext({
          permissions: ['camera', 'microphone'],
          viewport: { width: 960, height: 540 }
        });
        contexts.push(context);
        const page = await context.newPage();
        pages.push(page);
        await page.goto(httpUrl, {
          waitUntil: 'domcontentloaded',
          timeout: config.timeoutMs
        });
        await page.addScriptTag({ path: livekitClientPath });
        await connectBrowserPeer(page, config.livekitUrl, token);
      }
    },
    async closePeers() {
      for (const page of pages) {
        await page.evaluate(async () => {
          const state = globalThis as typeof globalThis & {
            __ivekitStorageIsolationRoom?: { disconnect(): Promise<void> };
          };
          await state.__ivekitStorageIsolationRoom?.disconnect();
        }).catch(() => undefined);
      }
      for (const context of contexts.reverse()) {
        await context.close().catch(() => undefined);
      }
      pages.length = 0;
      contexts.length = 0;
      await browser?.close();
      browser = undefined;
    },
    async snapshotPeers() {
      return Promise.all(pages.map((page) =>
        page.evaluate(readLiveKitMediaPeerSnapshotInBrowser)
      ));
    },
    async startRecording(roomName, objectKey) {
      const info = await egressService.startRoomCompositeEgress(
        roomName,
        new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath: objectKey }),
        { layout: 'grid' }
      );
      if (!info.egressId) throw new Error('LiveKit Egress did not return an id');
      return { egressId: info.egressId };
    },
    async getRecording(egressId) {
      const [info] = await egressService.listEgress({ egressId });
      if (!info) throw new Error('LiveKit Egress record is unavailable');
      return {
        status: mapEgressStatus(info.status),
        error: String(info.error || info.errorCode || '')
      };
    },
    async stopRecording(egressId) {
      await egressService.stopEgress(egressId);
    },
    async stopStorage() {
      await runCompose(config, ['stop', config.storageService]);
    },
    async restoreStorage() {
      await runCompose(config, ['up', '-d', config.storageService]);
      await runCompose(config, ['run', '--rm', config.storageInitService]);
    },
    async wait(milliseconds) {
      await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
    }
  };
}

interface BrowserLiveKitRoom {
  state: string;
  engine?: {
    pcManager?: {
      publisher: { getStats(): Promise<BrowserStatsReport> };
      subscriber?: { getStats(): Promise<BrowserStatsReport> };
    };
  };
  localParticipant: {
    identity: string;
    trackPublications: { size: number };
  };
  remoteParticipants: Map<string, { trackPublications: { size: number } }>;
}

interface BrowserStatsReport {
  forEach(callback: (value: unknown) => void): void;
}

export async function readLiveKitMediaPeerSnapshotInBrowser(): Promise<LiveKitMediaPeerSnapshot> {
  const state = globalThis as typeof globalThis & {
    __ivekitStorageIsolationRoom?: BrowserLiveKitRoom;
  };
  const room = state.__ivekitStorageIsolationRoom;
  if (!room) throw new Error('LiveKit browser peer is unavailable');
  const pcManager = room.engine?.pcManager;
  if (!pcManager) throw new Error('LiveKit peer connection manager is unavailable');
  const reports = await Promise.all([
    pcManager.publisher.getStats(),
    pcManager.subscriber?.getStats()
  ]);
  let inboundAudioBytes = 0;
  let inboundVideoBytes = 0;
  let outboundAudioBytes = 0;
  let outboundVideoBytes = 0;
  let inboundPackets = 0;
  let outboundPackets = 0;
  let videoFramesDecoded = 0;
  for (const report of reports) {
    report?.forEach((rawStat) => {
      const stat = rawStat as Record<string, unknown>;
      const kind = stat.kind || stat.mediaType;
      if (stat.type === 'inbound-rtp' && stat.isRemote !== true) {
        const bytesReceived = stat.bytesReceived;
        const packetsReceived = stat.packetsReceived;
        const framesDecoded = stat.framesDecoded;
        const bytes = typeof bytesReceived === 'number' && Number.isFinite(bytesReceived) &&
          bytesReceived >= 0 ? bytesReceived : 0;
        inboundPackets += typeof packetsReceived === 'number' && Number.isFinite(packetsReceived) &&
          packetsReceived >= 0 ? packetsReceived : 0;
        if (kind === 'audio') inboundAudioBytes += bytes;
        if (kind === 'video') {
          inboundVideoBytes += bytes;
          videoFramesDecoded += typeof framesDecoded === 'number' && Number.isFinite(framesDecoded) &&
            framesDecoded >= 0 ? framesDecoded : 0;
        }
      }
      if (stat.type === 'outbound-rtp' && stat.isRemote !== true) {
        const bytesSent = stat.bytesSent;
        const packetsSent = stat.packetsSent;
        const bytes = typeof bytesSent === 'number' && Number.isFinite(bytesSent) &&
          bytesSent >= 0 ? bytesSent : 0;
        outboundPackets += typeof packetsSent === 'number' && Number.isFinite(packetsSent) &&
          packetsSent >= 0 ? packetsSent : 0;
        if (kind === 'audio') outboundAudioBytes += bytes;
        if (kind === 'video') outboundVideoBytes += bytes;
      }
    });
  }
  let remotePublications = 0;
  for (const participant of room.remoteParticipants.values()) {
    remotePublications += participant.trackPublications.size;
  }
  return {
    identity: room.localParticipant.identity,
    state: room.state,
    remoteParticipants: room.remoteParticipants.size,
    remotePublications,
    localPublications: room.localParticipant.trackPublications.size,
    inboundAudioBytes,
    inboundVideoBytes,
    outboundAudioBytes,
    outboundVideoBytes,
    inboundPackets,
    outboundPackets,
    videoFramesDecoded
  };
}

async function connectBrowserPeer(
  page: BrowserPageLike,
  livekitUrl: string,
  token: string
): Promise<void> {
  await page.evaluate(async ({ url, accessToken }) => {
    const state = globalThis as typeof globalThis & {
      LivekitClient?: {
        Room: new (options?: Record<string, unknown>) => BrowserLiveKitRoom & {
          connect(url: string, token: string): Promise<void>;
          localParticipant: BrowserLiveKitRoom['localParticipant'] & {
            setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
            setCameraEnabled(enabled: boolean): Promise<unknown>;
          };
        };
      };
      __ivekitStorageIsolationRoom?: BrowserLiveKitRoom;
    };
    if (!state.LivekitClient) throw new Error('LiveKit browser SDK is unavailable');
    const room = new state.LivekitClient.Room({ adaptiveStream: false, dynacast: false });
    await room.connect(url, accessToken);
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.localParticipant.setCameraEnabled(true);
    state.__ivekitStorageIsolationRoom = room;
  }, { url: livekitUrl, accessToken: token });
}

async function createParticipantToken(
  config: LiveKitStorageIsolationConfig,
  roomName: string,
  identity: string
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, { identity, ttl: '5m' });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true
  });
  return token.toJwt();
}

async function loadLocalPlaywright(): Promise<PlaywrightLike> {
  const entry = resolveClientDependency('playwright');
  const imported = await import(pathToFileURL(entry).href) as unknown as {
    chromium?: PlaywrightLike['chromium'];
    default?: PlaywrightLike;
  };
  const playwright = imported.chromium ? imported as PlaywrightLike : imported.default;
  if (!playwright?.chromium) throw new Error('Playwright Chromium runtime is unavailable');
  return playwright;
}

function resolveClientDependency(packageName: 'playwright' | 'livekit-client'): string {
  const resolver = createRequire(import.meta.url);
  try {
    return resolver.resolve(packageName);
  } catch {
    // The source checkout keeps browser dependencies in the reference client package.
  }
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const roots = [
    join(scriptDirectory, '..', 'clients', 'ivekit-reference'),
    join(process.cwd(), 'clients', 'ivekit-reference')
  ];
  const clientRoot = roots.find((candidate) => existsSync(candidate));
  if (!clientRoot) throw new Error('iveKit reference client dependencies are unavailable');
  return resolver.resolve(packageName, { paths: [clientRoot] });
}

async function runCompose(
  config: LiveKitStorageIsolationConfig,
  action: readonly string[]
): Promise<void> {
  await execFileAsync('docker', createLiveKitStorageIsolationComposeArgs(config, action), {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024
  });
}

export function createLiveKitStorageIsolationComposeArgs(
  config: LiveKitStorageIsolationConfig,
  action: readonly string[]
): string[] {
  return [
    'compose',
    ...(config.composeEnvFile ? ['--env-file', config.composeEnvFile] : []),
    '-p', config.composeProject,
    ...config.composeFiles.flatMap((composeFile) => ['-f', composeFile]),
    ...action
  ];
}

function mapEgressStatus(status: EgressStatus): 'starting' | 'active' | 'complete' | 'failed' | 'aborted' {
  switch (status) {
    case EgressStatus.EGRESS_ACTIVE:
    case EgressStatus.EGRESS_ENDING:
      return 'active';
    case EgressStatus.EGRESS_COMPLETE:
      return 'complete';
    case EgressStatus.EGRESS_FAILED:
    case EgressStatus.EGRESS_LIMIT_REACHED:
      return 'failed';
    case EgressStatus.EGRESS_ABORTED:
      return 'aborted';
    case EgressStatus.EGRESS_STARTING:
    default:
      return 'starting';
  }
}

function toHttpUrl(value: string): string {
  return value.startsWith('wss://')
    ? `https://${value.slice('wss://'.length)}`
    : `http://${value.slice('ws://'.length)}`;
}

async function waitForMediaContinuity(
  runtime: LiveKitStorageIsolationRuntime,
  deadline: number
): Promise<readonly LiveKitMediaPeerSnapshot[]> {
  let lastError: unknown;
  while (Date.now() <= deadline) {
    const snapshots = await runtime.snapshotPeers();
    try {
      assertLiveKitMediaContinuity(snapshots);
      return snapshots;
    } catch (error) {
      lastError = error;
      await runtime.wait(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('LiveKit media continuity timed out');
}

async function waitForMediaProgress(
  runtime: LiveKitStorageIsolationRuntime,
  baseline: readonly LiveKitMediaPeerSnapshot[],
  deadline: number
): Promise<readonly LiveKitMediaPeerSnapshot[]> {
  let lastError: unknown;
  while (Date.now() <= deadline) {
    const snapshots = await runtime.snapshotPeers();
    assertLiveKitMediaContinuity(snapshots);
    try {
      assertLiveKitMediaProgress(baseline, snapshots);
      return snapshots;
    } catch (error) {
      lastError = error;
      await runtime.wait(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('LiveKit media progress timed out');
}

async function waitForRecording(
  runtime: LiveKitStorageIsolationRuntime,
  egressId: string,
  deadline: number,
  expected: ReadonlyArray<'active' | 'complete' | 'failed' | 'aborted'>
): Promise<Awaited<ReturnType<LiveKitStorageIsolationRuntime['getRecording']>>> {
  while (Date.now() <= deadline) {
    const recording = await runtime.getRecording(egressId);
    if (expected.includes(recording.status as typeof expected[number])) return recording;
    if (['complete', 'failed', 'aborted'].includes(recording.status)) {
      throw new Error(`recording reached unexpected terminal status: ${recording.status}`);
    }
    await runtime.wait(250);
  }
  throw new Error(`recording status timed out waiting for ${expected.join(',')}`);
}

export function createLiveKitStorageIsolationConfigFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitStorageIsolationConfig {
  const livekitUrl = required(
    env.OPC_LIVEKIT_STORAGE_ISOLATION_URL || env.LIVEKIT_PUBLIC_URL || env.LIVEKIT_URL,
    'LIVEKIT_URL'
  );
  const apiKey = required(env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY');
  const apiSecret = required(env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET');
  const composeProject = required(
    env.OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT,
    'OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT'
  );
  validateLiveKitUrl(livekitUrl);
  validateIdentifier(composeProject, 'OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT');
  const storageService = env.OPC_LIVEKIT_STORAGE_ISOLATION_STORAGE_SERVICE || 'minio';
  const storageInitService = env.OPC_LIVEKIT_STORAGE_ISOLATION_STORAGE_INIT_SERVICE || 'minio-init';
  validateIdentifier(storageService, 'OPC_LIVEKIT_STORAGE_ISOLATION_STORAGE_SERVICE');
  validateIdentifier(storageInitService, 'OPC_LIVEKIT_STORAGE_ISOLATION_STORAGE_INIT_SERVICE');
  const composeFiles = readComposeFiles(env);

  return {
    livekitUrl,
    apiKey,
    apiSecret,
    composeProject,
    composeFiles,
    composeEnvFile: safeText(
      env.OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_ENV_FILE || '',
      'OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_ENV_FILE'
    ),
    storageService,
    storageInitService,
    outputFile: safeText(env.OPC_LIVEKIT_STORAGE_ISOLATION_OUTPUT_FILE || '', 'output file'),
    timeoutMs: boundedInteger(
      env.OPC_LIVEKIT_STORAGE_ISOLATION_TIMEOUT_MS,
      30_000,
      5_000,
      300_000,
      'OPC_LIVEKIT_STORAGE_ISOLATION_TIMEOUT_MS'
    )
  };
}

function readComposeFiles(env: NodeJS.ProcessEnv): string[] {
  const encoded = env.OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES;
  const legacy = env.OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILE;
  if (encoded && legacy) {
    throw new Error('only one storage isolation Compose file setting may be used');
  }
  if (!encoded) {
    return [safeText(legacy || 'docker-compose.callcenter.yml', 'Compose file').trim()]
      .filter(Boolean);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(safeText(encoded, 'OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES'));
  } catch {
    throw new Error('OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES is invalid');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 4 ||
      parsed.some((value) => typeof value !== 'string' || !safeText(value, 'Compose file').trim())) {
    throw new Error('OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES is invalid');
  }
  const result = parsed.map((value) => String(value).trim());
  if (new Set(result).size !== result.length) {
    throw new Error('OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES is invalid');
  }
  return result;
}

export function assertLiveKitMediaContinuity(
  snapshots: readonly LiveKitMediaPeerSnapshot[]
): void {
  const identities = new Set(snapshots.map((snapshot) => snapshot.identity));
  const healthy = snapshots.length === 2 && identities.size === 2 && snapshots.every((snapshot) =>
    snapshot.state === 'connected' &&
    snapshot.remoteParticipants === 1 &&
    snapshot.remotePublications >= 2 &&
    snapshot.localPublications >= 2
  );
  if (!healthy) throw new Error('LiveKit media continuity requirement failed');
}

export function assertLiveKitMediaProgress(
  before: readonly LiveKitMediaPeerSnapshot[],
  after: readonly LiveKitMediaPeerSnapshot[]
): void {
  assertLiveKitMediaContinuity(before);
  assertLiveKitMediaContinuity(after);
  const beforeByIdentity = new Map(before.map((snapshot) => [snapshot.identity, snapshot]));
  const counters: ReadonlyArray<keyof LiveKitMediaPeerSnapshot> = [
    'inboundAudioBytes',
    'inboundVideoBytes',
    'outboundAudioBytes',
    'outboundVideoBytes',
    'inboundPackets',
    'outboundPackets',
    'videoFramesDecoded'
  ];
  const progressed = after.every((snapshot) => {
    const previous = beforeByIdentity.get(snapshot.identity);
    return previous && counters.every((counter) =>
      typeof previous[counter] === 'number' &&
      typeof snapshot[counter] === 'number' &&
      snapshot[counter] > previous[counter]
    );
  });
  if (!progressed) throw new Error('LiveKit media progress requirement failed');
}

export function classifyLiveKitEgressFailure(error: string): string {
  return /(?:s3|putobject|object storage|no such bucket|nosuchbucket|upload failed)/i.test(error)
    ? 'storage_upload_failed'
    : 'egress_failed';
}

export function writeLiveKitStorageIsolationResult(
  outputFile: string,
  result: LiveKitStorageIsolationResult
): void {
  const resolvedOutput = resolve(outputFile);
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  chmodSync(resolvedOutput, 0o600);
}

function required(value: string | undefined, name: string): string {
  const result = safeText(value || '', name).trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function safeText(value: string, name: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function validateLiveKitUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('LIVEKIT_URL is invalid');
  }
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw new Error('LIVEKIT_URL is invalid');
  }
}

function validateIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`${name} is invalid`);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const config = createLiveKitStorageIsolationConfigFromEnv(process.env);
  const runtime = await createDefaultLiveKitStorageIsolationRuntime(config);
  const result = await runLiveKitStorageIsolationAcceptance(config, runtime);
  if (config.outputFile) {
    writeLiveKitStorageIsolationResult(config.outputFile, result);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('LiveKit storage isolation acceptance failed');
    process.exit(1);
  });
}
