import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createIveKitRustDeskHttpClient,
  type IveKitRustDeskHttpClient
} from '../src/agent-runtime/converact/index.js';

export interface RustDeskClientConfigPackConfig {
  outputFile?: string;
  title: string;
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  userId?: string;
  externalId?: string;
  targetRustDeskId?: string;
}

export interface RustDeskClientConfigPackClient {
  getClientConfig: IveKitRustDeskHttpClient['getClientConfig'];
  getGatewayLaunchPlan: IveKitRustDeskHttpClient['getGatewayLaunchPlan'];
}

export interface RustDeskClientConfigPack {
  title: string;
  ready: boolean;
  generated_at: string;
  source: {
    base_url: string;
    tenant_id: string;
    external_id?: string;
    target_rustdesk_id?: string;
  };
  manual_fields: {
    id_server: string;
    relay_server: string;
    api_server: string;
    key: string;
  };
  client_config: {
    public_key_configured: boolean;
    public_key_source: string;
    public_key_file: string;
    server_key_fingerprint: string;
  };
  launch?: {
    external_id: string;
    status: string;
    target_rustdesk_id: string;
    launch_url: string;
    protocol_url: string;
    launch_available?: boolean;
    protocol_available?: boolean;
    permissions: string[];
  };
}

export interface RustDeskClientConfigPackWriteResult {
  outputFile: string;
  ready: boolean;
  manualFields: number;
}

export function createRustDeskClientConfigPackConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskClientConfigPackConfig {
  const outputFile = optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE);
  const baseUrl = normalizeBaseUrl(
    env.OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL ||
    env.OPC_RUSTDESK_IVEKIT_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_REMOTE_GATEWAY_BASE_URL ||
    ''
  );
  const apiKey = requiredString(
    env.OPC_RUSTDESK_CLIENT_CONFIG_API_KEY ||
    env.OPC_RUSTDESK_IVEKIT_API_KEY ||
    env.OPC_COLLABORATION_API_KEY ||
    env.OPC_API_KEY,
    'OPC_RUSTDESK_CLIENT_CONFIG_API_KEY or OPC_RUSTDESK_IVEKIT_API_KEY or OPC_API_KEY is required'
  );
  const tenantId = requiredString(
    env.OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID ||
    env.OPC_RUSTDESK_IVEKIT_TENANT_ID ||
    env.OPC_REMOTE_GATEWAY_TENANT_ID ||
    env.OPC_RUSTDESK_EDGE_TENANT_ID ||
    env.OPC_TENANT_ID,
    'OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID or OPC_RUSTDESK_IVEKIT_TENANT_ID or OPC_REMOTE_GATEWAY_TENANT_ID is required'
  );

  return {
    ...(outputFile ? { outputFile } : {}),
    title: optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_PACK_TITLE) || 'RustDesk Client Config Pack',
    baseUrl,
    apiKey,
    tenantId,
    ...(optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_USER_ID || env.OPC_RUSTDESK_IVEKIT_USER_ID) ? {
      userId: optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_USER_ID || env.OPC_RUSTDESK_IVEKIT_USER_ID)
    } : {}),
    ...(optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID || env.OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID) ? {
      externalId: optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID || env.OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID)
    } : {}),
    ...(optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID || env.OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID) ? {
      targetRustDeskId: optionalString(env.OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID || env.OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID)
    } : {})
  };
}

export async function buildRustDeskClientConfigPack(
  config: RustDeskClientConfigPackConfig,
  client: RustDeskClientConfigPackClient = createIveKitRustDeskHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    userId: config.userId
  })
): Promise<RustDeskClientConfigPack> {
  const clientConfig = await client.getClientConfig();
  const manualFields = {
    id_server: requiredString(
      clientConfig.manual_fields?.id_server || clientConfig.id_server,
      'RustDesk client config id_server is required'
    ),
    relay_server: String(clientConfig.manual_fields?.relay_server || clientConfig.relay_server || '').trim(),
    api_server: String(clientConfig.manual_fields?.api_server || clientConfig.api_server || '').trim(),
    key: requiredString(
      clientConfig.manual_fields?.key || clientConfig.public_key,
      'RustDesk client config manual key is required'
    )
  };

  if (!clientConfig.public_key_configured) {
    throw new Error('RustDesk client config public key is not configured');
  }

  const launch = config.externalId
    ? summarizeLaunchPlan(await client.getGatewayLaunchPlan(config.externalId), config.targetRustDeskId)
    : undefined;

  return {
    title: config.title,
    ready: true,
    generated_at: new Date().toISOString(),
    source: {
      base_url: config.baseUrl,
      tenant_id: config.tenantId,
      ...(config.externalId ? { external_id: config.externalId } : {}),
      ...(config.targetRustDeskId ? { target_rustdesk_id: config.targetRustDeskId } : {})
    },
    manual_fields: manualFields,
    client_config: {
      public_key_configured: true,
      public_key_source: String(clientConfig.public_key_source || ''),
      public_key_file: String(clientConfig.public_key_file || ''),
      server_key_fingerprint: String(clientConfig.server_key_fingerprint || '')
    },
    ...(launch ? { launch } : {})
  };
}

export function renderRustDeskClientConfigPack(pack: RustDeskClientConfigPack): string {
  const lines = [
    `# ${pack.title}`,
    '',
    `Generated at: \`${pack.generated_at}\``,
    `Tenant: \`${pack.source.tenant_id}\``,
    `OPC base URL: \`${pack.source.base_url}\``,
    '',
    'This pack is for installing and configuring real RustDesk clients. It does not prove real screen view, keyboard/mouse control, file transfer, clipboard sync, recording, revoke disconnect, or customer-grade audit coverage.',
    '',
    '## Manual Fields',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| ID server | \`${escapeTable(pack.manual_fields.id_server)}\` |`,
    `| Relay server | \`${escapeTable(pack.manual_fields.relay_server || '-')}\` |`,
    `| API server | \`${escapeTable(pack.manual_fields.api_server || '-')}\` |`,
    `| Key | \`${escapeTable(pack.manual_fields.key)}\` |`,
    `| Server key fingerprint | \`${escapeTable(pack.client_config.server_key_fingerprint || '-')}\` |`,
    `| Public key source | \`${escapeTable(pack.client_config.public_key_source || '-')}\` |`,
    `| Public key file | \`${escapeTable(pack.client_config.public_key_file || '-')}\` |`,
    ''
  ];

  if (pack.launch) {
    lines.push(
      '## Launch Session',
      '',
      `- external_id: \`${pack.launch.external_id}\``,
      `- status: \`${pack.launch.status}\``,
      `- target RustDesk ID: \`${pack.launch.target_rustdesk_id}\``,
      `- launch available at generation: \`${pack.launch.launch_available ? 'yes' : 'no'}\``,
      `- protocol launch available at generation: \`${pack.launch.protocol_available ? 'yes' : 'no'}\``,
      `- permissions: \`${pack.launch.permissions.join(', ') || 'none'}\``,
      '- signed and protocol launch URLs are intentionally not persisted; request a fresh launch plan at runtime.',
      ''
    );
  }

  lines.push(
    '## Client Setup Checklist',
    '',
    '1. Install RustDesk on the agent machine and target machine.',
    '2. Copy ID server, relay server, optional API server, and key exactly from this pack into both RustDesk clients.',
    '3. Confirm the target machine shows the expected RustDesk ID before starting a gateway session.',
    '4. Request a fresh launch plan at runtime immediately before opening RustDesk; static config packs never contain signed or protocol launch URLs.',
    '5. Record evidence in `client-acceptance-template.json` only after real screen view, keyboard/mouse, file transfer, clipboard, recording, revoke disconnect, old-link rejection, and audit checks pass.',
    '',
    '## Boundary',
    '',
    'This pack is a configuration handoff. Customer handoff still requires `rustdesk:server-evidence`, `rustdesk:readiness`, real client acceptance, `rustdesk:audit-export`, `rustdesk:audit-coverage`, and final `rustdesk:evidence-pack` to pass from the real environment.',
    ''
  );

  return lines.join('\n');
}

export async function writeRustDeskClientConfigPack(
  config: RustDeskClientConfigPackConfig,
  client?: RustDeskClientConfigPackClient
): Promise<RustDeskClientConfigPackWriteResult> {
  if (!config.outputFile) throw new Error('OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE is required when writing client config pack');
  const pack = await buildRustDeskClientConfigPack(config, client);
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, renderRustDeskClientConfigPack(pack), 'utf8');
  return {
    outputFile: config.outputFile,
    ready: pack.ready,
    manualFields: Object.values(pack.manual_fields).filter((value) => String(value || '').trim()).length
  };
}

function summarizeLaunchPlan(value: unknown, targetRustDeskId: string | undefined): RustDeskClientConfigPack['launch'] {
  const plan = objectValue(value);
  const runtime = objectValue(plan.runtime);
  const actions = objectValue(plan.actions);
  const target = objectValue(plan.target);
  const externalId = requiredString(plan.external_id, 'RustDesk launch plan external_id is required');
  const canLaunch = actions.can_launch === true;
  const launchAvailable = canLaunch && Boolean(String(actions.open_url || plan.launch_url || '').trim());
  const protocolAvailable = canLaunch && Boolean(String(actions.protocol_url || '').trim());
  const runtimeTarget = String(runtime.rustdesk_id || '').trim();
  const declaredTarget = String(target.id || '').trim();
  if (runtimeTarget && declaredTarget && runtimeTarget !== declaredTarget) {
    throw new Error('RustDesk launch plan runtime RustDesk ID does not match target');
  }
  const planTargets = [runtimeTarget, declaredTarget].filter(Boolean);
  if (targetRustDeskId && planTargets.some((planTarget) => planTarget !== targetRustDeskId)) {
    throw new Error('configured target RustDesk ID does not match launch plan target');
  }
  const launchPlanTarget = runtimeTarget || declaredTarget;
  const resolvedTarget = String(targetRustDeskId || launchPlanTarget).trim();
  return {
    external_id: externalId,
    status: String(plan.status || ''),
    target_rustdesk_id: resolvedTarget,
    launch_url: '',
    protocol_url: '',
    launch_available: launchAvailable,
    protocol_available: protocolAvailable,
    permissions: Array.isArray(plan.permissions) ? plan.permissions.map(String) : []
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  const value = requiredString(rawBaseUrl, 'OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL or OPC_BASE_URL is required');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('RustDesk client config pack base URL must use http(s)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('RustDesk client config pack base URL must not include credentials, query, or fragment');
  }
  if (parsed.pathname !== '/') {
    throw new Error('RustDesk client config pack base URL must not include a path');
  }
  return parsed.origin;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function escapeTable(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|');
}

async function main(): Promise<void> {
  const config = createRustDeskClientConfigPackConfigFromEnv(process.env);
  if (config.outputFile) {
    console.log(JSON.stringify(await writeRustDeskClientConfigPack(config), null, 2));
    return;
  }
  const pack = await buildRustDeskClientConfigPack(config);
  console.log(renderRustDeskClientConfigPack(pack));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
