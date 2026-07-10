import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MediaConfigRenderInput {
  outputDir: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitWsUrl: string;
  livekitRedisAddress: string;
  livekitWebhookUrl: string;
  livekitRtcTcpPort: number;
  livekitRtcUdpPort: string;
  livekitUseExternalIp: boolean;
  minioEndpoint: string;
  minioBucket: string;
  minioAccessKey: string;
  minioSecretKey: string;
}

export interface MediaConfigRenderResult {
  livekitConfigPath: string;
  egressConfigPath: string;
}

export function createMediaConfigRenderInputFromEnv(env: NodeJS.ProcessEnv): MediaConfigRenderInput {
  return {
    outputDir: normalizeOutputDir(env.OPC_MEDIA_CONFIG_DIR || '.runtime/media'),
    livekitApiKey: requiredEnv(env, 'LIVEKIT_API_KEY'),
    livekitApiSecret: requiredEnv(env, 'LIVEKIT_API_SECRET'),
    livekitWsUrl: env.OPC_MEDIA_CONFIG_LIVEKIT_URL || 'ws://livekit:7880',
    livekitRedisAddress: env.OPC_MEDIA_CONFIG_REDIS_ADDRESS || 'redis:6379',
    livekitWebhookUrl: env.OPC_MEDIA_CONFIG_WEBHOOK_URL || 'http://opc:3000/api/media/webhooks/livekit',
    livekitRtcTcpPort: parsePort(env.OPC_MEDIA_CONFIG_RTC_TCP_PORT, 'OPC_MEDIA_CONFIG_RTC_TCP_PORT', 7881),
    livekitRtcUdpPort: parsePortRange(env.OPC_MEDIA_CONFIG_RTC_UDP_PORT, 'OPC_MEDIA_CONFIG_RTC_UDP_PORT', '7882-7892'),
    livekitUseExternalIp: parseBoolean(env.OPC_MEDIA_CONFIG_USE_EXTERNAL_IP, 'OPC_MEDIA_CONFIG_USE_EXTERNAL_IP', true),
    minioEndpoint: env.MINIO_ENDPOINT || 'http://minio:9000',
    minioBucket: env.MINIO_BUCKET || 'recordings',
    minioAccessKey: requiredEnv(env, 'MINIO_ACCESS_KEY'),
    minioSecretKey: requiredEnv(env, 'MINIO_SECRET_KEY')
  };
}

export function renderMediaConfigs(input: MediaConfigRenderInput): MediaConfigRenderResult {
  const outputDir = resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const livekitConfigPath = join(outputDir, 'livekit.yaml');
  const egressConfigPath = join(outputDir, 'egress.yaml');

  writeFileSync(livekitConfigPath, renderLiveKitConfig(input));
  writeFileSync(egressConfigPath, renderEgressConfig(input));

  return { livekitConfigPath, egressConfigPath };
}

function renderLiveKitConfig(input: MediaConfigRenderInput): string {
  return [
    'port: 7880',
    'rtc:',
    `  tcp_port: ${input.livekitRtcTcpPort}`,
    `  udp_port: ${input.livekitRtcUdpPort}`,
    `  use_external_ip: ${input.livekitUseExternalIp}`,
    '',
    'redis:',
    `  address: ${yamlQuote(input.livekitRedisAddress)}`,
    '',
    'keys:',
    `  ${yamlQuote(input.livekitApiKey)}: ${yamlQuote(input.livekitApiSecret)}`,
    '',
    'webhook:',
    `  api_key: ${yamlQuote(input.livekitApiKey)}`,
    '  urls:',
    `    - ${yamlQuote(input.livekitWebhookUrl)}`,
    '',
    'room:',
    '  empty_timeout: 300',
    '  max_participants: 10',
    '',
    'logging:',
    '  level: info',
    ''
  ].join('\n');
}

function renderEgressConfig(input: MediaConfigRenderInput): string {
  return [
    'logging:',
    '  level: info',
    `api_key: ${yamlQuote(input.livekitApiKey)}`,
    `api_secret: ${yamlQuote(input.livekitApiSecret)}`,
    `ws_url: ${yamlQuote(input.livekitWsUrl)}`,
    'insecure: true',
    'redis:',
    `  address: ${yamlQuote(input.livekitRedisAddress)}`,
    'storage:',
    '  s3:',
    `    access_key: ${yamlQuote(input.minioAccessKey)}`,
    `    secret: ${yamlQuote(input.minioSecretKey)}`,
    '    region: us-east-1',
    `    endpoint: ${yamlQuote(input.minioEndpoint)}`,
    `    bucket: ${yamlQuote(input.minioBucket)}`,
    '    force_path_style: true',
    ''
  ].join('\n');
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parsePort(value: string | undefined, key: string, fallback: number): number {
  const parsed = value == null || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${key} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function parsePortRange(value: string | undefined, key: string, fallback: string): string {
  const normalized = String(value || fallback).trim();
  const match = normalized.match(/^(\d+)(?:-(\d+))?$/);
  const start = Number(match?.[1]);
  const end = Number(match?.[2] || match?.[1]);
  if (!match || start < 1 || start > 65_535 || end < start || end > 65_535) {
    throw new Error(`${key} must be a port or ascending port range between 1 and 65535`);
  }
  return match[2] ? `${start}-${end}` : String(start);
}

function parseBoolean(value: string | undefined, key: string, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${key} must be true, false, 1, or 0`);
}

function normalizeOutputDir(outputDir: string): string {
  return outputDir.startsWith('../')
    ? resolve('infra', outputDir)
    : outputDir;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

async function main(): Promise<void> {
  const result = renderMediaConfigs(createMediaConfigRenderInputFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
