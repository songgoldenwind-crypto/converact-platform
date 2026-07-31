import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveRedisConnectionOptions,
  type ResolvedRedisConnectionOptions
} from '../src/infra/redis-connection-options.js';
import {
  resolveS3ConnectionConfig,
  type S3ConnectionConfig
} from '../src/storage/s3-connection-config.js';

export interface MediaRedisRenderConfig {
  connection: ResolvedRedisConnectionOptions;
  readTimeoutMs: number;
  writeTimeoutMs: number;
  poolSize: number;
}

export interface LiveKitPliThrottleConfig {
  lowQualityMs: number;
  midQualityMs: number;
  highQualityMs: number;
}

export interface MediaConfigRenderInput {
  outputDir: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitWsUrl: string;
  livekitRedis: MediaRedisRenderConfig;
  livekitWebhookUrl: string;
  livekitRtcTcpPort: number;
  livekitRtcUdpPort: string;
  livekitUseExternalIp: boolean;
  livekitPliThrottle: LiveKitPliThrottleConfig;
  egressHealthPort: number;
  objectStorage: S3ConnectionConfig;
}

export interface MediaConfigRenderResult {
  livekitConfigPath: string;
  egressConfigPath: string;
  redisTlsDir: string;
}

export interface LiveKitEdgeConfigRenderInput extends MediaConfigRenderInput {
  signalDomain: string;
  turnDomain: string;
  ivekitApiDomain?: string;
  tinodePublicDomain?: string;
  ivekitApiHttpPort: number;
  tinodeHttpPort: number;
  acmeEmail: string;
  rtcPortRangeStart: number;
  rtcPortRangeEnd: number;
  turnTlsPort: number;
  turnUdpPort: number;
  livekitServerImageTag: string;
  livekitEgressImageTag: string;
  livekitCaddyl4ImageTag: string;
  livekitRedisImageTag: string;
}

export interface LiveKitEdgeConfigRenderResult extends MediaConfigRenderResult {
  caddyConfigPath: string;
  firewallChecklistPath: string;
  summaryPath: string;
}

export function createMediaConfigRenderInputFromEnv(env: NodeJS.ProcessEnv): MediaConfigRenderInput {
  return {
    outputDir: normalizeOutputDir(env.OPC_MEDIA_CONFIG_DIR || '.runtime/media'),
    livekitApiKey: requiredRuntimeSecret(env, 'LIVEKIT_API_KEY'),
    livekitApiSecret: requiredRuntimeSecret(env, 'LIVEKIT_API_SECRET'),
    livekitWsUrl: env.OPC_MEDIA_CONFIG_LIVEKIT_URL || 'ws://livekit:7880',
    livekitRedis: createMediaRedisRenderConfigFromEnv(env, 'redis:6379'),
    livekitWebhookUrl: env.OPC_MEDIA_CONFIG_WEBHOOK_URL || 'http://opc:3000/api/media/webhooks/livekit',
    livekitRtcTcpPort: parsePort(env.OPC_MEDIA_CONFIG_RTC_TCP_PORT, 'OPC_MEDIA_CONFIG_RTC_TCP_PORT', 7881),
    livekitRtcUdpPort: parsePortRange(env.OPC_MEDIA_CONFIG_RTC_UDP_PORT, 'OPC_MEDIA_CONFIG_RTC_UDP_PORT', '7882-7892'),
    livekitUseExternalIp: parseBoolean(env.OPC_MEDIA_CONFIG_USE_EXTERNAL_IP, 'OPC_MEDIA_CONFIG_USE_EXTERNAL_IP', true),
    livekitPliThrottle: createLiveKitPliThrottleConfigFromEnv(env),
    egressHealthPort: parsePort(env.OPC_MEDIA_CONFIG_EGRESS_HEALTH_PORT, 'OPC_MEDIA_CONFIG_EGRESS_HEALTH_PORT', 8091),
    objectStorage: requiredMediaObjectStorage(env)
  };
}

export function renderMediaConfigs(input: MediaConfigRenderInput): MediaConfigRenderResult {
  const outputDir = resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const livekitConfigPath = join(outputDir, 'livekit.yaml');
  const egressConfigPath = join(outputDir, 'egress.yaml');
  const redisTlsDir = prepareRedisTlsDirectory(outputDir, input.livekitRedis.connection);

  writeSecretFile(livekitConfigPath, renderLiveKitConfig(input));
  writeSecretFile(egressConfigPath, renderEgressConfig(input), 0o640);

  return { livekitConfigPath, egressConfigPath, redisTlsDir };
}

export function createLiveKitEdgeConfigRenderInputFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitEdgeConfigRenderInput {
  const signalDomain = requiredDomain(env, 'LIVEKIT_SIGNAL_DOMAIN');
  const turnDomain = requiredDomain(env, 'LIVEKIT_TURN_DOMAIN');
  if (signalDomain === turnDomain) {
    throw new Error('LIVEKIT_TURN_DOMAIN must differ from LIVEKIT_SIGNAL_DOMAIN');
  }
  const ivekitApiDomain = optionalDomain(env, 'IVEKIT_API_DOMAIN');
  const tinodePublicDomain = optionalDomain(env, 'TINODE_PUBLIC_DOMAIN');
  const domains = [signalDomain, turnDomain, ivekitApiDomain, tinodePublicDomain].filter(Boolean);
  if (new Set(domains).size !== domains.length) {
    throw new Error('LiveKit and iveKit edge domains must be unique');
  }
  const rtcPortRangeStart = parsePort(
    env.OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_START,
    'OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_START',
    50_000
  );
  const rtcPortRangeEnd = parsePort(
    env.OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_END,
    'OPC_LIVEKIT_EDGE_RTC_PORT_RANGE_END',
    60_000
  );
  if (rtcPortRangeEnd < rtcPortRangeStart) {
    throw new Error('RTC port range end must be greater than or equal to start');
  }

  return {
    outputDir: normalizeEdgeOutputDir(env.OPC_LIVEKIT_EDGE_CONFIG_DIR || '.runtime/livekit-edge'),
    signalDomain,
    turnDomain,
    ivekitApiDomain,
    tinodePublicDomain,
    ivekitApiHttpPort: parsePort(env.IVEKIT_API_HTTP_PORT, 'IVEKIT_API_HTTP_PORT', 8300),
    tinodeHttpPort: parsePort(env.TINODE_HTTP_PORT, 'TINODE_HTTP_PORT', 6060),
    acmeEmail: requiredEmail(env, 'LIVEKIT_ACME_EMAIL'),
    livekitApiKey: requiredRuntimeSecret(env, 'LIVEKIT_API_KEY'),
    livekitApiSecret: requiredRuntimeSecret(env, 'LIVEKIT_API_SECRET'),
    livekitWsUrl: env.OPC_MEDIA_CONFIG_LIVEKIT_URL || 'ws://127.0.0.1:7880',
    livekitRedis: createMediaRedisRenderConfigFromEnv(env, '127.0.0.1:6379'),
    livekitWebhookUrl: requiredEnv(env, 'OPC_MEDIA_CONFIG_WEBHOOK_URL'),
    livekitRtcTcpPort: parsePort(env.OPC_MEDIA_CONFIG_RTC_TCP_PORT, 'OPC_MEDIA_CONFIG_RTC_TCP_PORT', 7881),
    livekitRtcUdpPort: '',
    livekitUseExternalIp: true,
    livekitPliThrottle: createLiveKitPliThrottleConfigFromEnv(env),
    rtcPortRangeStart,
    rtcPortRangeEnd,
    turnTlsPort: parsePort(env.OPC_LIVEKIT_EDGE_TURN_TLS_PORT, 'OPC_LIVEKIT_EDGE_TURN_TLS_PORT', 5349),
    turnUdpPort: parsePort(env.OPC_LIVEKIT_EDGE_TURN_UDP_PORT, 'OPC_LIVEKIT_EDGE_TURN_UDP_PORT', 3478),
    egressHealthPort: parsePort(env.OPC_MEDIA_CONFIG_EGRESS_HEALTH_PORT, 'OPC_MEDIA_CONFIG_EGRESS_HEALTH_PORT', 8091),
    objectStorage: requiredMediaObjectStorage(env),
    livekitServerImageTag: requiredExactImageTag(env.LIVEKIT_SERVER_IMAGE_TAG, 'LIVEKIT_SERVER_IMAGE_TAG'),
    livekitEgressImageTag: requiredExactImageTag(env.LIVEKIT_EGRESS_IMAGE_TAG, 'LIVEKIT_EGRESS_IMAGE_TAG'),
    livekitCaddyl4ImageTag: requiredExactImageTag(env.LIVEKIT_CADDYL4_IMAGE_TAG, 'LIVEKIT_CADDYL4_IMAGE_TAG'),
    livekitRedisImageTag: requiredExactImageTag(env.LIVEKIT_REDIS_IMAGE_TAG, 'LIVEKIT_REDIS_IMAGE_TAG')
  };
}

export function renderLiveKitEdgeConfigs(
  input: LiveKitEdgeConfigRenderInput
): LiveKitEdgeConfigRenderResult {
  const outputDir = resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const livekitConfigPath = join(outputDir, 'livekit.yaml');
  const egressConfigPath = join(outputDir, 'egress.yaml');
  const caddyConfigPath = join(outputDir, 'caddy.yaml');
  const firewallChecklistPath = join(outputDir, 'firewall.md');
  const summaryPath = join(outputDir, 'deployment-summary.json');
  const redisTlsDir = prepareRedisTlsDirectory(outputDir, input.livekitRedis.connection);

  writeSecretFile(livekitConfigPath, renderLiveKitEdgeConfig(input));
  writeSecretFile(egressConfigPath, renderEgressConfig(input), 0o640);
  writeFileSync(caddyConfigPath, renderCaddyL4Config(input), { mode: 0o644 });
  writeFileSync(firewallChecklistPath, renderFirewallChecklist(input), { mode: 0o644 });
  writeFileSync(summaryPath, `${JSON.stringify(renderEdgeSummary(input), null, 2)}\n`, { mode: 0o644 });

  return {
    livekitConfigPath,
    egressConfigPath,
    redisTlsDir,
    caddyConfigPath,
    firewallChecklistPath,
    summaryPath
  };
}

function renderLiveKitConfig(input: MediaConfigRenderInput): string {
  return [
    'port: 7880',
    'rtc:',
    `  tcp_port: ${input.livekitRtcTcpPort}`,
    `  udp_port: ${input.livekitRtcUdpPort}`,
    `  use_external_ip: ${input.livekitUseExternalIp}`,
    ...renderLiveKitPliThrottle(input.livekitPliThrottle),
    '',
    'redis:',
    ...renderRedisConfig(input.livekitRedis),
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
  const credentials = input.objectStorage.credentials;
  return [
    'logging:',
    '  level: info',
    `api_key: ${yamlQuote(input.livekitApiKey)}`,
    `api_secret: ${yamlQuote(input.livekitApiSecret)}`,
    `ws_url: ${yamlQuote(input.livekitWsUrl)}`,
    'insecure: true',
    'redis:',
    ...renderRedisConfig(input.livekitRedis),
    `health_port: ${input.egressHealthPort}`,
    'storage:',
    '  s3:',
    `    access_key: ${yamlQuote(credentials?.accessKeyId || '')}`,
    `    secret: ${yamlQuote(credentials?.secretAccessKey || '')}`,
    `    region: ${yamlQuote(input.objectStorage.region)}`,
    `    endpoint: ${yamlQuote(input.objectStorage.endpoint || '')}`,
    `    bucket: ${yamlQuote(input.objectStorage.bucket)}`,
    `    force_path_style: ${input.objectStorage.forcePathStyle}`,
    ''
  ].join('\n');
}

function renderLiveKitEdgeConfig(input: LiveKitEdgeConfigRenderInput): string {
  return [
    'port: 7880',
    'bind_addresses:',
    '  - ""',
    'rtc:',
    `  tcp_port: ${input.livekitRtcTcpPort}`,
    `  port_range_start: ${input.rtcPortRangeStart}`,
    `  port_range_end: ${input.rtcPortRangeEnd}`,
    '  use_external_ip: true',
    ...renderLiveKitPliThrottle(input.livekitPliThrottle),
    'redis:',
    ...renderRedisConfig(input.livekitRedis),
    'turn:',
    '  enabled: true',
    `  domain: ${yamlQuote(input.turnDomain)}`,
    '  external_tls: true',
    `  tls_port: ${input.turnTlsPort}`,
    `  udp_port: ${input.turnUdpPort}`,
    'keys:',
    `  ${yamlQuote(input.livekitApiKey)}: ${yamlQuote(input.livekitApiSecret)}`,
    'webhook:',
    `  api_key: ${yamlQuote(input.livekitApiKey)}`,
    '  urls:',
    `    - ${yamlQuote(input.livekitWebhookUrl)}`,
    'room:',
    '  empty_timeout: 300',
    '  max_participants: 10',
    'logging:',
    '  level: info',
    ''
  ].join('\n');
}

function renderLiveKitPliThrottle(config: LiveKitPliThrottleConfig): string[] {
  return [
    '  pli_throttle:',
    `    low_quality: ${config.lowQualityMs}ms`,
    `    mid_quality: ${config.midQualityMs}ms`,
    `    high_quality: ${config.highQualityMs}ms`
  ];
}

function renderCaddyL4Config(input: LiveKitEdgeConfigRenderInput): string {
  const automatedDomains = [
    input.signalDomain,
    input.turnDomain,
    input.ivekitApiDomain,
    input.tinodePublicDomain
  ].filter((domain): domain is string => Boolean(domain));
  return [
    'logging:',
    '  logs:',
    '    default:',
    '      level: INFO',
    'storage:',
    '  module: file_system',
    '  root: /data',
    'apps:',
    '  tls:',
    '    certificates:',
    '      automate:',
    ...automatedDomains.map((domain) => `        - ${yamlQuote(domain)}`),
    '    automation:',
    '      policies:',
    '        - issuers:',
    '            - module: acme',
    `              email: ${yamlQuote(input.acmeEmail)}`,
    '  layer4:',
    '    servers:',
    '      main:',
    '        listen: [":443"]',
    '        routes:',
    '          - match:',
    '              - tls:',
    '                  sni:',
    `                    - ${yamlQuote(input.turnDomain)}`,
    '            handle:',
    '              - handler: tls',
    '              - handler: proxy',
    '                upstreams:',
    `                  - dial: ["localhost:${input.turnTlsPort}"]`,
    ...(input.ivekitApiDomain
      ? renderCaddyHttpRoute(input.ivekitApiDomain, input.ivekitApiHttpPort)
      : []),
    ...(input.tinodePublicDomain
      ? renderCaddyHttpRoute(input.tinodePublicDomain, input.tinodeHttpPort)
      : []),
    ...renderCaddyHttpRoute(input.signalDomain, 7880),
    ''
  ].join('\n');
}

function renderCaddyHttpRoute(domain: string, port: number): string[] {
  return [
    '          - match:',
    '              - tls:',
    '                  sni:',
    `                    - ${yamlQuote(domain)}`,
    '            handle:',
    '              - handler: tls',
    '                connection_policies:',
    '                  - alpn: ["http/1.1"]',
    '              - handler: proxy',
    '                upstreams:',
    `                  - dial: ["localhost:${port}"]`
  ];
}

function renderFirewallChecklist(input: LiveKitEdgeConfigRenderInput): string {
  return [
    '# LiveKit Standalone VM Firewall Checklist',
    '',
    '| Protocol | Port | Purpose |',
    '| --- | --- | --- |',
    '| TCP | 80/tcp | ACME certificate issuance |',
    '| TCP | 443/tcp | LiveKit WSS and TURN/TLS via Caddy L4 |',
    `| TCP | ${input.livekitRtcTcpPort}/tcp | WebRTC ICE/TCP |`,
    `| UDP | ${input.turnUdpPort}/udp | Embedded TURN/UDP |`,
    `| UDP | ${input.rtcPortRangeStart}-${input.rtcPortRangeEnd}/udp | WebRTC ICE/UDP |`,
    '',
    `Keep private: ${input.turnTlsPort}/tcp (Caddy to TURN/TLS upstream).`,
    'Keep private: 7880/tcp (Caddy to LiveKit API and WebSocket upstream).',
    `Keep private: ${input.egressHealthPort}/tcp (Egress health endpoint).`,
    '',
    `Signal DNS: ${input.signalDomain}`,
    `TURN DNS: ${input.turnDomain}`,
    '',
    'This file is generated offline. It does not prove DNS, TLS, firewall, ICE, or TURN reachability.',
    ''
  ].join('\n');
}

function renderEdgeSummary(input: LiveKitEdgeConfigRenderInput): Record<string, unknown> {
  return {
    mode: 'standalone-vm',
    signal_url: `wss://${input.signalDomain}`,
    turn_domain: input.turnDomain,
    application_routes: {
      ivekit_api: input.ivekitApiDomain ? `https://${input.ivekitApiDomain}` : null,
      tinode: input.tinodePublicDomain ? `https://${input.tinodePublicDomain}` : null
    },
    api_key_configured: Boolean(input.livekitApiKey),
    api_secret_configured: Boolean(input.livekitApiSecret),
    object_storage_configured: Boolean(input.objectStorage.bucket),
    object_storage_auth: input.objectStorage.credentials ? 'static-secret' : 'workload-identity',
    redis_topology: input.livekitRedis.connection.topology,
    redis_address: input.livekitRedis.connection.topology === 'direct'
      ? directRedisAddress(input.livekitRedis.connection.url)
      : null,
    redis_sentinel_count: input.livekitRedis.connection.topology === 'sentinel'
      ? input.livekitRedis.connection.sentinels.length
      : 0,
    redis_tls_enabled: Boolean(input.livekitRedis.connection.tls),
    pli_throttle_ms: {
      low_quality: input.livekitPliThrottle.lowQualityMs,
      mid_quality: input.livekitPliThrottle.midQualityMs,
      high_quality: input.livekitPliThrottle.highQualityMs
    },
    ports: {
      signal_tls_tcp: 443,
      rtc_tcp: input.livekitRtcTcpPort,
      rtc_udp_start: input.rtcPortRangeStart,
      rtc_udp_end: input.rtcPortRangeEnd,
      turn_udp: input.turnUdpPort
    },
    images: {
      server: input.livekitServerImageTag,
      egress: input.livekitEgressImageTag,
      caddyl4: input.livekitCaddyl4ImageTag,
      redis: input.livekitRedisImageTag
    },
    evidence: 'offline_config_only'
  };
}

function createMediaRedisRenderConfigFromEnv(
  env: NodeJS.ProcessEnv,
  fallbackAddress: string
): MediaRedisRenderConfig {
  const topology = String(
    firstDefined(env.OPC_MEDIA_CONFIG_REDIS_TOPOLOGY, env.REDIS_TOPOLOGY) || 'direct'
  ).trim();
  const directAddress = String(env.OPC_MEDIA_CONFIG_REDIS_ADDRESS || '').trim();
  if (topology === 'sentinel' && directAddress) {
    throw new Error('OPC_MEDIA_CONFIG_REDIS_ADDRESS must be empty in sentinel topology');
  }
  const explicitUrl = firstDefined(env.OPC_MEDIA_CONFIG_REDIS_URL, env.REDIS_URL);
  const redisEnv: Record<string, string | undefined> = {
    REDIS_TOPOLOGY: topology,
    REDIS_URL: topology === 'direct'
      ? explicitUrl || toDirectRedisUrl(directAddress || fallbackAddress)
      : explicitUrl,
    REDIS_USERNAME: firstDefined(env.OPC_MEDIA_CONFIG_REDIS_USERNAME, env.REDIS_USERNAME),
    REDIS_PASSWORD: firstDefined(env.OPC_MEDIA_CONFIG_REDIS_PASSWORD, env.REDIS_PASSWORD),
    REDIS_SENTINEL_MASTER_NAME: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_SENTINEL_MASTER_NAME,
      env.REDIS_SENTINEL_MASTER_NAME
    ),
    REDIS_SENTINEL_ADDRESSES: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_SENTINEL_ADDRESSES,
      env.REDIS_SENTINEL_ADDRESSES
    ),
    REDIS_SENTINEL_USERNAME: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_SENTINEL_USERNAME,
      env.REDIS_SENTINEL_USERNAME
    ),
    REDIS_SENTINEL_PASSWORD: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_SENTINEL_PASSWORD,
      env.REDIS_SENTINEL_PASSWORD
    ),
    REDIS_TLS_MODE: firstDefined(env.OPC_MEDIA_CONFIG_REDIS_TLS_MODE, env.REDIS_TLS_MODE),
    REDIS_TLS_SERVER_NAME: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_TLS_SERVER_NAME,
      env.REDIS_TLS_SERVER_NAME
    ),
    REDIS_TLS_CA_FILE: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_TLS_CA_FILE,
      env.REDIS_TLS_CA_FILE
    ),
    REDIS_TLS_CERT_FILE: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_TLS_CERT_FILE,
      env.REDIS_TLS_CERT_FILE
    ),
    REDIS_TLS_KEY_FILE: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_TLS_KEY_FILE,
      env.REDIS_TLS_KEY_FILE
    ),
    REDIS_CONNECT_TIMEOUT_MS: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_CONNECT_TIMEOUT_MS,
      env.REDIS_CONNECT_TIMEOUT_MS
    ),
    REDIS_RECONNECT_WAIT_MS: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_RECONNECT_WAIT_MS,
      env.REDIS_RECONNECT_WAIT_MS
    ),
    REDIS_MAX_RECONNECT_ATTEMPTS: firstDefined(
      env.OPC_MEDIA_CONFIG_REDIS_MAX_RECONNECT_ATTEMPTS,
      env.REDIS_MAX_RECONNECT_ATTEMPTS
    )
  };

  return {
    connection: resolveRedisConnectionOptions(redisEnv),
    readTimeoutMs: parseBoundedInteger(
      env.OPC_MEDIA_CONFIG_REDIS_READ_TIMEOUT_MS,
      'OPC_MEDIA_CONFIG_REDIS_READ_TIMEOUT_MS',
      200,
      1,
      60_000
    ),
    writeTimeoutMs: parseBoundedInteger(
      env.OPC_MEDIA_CONFIG_REDIS_WRITE_TIMEOUT_MS,
      'OPC_MEDIA_CONFIG_REDIS_WRITE_TIMEOUT_MS',
      200,
      1,
      60_000
    ),
    poolSize: parseBoundedInteger(
      env.OPC_MEDIA_CONFIG_REDIS_POOL_SIZE,
      'OPC_MEDIA_CONFIG_REDIS_POOL_SIZE',
      0,
      0,
      1_000_000
    )
  };
}

function renderRedisConfig(config: MediaRedisRenderConfig): string[] {
  const connection = config.connection;
  const lines: string[] = [];
  if (connection.topology === 'direct') {
    lines.push(`  address: ${yamlQuote(directRedisAddress(connection.url))}`);
  } else {
    lines.push(`  sentinel_master_name: ${yamlQuote(connection.masterName)}`);
    lines.push('  sentinel_addresses:');
    for (const sentinel of connection.sentinels) {
      lines.push(`    - ${yamlQuote(formatHostPort(sentinel.host, sentinel.port))}`);
    }
    lines.push(`  sentinel_username: ${yamlQuote(connection.sentinelUsername || '')}`);
    lines.push(`  sentinel_password: ${yamlQuote(connection.sentinelPassword || '')}`);
  }
  lines.push(`  username: ${yamlQuote(connection.username || '')}`);
  lines.push(`  password: ${yamlQuote(connection.password || '')}`);
  lines.push('  db: 0');
  lines.push(`  dial_timeout: ${connection.connectTimeoutMs}`);
  lines.push(`  read_timeout: ${config.readTimeoutMs}`);
  lines.push(`  write_timeout: ${config.writeTimeoutMs}`);
  lines.push(`  pool_size: ${config.poolSize}`);
  if (connection.tls) {
    lines.push('  tls:');
    lines.push('    enabled: true');
    lines.push('    insecure: false');
    if (connection.tls.serverName) {
      lines.push(`    server_name: ${yamlQuote(connection.tls.serverName)}`);
    }
    if (connection.tls.caFile) {
      lines.push('    ca_cert_file: /etc/livekit-redis-tls/ca.crt');
    }
    if (connection.tls.certFile && connection.tls.keyFile) {
      lines.push('    client_cert_file: /etc/livekit-redis-tls/client.crt');
      lines.push('    client_key_file: /etc/livekit-redis-tls/client.key');
    }
  }
  return lines;
}

function prepareRedisTlsDirectory(
  outputDir: string,
  connection: ResolvedRedisConnectionOptions
): string {
  const tlsDir = join(outputDir, 'redis-tls');
  const ca = connection.tls?.caFile ? readFileSync(connection.tls.caFile) : undefined;
  const cert = connection.tls?.certFile ? readFileSync(connection.tls.certFile) : undefined;
  const key = connection.tls?.keyFile ? readFileSync(connection.tls.keyFile) : undefined;
  rmSync(tlsDir, { recursive: true, force: true });
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  chmodSync(tlsDir, 0o700);
  if (!connection.tls) return tlsDir;
  if (ca) writeTlsFile(join(tlsDir, 'ca.crt'), ca);
  if (cert && key) {
    writeTlsFile(join(tlsDir, 'client.crt'), cert);
    writeTlsFile(join(tlsDir, 'client.key'), key);
  }
  return tlsDir;
}

function writeTlsFile(destination: string, content: Buffer): void {
  writeFileSync(destination, content, { mode: 0o600 });
  chmodSync(destination, 0o600);
}

function directRedisAddress(url: string): string {
  const endpoint = new URL(url);
  return formatHostPort(endpoint.hostname, Number(endpoint.port || 6379));
}

function formatHostPort(host: string, port: number): string {
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${normalizedHost}:${port}`;
}

function toDirectRedisUrl(address: string): string {
  return /^rediss?:\/\//.test(address) ? address : `redis://${address}`;
}

function firstDefined(
  preferred: string | undefined,
  fallback: string | undefined
): string | undefined {
  return preferred === undefined ? fallback : preferred;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requiredMediaObjectStorage(env: NodeJS.ProcessEnv): S3ConnectionConfig {
  const normalizedEnv = { ...env };
  const hasBucket = Boolean(env.S3_BUCKET || env.OPC_S3_BUCKET || env.MINIO_BUCKET);
  const hasLegacyInput = Boolean(
    env.MINIO_ENDPOINT || env.MINIO_ACCESS_KEY || env.MINIO_SECRET_KEY
  );
  if (!hasBucket && hasLegacyInput) normalizedEnv.MINIO_BUCKET = 'recordings';
  if (!env.S3_ENDPOINT && !env.MINIO_ENDPOINT && hasLegacyInput) {
    normalizedEnv.MINIO_ENDPOINT = 'http://minio:9000';
  }
  const config = resolveS3ConnectionConfig(normalizedEnv);
  if (!config) throw new Error('S3_BUCKET or MINIO_BUCKET is required');
  if (config.credentials) {
    const names = config.source === 'aws'
      ? ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
      : config.source === 's3'
        ? ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']
        : ['MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY'];
    assertRuntimeSecret(config.credentials.accessKeyId, names[0]);
    assertRuntimeSecret(config.credentials.secretAccessKey, names[1]);
  }
  return config;
}

function requiredDomain(env: NodeJS.ProcessEnv, key: string): string {
  const domain = requiredEnv(env, key).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(domain)) {
    throw new Error(`${key} must be a valid DNS domain`);
  }
  return domain;
}

function optionalDomain(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (!String(env[key] || '').trim()) return undefined;
  return requiredDomain(env, key);
}

function requiredRuntimeSecret(env: NodeJS.ProcessEnv, key: string): string {
  return assertRuntimeSecret(requiredEnv(env, key).trim(), key);
}

function assertRuntimeSecret(secret: string, key: string): string {
  const weakValues = new Set(['admin', 'devkey', 'minioadmin', 'password', 'secret']);
  if (/^(?:replace_with|change_me|your_)/i.test(secret) || weakValues.has(secret.toLowerCase())) {
    throw new Error(`${key} must replace the example placeholder`);
  }
  return secret;
}

function requiredEmail(env: NodeJS.ProcessEnv, key: string): string {
  const email = requiredEnv(env, key);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${key} must be a valid email address`);
  return email;
}

function requiredExactImageTag(value: string | undefined, key: string): string {
  const tag = String(value || '').trim();
  if (!/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) {
    throw new Error(`${key} must be an exact semantic version tag and cannot use latest`);
  }
  return tag;
}

function parsePort(value: string | undefined, key: string, fallback: number): number {
  const parsed = value == null || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${key} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function parseBoundedInteger(
  value: string | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const normalized = String(value ?? '').trim();
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function createLiveKitPliThrottleConfigFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitPliThrottleConfig {
  return {
    lowQualityMs: parseBoundedInteger(
      env.OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_LOW_MS,
      'OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_LOW_MS',
      100,
      50,
      5_000
    ),
    midQualityMs: parseBoundedInteger(
      env.OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_MID_MS,
      'OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_MID_MS',
      100,
      50,
      5_000
    ),
    highQualityMs: parseBoundedInteger(
      env.OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_HIGH_MS,
      'OPC_MEDIA_CONFIG_RTC_PLI_THROTTLE_HIGH_MS',
      100,
      50,
      5_000
    )
  };
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

function normalizeEdgeOutputDir(outputDir: string): string {
  return outputDir.startsWith('../')
    ? resolve('infra/livekit', outputDir)
    : outputDir;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function writeSecretFile(path: string, content: string, mode = 0o600): void {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

async function main(): Promise<void> {
  const result = process.argv.includes('--edge')
    ? renderLiveKitEdgeConfigs(createLiveKitEdgeConfigRenderInputFromEnv(process.env))
    : renderMediaConfigs(createMediaConfigRenderInputFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
