import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type VideoReadinessTarget =
  | 'media'
  | 'avatar'
  | 'ai-callback'
  | 'agent-browser'
  | 'customer-browser'
  | 'web-assist-browser'
  | 'collaboration'
  | 'remote-gateway'
  | 'sip-volte';

export type VideoReadinessStepTarget = VideoReadinessTarget | 'media-cleanup';

export interface VideoReadinessSuiteConfig {
  targets: VideoReadinessTarget[];
  continueOnFailure: boolean;
  env: NodeJS.ProcessEnv;
}

export interface VideoReadinessCommandMeta {
  target: VideoReadinessTarget;
  env: NodeJS.ProcessEnv;
}

export interface VideoReadinessCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type VideoReadinessCommandRunner = (
  command: string,
  args: string[],
  meta: VideoReadinessCommandMeta
) => Promise<VideoReadinessCommandResult>;

export interface VideoReadinessSuiteStep {
  target: VideoReadinessStepTarget;
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export type VideoReadinessFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface VideoReadinessSuiteResult {
  ok: boolean;
  steps: VideoReadinessSuiteStep[];
}

export class VideoReadinessSuiteError extends Error {
  readonly result: VideoReadinessSuiteResult;

  constructor(message: string, result: VideoReadinessSuiteResult) {
    super(message);
    this.name = 'VideoReadinessSuiteError';
    this.result = result;
  }
}

interface TargetDefinition {
  target: VideoReadinessTarget;
  command: string;
  args: string[];
  requirements: Array<EnvRequirement | EnvAlternativeRequirement>;
  customRequirements?: (env: NodeJS.ProcessEnv) => string[];
}

interface EnvRequirement {
  type: 'single';
  key: string;
}

interface EnvAlternativeRequirement {
  type: 'any';
  label: string;
  keys: string[];
}

const targetDefinitions: Record<VideoReadinessTarget, TargetDefinition> = {
  media: {
    target: 'media',
    command: 'npm',
    args: ['run', 'smoke:media'],
    requirements: [
      { type: 'single', key: 'OPC_BASE_URL' },
      {
        type: 'any',
        label: 'OPC_MEDIA_API_TOKEN or LIVEKIT_MEDIA_API_TOKEN',
        keys: ['OPC_MEDIA_API_TOKEN', 'LIVEKIT_MEDIA_API_TOKEN']
      },
      {
        type: 'any',
        label: 'OPC_MEDIA_SMOKE_TENANT_ID or OPC_TENANT_ID',
        keys: ['OPC_MEDIA_SMOKE_TENANT_ID', 'OPC_TENANT_ID']
      },
      {
        type: 'any',
        label: 'OPC_MEDIA_INVITE_SECRET or LIVEKIT_MEDIA_INVITE_SECRET',
        keys: ['OPC_MEDIA_INVITE_SECRET', 'LIVEKIT_MEDIA_INVITE_SECRET']
      }
    ]
  },
  avatar: {
    target: 'avatar',
    command: 'npm',
    args: ['run', 'smoke:media:avatar'],
    requirements: [
      { type: 'single', key: 'LIVEKIT_URL' },
      { type: 'single', key: 'LIVEKIT_API_KEY' },
      { type: 'single', key: 'LIVEKIT_API_SECRET' }
    ]
  },
  'ai-callback': {
    target: 'ai-callback',
    command: 'npm',
    args: ['run', 'smoke:media:ai-callback'],
    requirements: [
      { type: 'single', key: 'OPC_BASE_URL' },
      { type: 'single', key: 'OPC_API_KEY' },
      {
        type: 'any',
        label: 'OPC_MEDIA_API_TOKEN or LIVEKIT_MEDIA_API_TOKEN',
        keys: ['OPC_MEDIA_API_TOKEN', 'LIVEKIT_MEDIA_API_TOKEN']
      },
      {
        type: 'any',
        label: 'OPC_AI_CALLBACK_SMOKE_TENANT_ID or OPC_TENANT_ID',
        keys: ['OPC_AI_CALLBACK_SMOKE_TENANT_ID', 'OPC_TENANT_ID']
      }
    ]
  },
  'agent-browser': {
    target: 'agent-browser',
    command: 'npm',
    args: ['run', 'smoke:media:browser'],
    requirements: [
      { type: 'single', key: 'OPC_FRONTEND_URL' },
      {
        type: 'any',
        label: 'OPC_BROWSER_SMOKE_TENANT_ID or OPC_TENANT_ID',
        keys: ['OPC_BROWSER_SMOKE_TENANT_ID', 'OPC_TENANT_ID']
      },
      { type: 'single', key: 'OPC_BROWSER_SMOKE_AGENT_A_TOKEN' },
      { type: 'single', key: 'OPC_BROWSER_SMOKE_AGENT_A_USER_ID' },
      { type: 'single', key: 'OPC_BROWSER_SMOKE_AGENT_A_SEAT_ID' },
      { type: 'single', key: 'OPC_BROWSER_SMOKE_AGENT_B_TOKEN' },
      { type: 'single', key: 'OPC_BROWSER_SMOKE_AGENT_B_USER_ID' },
      { type: 'single', key: 'OPC_BROWSER_SMOKE_AGENT_B_SEAT_ID' }
    ]
  },
  'customer-browser': {
    target: 'customer-browser',
    command: 'npm',
    args: ['run', 'smoke:media:customer-browser'],
    requirements: [
      { type: 'single', key: 'OPC_FRONTEND_URL' },
      {
        type: 'any',
        label: 'OPC_CUSTOMER_VIDEO_URL or OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME',
        keys: ['OPC_CUSTOMER_VIDEO_URL', 'OPC_CUSTOMER_BROWSER_SMOKE_URL', 'OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME']
      },
      {
        type: 'any',
        label: 'OPC_CUSTOMER_VIDEO_URL or OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID or OPC_TENANT_ID',
        keys: ['OPC_CUSTOMER_VIDEO_URL', 'OPC_CUSTOMER_BROWSER_SMOKE_URL', 'OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID', 'OPC_TENANT_ID']
      }
    ]
  },
  'web-assist-browser': {
    target: 'web-assist-browser',
    command: 'npm',
    args: ['run', 'smoke:media:web-assist-browser'],
    requirements: [
      { type: 'single', key: 'OPC_FRONTEND_URL' },
      {
        type: 'any',
        label: 'OPC_WEB_ASSIST_CUSTOMER_URL or OPC_REMOTE_ASSIST_CUSTOMER_URL',
        keys: ['OPC_WEB_ASSIST_CUSTOMER_URL', 'OPC_REMOTE_ASSIST_CUSTOMER_URL']
      },
      { type: 'single', key: 'OPC_WEB_ASSIST_ENGINEER_TOKEN' },
      { type: 'single', key: 'OPC_WEB_ASSIST_ENGINEER_USER_ID' },
      {
        type: 'any',
        label: 'OPC_WEB_ASSIST_TENANT_ID or OPC_TENANT_ID',
        keys: ['OPC_WEB_ASSIST_TENANT_ID', 'OPC_TENANT_ID']
      }
    ]
  },
  collaboration: {
    target: 'collaboration',
    command: 'npm',
    args: ['run', 'smoke:collaboration'],
    requirements: [
      { type: 'single', key: 'OPC_BASE_URL' },
      {
        type: 'any',
        label: 'OPC_COLLAB_SMOKE_API_KEY or OPC_API_KEY',
        keys: ['OPC_COLLAB_SMOKE_API_KEY', 'OPC_API_KEY']
      },
      {
        type: 'any',
        label: 'OPC_COLLAB_SMOKE_TENANT_ID or OPC_TENANT_ID',
        keys: ['OPC_COLLAB_SMOKE_TENANT_ID', 'OPC_TENANT_ID']
      }
    ]
  },
  'remote-gateway': {
    target: 'remote-gateway',
    command: 'npm',
    args: ['run', 'smoke:remote-gateway'],
    requirements: [],
    customRequirements: remoteGatewayRequirements
  },
  'sip-volte': {
    target: 'sip-volte',
    command: 'npm',
    args: ['run', 'smoke:media:sip-volte'],
    requirements: [
      { type: 'single', key: 'LIVEKIT_URL' },
      { type: 'single', key: 'LIVEKIT_API_KEY' },
      { type: 'single', key: 'LIVEKIT_API_SECRET' },
      { type: 'single', key: 'LIVEKIT_SIP_BRIDGE_TARGET' },
      { type: 'single', key: 'RUSTPBX_LIVEKIT_TRUNK' },
      { type: 'single', key: 'RUSTPBX_RWI_URL' },
      { type: 'single', key: 'RUSTPBX_RWI_TOKEN' }
    ]
  }
};

const defaultTargets: VideoReadinessTarget[] = [
  'media',
  'avatar',
  'ai-callback',
  'agent-browser',
  'customer-browser',
  'collaboration',
  'sip-volte'
];

export function createVideoReadinessSuiteConfigFromEnv(
  env: NodeJS.ProcessEnv
): VideoReadinessSuiteConfig {
  return {
    targets: parseTargets(env.OPC_VIDEO_READINESS_TARGETS),
    continueOnFailure: env.OPC_VIDEO_READINESS_CONTINUE_ON_FAILURE === '1',
    env
  };
}

export async function runVideoReadinessSuite(
  config: VideoReadinessSuiteConfig,
  runner: VideoReadinessCommandRunner = runCommand,
  fetchImpl: VideoReadinessFetch = fetch
): Promise<VideoReadinessSuiteResult> {
  assertPreflight(config);

  const steps: VideoReadinessSuiteStep[] = [];
  const runtimeEnv: NodeJS.ProcessEnv = { ...config.env };
  const skippedTargets = new Set<VideoReadinessTarget>();
  if (config.targets.includes('media')) {
    runtimeEnv.OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT = '1';
  }
  if (shouldUseMediaJoinPathForCustomerBrowser(config)) {
    runtimeEnv.OPC_MEDIA_SMOKE_KEEP_ROOM_OPEN = '1';
  }
  for (const target of config.targets) {
    if (skippedTargets.has(target)) continue;
    const definition = targetDefinitions[target];
    const startedAt = Date.now();
    const result = await runReadinessCommandSafely(runner, definition, { target, env: runtimeEnv });
    captureMediaCustomerJoinPath(target, result.stdout, runtimeEnv);
    const step: VideoReadinessSuiteStep = {
      target,
      command: [definition.command, ...definition.args].join(' '),
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr)
    };
    steps.push(step);
    if (step.ok && target === 'media' && requiresMediaCustomerJoinPath(config, runtimeEnv)) {
      const missingJoinPathStep: VideoReadinessSuiteStep = {
        target: 'customer-browser',
        command: 'media customerJoinPath handoff',
        ok: false,
        exitCode: 1,
        durationMs: 0,
        stdout: '',
        stderr: 'media smoke did not return customerJoinPath'
      };
      steps.push(missingJoinPathStep);
      skippedTargets.add('customer-browser');
      await cleanupChainedMediaRoom(runtimeEnv, fetchImpl, steps, config.continueOnFailure);
      if (!config.continueOnFailure) {
        throw new VideoReadinessSuiteError('media smoke did not return customerJoinPath', {
          ok: false,
          steps
        });
      }
    }
    if (target === 'customer-browser') {
      await cleanupChainedMediaRoom(runtimeEnv, fetchImpl, steps, config.continueOnFailure);
    }
    if (!step.ok && !config.continueOnFailure) {
      await cleanupChainedMediaRoom(runtimeEnv, fetchImpl, steps, false);
      throw new VideoReadinessSuiteError(
        `video readiness target ${target} failed with exit code ${result.exitCode}`,
        { ok: false, steps }
      );
    }
  }

  return {
    ok: steps.every((step) => step.ok),
    steps
  };
}

async function runReadinessCommandSafely(
  runner: VideoReadinessCommandRunner,
  definition: TargetDefinition,
  meta: VideoReadinessCommandMeta
): Promise<VideoReadinessCommandResult> {
  try {
    return await runner(definition.command, definition.args, meta);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseTargets(raw: string | undefined): VideoReadinessTarget[] {
  if (!raw?.trim()) return [...defaultTargets];
  const targets: VideoReadinessTarget[] = [];
  const seen = new Set<VideoReadinessTarget>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const target = normalizeTarget(trimmed);
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  return targets;
}

function normalizeTarget(value: string): VideoReadinessTarget {
  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized === 'browser' || normalized === 'agent-browser') return 'agent-browser';
  if (normalized === 'ai' || normalized === 'ai-callback' || normalized === 'callback') return 'ai-callback';
  if (normalized === 'customer' || normalized === 'customer-browser') return 'customer-browser';
  if (
    normalized === 'web-assist' ||
    normalized === 'web-assist-browser' ||
    normalized === 'remote-assist-browser'
  ) return 'web-assist-browser';
  if (
    normalized === 'collab' ||
    normalized === 'collaboration' ||
    normalized === 'remote' ||
    normalized === 'remote-assistance'
  ) return 'collaboration';
  if (
    normalized === 'gateway' ||
    normalized === 'remote-gateway' ||
    normalized === 'meshcentral' ||
    normalized === 'guacamole' ||
    normalized === 'rustdesk'
  ) return 'remote-gateway';
  if (normalized === 'sip' || normalized === 'sip-volte' || normalized === 'volte') return 'sip-volte';
  if (normalized === 'media' || normalized === 'avatar') return normalized;
  throw new Error(`Unknown video readiness target: ${value}`);
}

function assertPreflight(config: VideoReadinessSuiteConfig): void {
  const missingByTarget = config.targets
    .map((target) => {
      if (target === 'customer-browser' && canReceiveCustomerUrlFromEarlierMedia(config)) {
        return '';
      }
      const missing = missingRequirements(targetDefinitions[target], config.env);
      return missing.length ? `${target}: ${missing.join(', ')}` : '';
    })
    .filter(Boolean);
  if (missingByTarget.length) {
    throw new Error(`video readiness preflight failed:\n${missingByTarget.join('\n')}`);
  }
}

function canReceiveCustomerUrlFromEarlierMedia(config: VideoReadinessSuiteConfig): boolean {
  if (hasEnv(config.env, 'OPC_CUSTOMER_VIDEO_URL') || hasEnv(config.env, 'OPC_CUSTOMER_BROWSER_SMOKE_URL')) {
    return false;
  }
  const customerIndex = config.targets.indexOf('customer-browser');
  const mediaIndex = config.targets.indexOf('media');
  if (customerIndex < 0 || mediaIndex < 0 || mediaIndex > customerIndex) return false;
  return Boolean(config.env.OPC_FRONTEND_URL?.trim());
}

function shouldUseMediaJoinPathForCustomerBrowser(config: VideoReadinessSuiteConfig): boolean {
  return canReceiveCustomerUrlFromEarlierMedia(config);
}

function requiresMediaCustomerJoinPath(
  config: VideoReadinessSuiteConfig,
  env: NodeJS.ProcessEnv
): boolean {
  return shouldUseMediaJoinPathForCustomerBrowser(config) && !hasEnv(env, 'OPC_CUSTOMER_VIDEO_URL');
}

function missingRequirements(definition: TargetDefinition, env: NodeJS.ProcessEnv): string[] {
  return [
    ...definition.requirements
    .map((requirement) => missingRequirement(requirement, env))
      .filter((missing): missing is string => Boolean(missing)),
    ...(definition.customRequirements?.(env) || [])
  ];
}

function remoteGatewayRequirements(env: NodeJS.ProcessEnv): string[] {
  const provider = String(env.OPC_REMOTE_GATEWAY_PROVIDER || 'rustdesk').trim().toLowerCase();
  const missing: string[] = [];
  if (provider !== 'meshcentral' && provider !== 'guacamole' && provider !== 'rustdesk') {
    return ['OPC_REMOTE_GATEWAY_PROVIDER must be meshcentral, guacamole, or rustdesk'];
  }
  if (provider === 'rustdesk') {
    if (!hasAnyEnv(env, ['OPC_RUSTDESK_CONTROL_PLANE_BASE_URL', 'OPC_REMOTE_GATEWAY_BASE_URL'])) {
      missing.push('OPC_RUSTDESK_CONTROL_PLANE_BASE_URL or OPC_REMOTE_GATEWAY_BASE_URL is required');
    }
    if (!hasAnyEnv(env, ['OPC_RUSTDESK_API_TOKEN', 'OPC_REMOTE_GATEWAY_API_TOKEN'])) {
      missing.push('OPC_RUSTDESK_API_TOKEN or OPC_REMOTE_GATEWAY_API_TOKEN is required');
    }
  } else {
    if (!hasEnv(env, 'OPC_REMOTE_GATEWAY_BASE_URL')) missing.push('OPC_REMOTE_GATEWAY_BASE_URL is required');
    if (!hasEnv(env, 'OPC_REMOTE_GATEWAY_API_TOKEN')) missing.push('OPC_REMOTE_GATEWAY_API_TOKEN is required');
  }
  if (!hasEnv(env, 'OPC_REMOTE_GATEWAY_TARGET_ID')) {
    missing.push('OPC_REMOTE_GATEWAY_TARGET_ID is required');
  }
  if (envFlag(env.OPC_RUSTDESK_CHECK_DEVICE_ONLINE)) {
    if (!hasAnyEnv(env, ['OPC_REMOTE_GATEWAY_TENANT_ID', 'OPC_RUSTDESK_EDGE_TENANT_ID', 'OPC_TENANT_ID'])) {
      missing.push('OPC_REMOTE_GATEWAY_TENANT_ID, OPC_RUSTDESK_EDGE_TENANT_ID, or OPC_TENANT_ID is required when OPC_RUSTDESK_CHECK_DEVICE_ONLINE=1');
    }
    if (!hasAnyEnv(env, ['OPC_API_KEY', 'OPC_COLLABORATION_API_KEY'])) {
      missing.push('OPC_API_KEY or OPC_COLLABORATION_API_KEY is required when OPC_RUSTDESK_CHECK_DEVICE_ONLINE=1');
    }
  }
  return missing;
}

function missingRequirement(
  requirement: EnvRequirement | EnvAlternativeRequirement,
  env: NodeJS.ProcessEnv
): string | null {
  if (requirement.type === 'single') {
    return hasEnv(env, requirement.key) ? null : `${requirement.key} is required`;
  }
  return requirement.keys.some((key) => hasEnv(env, key)) ? null : `${requirement.label} is required`;
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function hasAnyEnv(env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return keys.some((key) => hasEnv(env, key));
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function runCommand(
  command: string,
  args: string[],
  meta: VideoReadinessCommandMeta
): Promise<VideoReadinessCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: meta.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr: stderr || (code === 0 ? '' : `${meta.target} failed`)
      });
    });
  });
}

function captureMediaCustomerJoinPath(
  target: VideoReadinessTarget,
  stdout: string,
  env: NodeJS.ProcessEnv
): void {
  if (target !== 'media' || hasEnv(env, 'OPC_CUSTOMER_VIDEO_URL')) return;
  const payload = parseLastJsonObject(stdout);
  const joinPath = readString(payload?.customerJoinPath) || readString(payload?.customer_join_path);
  const roomName = readString(payload?.roomName) || readString(payload?.room_name);
  if (joinPath) env.OPC_CUSTOMER_VIDEO_URL = joinPath;
  if (roomName) env.OPC_VIDEO_READINESS_MEDIA_ROOM_NAME = roomName;
}

function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  let parsedObject: Record<string, unknown> | null = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== '{') continue;
    try {
      const parsed = JSON.parse(trimmed.slice(index));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedObject = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning: npm may print command headers before the JSON payload.
    }
  }
  return parsedObject;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function trimOutput(value: string, maxLength = 8000): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

async function cleanupChainedMediaRoom(
  env: NodeJS.ProcessEnv,
  fetchImpl: VideoReadinessFetch,
  steps: VideoReadinessSuiteStep[],
  continueOnFailure: boolean
): Promise<void> {
  const roomName = env.OPC_VIDEO_READINESS_MEDIA_ROOM_NAME;
  if (!roomName || env.OPC_VIDEO_READINESS_MEDIA_ROOM_CLEANED === '1') return;

  const baseUrl = env.OPC_BASE_URL?.replace(/\/+$/, '') || '';
  const tenantId = env.OPC_MEDIA_SMOKE_TENANT_ID || env.OPC_TENANT_ID || '';
  const mediaApiToken = env.OPC_MEDIA_API_TOKEN || env.LIVEKIT_MEDIA_API_TOKEN || '';
  if (!baseUrl || !tenantId || !mediaApiToken) return;

  const startedAt = Date.now();
  const url = new URL(`/api/media/livekit/rooms/${encodeURIComponent(roomName)}/close`, baseUrl);
  url.searchParams.set('tenant_id', tenantId);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${mediaApiToken}` }
  });
  const responseBody = await response.text();
  env.OPC_VIDEO_READINESS_MEDIA_ROOM_CLEANED = '1';
  const step: VideoReadinessSuiteStep = {
    target: 'media-cleanup' as const,
    command: `POST ${url.pathname}`,
    ok: response.status >= 200 && response.status < 300,
    exitCode: response.status,
    durationMs: Date.now() - startedAt,
    stdout: trimOutput(responseBody),
    stderr:
      response.status >= 200 && response.status < 300
        ? ''
        : trimOutput(response.statusText || responseBody || `HTTP ${response.status}`)
  };
  steps.push(step);
  if (!step.ok && !continueOnFailure) {
    throw new VideoReadinessSuiteError(
      `video readiness media cleanup failed with status ${response.status}`,
      { ok: false, steps }
    );
  }
}

async function main(): Promise<void> {
  const config = createVideoReadinessSuiteConfigFromEnv(process.env);
  try {
    const result = await runVideoReadinessSuite(config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (error instanceof VideoReadinessSuiteError) {
      console.log(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
