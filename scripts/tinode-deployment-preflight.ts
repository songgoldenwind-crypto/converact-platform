import { resolveBrandEnv } from '../src/config/converact-env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tinodeApiKeysDistinct } from '../src/agent-runtime/collaboration/tinode-env.js';
import { tinodeSyncWorkerConfig, type TinodeSyncWorkerConfig } from '../src/agent-runtime/collaboration/tinode-sync-worker.js';

export type TinodeDeploymentPreflightStatus = 'pass' | 'warn' | 'fail';

export interface TinodeDeploymentPreflightCheck {
  id: string;
  status: TinodeDeploymentPreflightStatus;
  message: string;
}

export interface TinodeDeploymentPreflightReport {
  ok: boolean;
  summary: {
    deploymentMode: 'external' | 'self_hosted' | 'invalid';
    serverRuntimeConfigured: boolean;
    browserClientConfigured: boolean;
    providerConfigured: boolean;
    rootApiKeyConfigured: boolean;
    apiKeysDistinct: boolean;
    rootAuthConfigured: boolean;
    userProvisioningConfigured: boolean;
    baseUrl: string;
    wsUrl: string;
    clientWsUrl: string;
    smokeTenantConfigured: boolean;
    deliveryWorkerEnabled: boolean;
    deliveryClaimLeaseMs: number | null;
  };
  checks: TinodeDeploymentPreflightCheck[];
}

interface TinodeDeploymentEnvChecklistItem {
  section: string;
  name: string;
  required: boolean;
  secret: boolean;
  value: string;
  description: string;
}

export interface TinodeDeploymentEnvChecklistWriteResult {
  outputFile: string;
  variables: number;
  missing: string[];
}

export interface TinodeDeploymentPreflightReportWriteResult {
  outputFile: string;
  ok: boolean;
  checks: number;
}

export function createTinodeDeploymentPreflightReport(
  env: NodeJS.ProcessEnv
): TinodeDeploymentPreflightReport {
  const checks: TinodeDeploymentPreflightCheck[] = [];
  const deploymentModeValue = String(env.TINODE_DEPLOYMENT_MODE || 'external').trim();
  const deploymentModeValid = deploymentModeValue === 'external' || deploymentModeValue === 'self_hosted';
  const deploymentMode = deploymentModeValid ? deploymentModeValue as 'external' | 'self_hosted' : 'invalid';
  const selfHosted = deploymentMode === 'self_hosted';
  const productionDeployment = env.NODE_ENV === 'production';
  const postgresDsnConfigured = isPostgresDsn(env.TINODE_POSTGRES_DSN);
  const authTokenKeyConfigured = isBase64Key(env.TINODE_AUTH_TOKEN_KEY, 32);
  const uidEncryptionKeyConfigured = isBase64Key(env.TINODE_UID_ENCRYPTION_KEY, 16);
  const serverRuntimeConfigured = deploymentModeValid && (!selfHosted || (
    postgresDsnConfigured && authTokenKeyConfigured && uidEncryptionKeyConfigured
  ));
  const publicClientWsUrl = resolvePublicClientWsUrl(env);
  const browserClientConfigured = !productionDeployment || isSecureWebSocketUrl(publicClientWsUrl);
  const rawBaseUrl = normalizeUrl(env.TINODE_BASE_URL);
  const rawWsUrl = normalizeUrl(env.TINODE_WS_URL);
  const baseUrl = safeReportUrl(rawBaseUrl);
  const wsUrl = safeReportUrl(rawWsUrl);
  const apiKeyConfigured = hasValue(env.TINODE_API_KEY);
  const rootApiKeyConfigured = hasValue(env.TINODE_ROOT_API_KEY);
  const apiKeysDistinct = tinodeApiKeysDistinct(env);
  const rootTokenConfigured = hasValue(env.TINODE_AUTH_TOKEN);
  const basicRootAuthConfigured = hasValue(env.TINODE_BASIC_USER) && hasValue(env.TINODE_BASIC_PASSWORD);
  const rootAuthConfigured = rootTokenConfigured || basicRootAuthConfigured;
  const userProvisioningConfigured = hasValue(env.TINODE_USER_PASSWORD_SECRET);
  const smokeTenantConfigured = hasValue(env.TINODE_CHAT_SMOKE_TENANT_ID);
  const providerUrlConfigured = isHttpUrl(rawBaseUrl) || isWebSocketUrl(rawWsUrl);
  const clientWsUrl = safeReportUrl(resolveClientWsUrl(env));
  let deliveryWorker: TinodeSyncWorkerConfig | null = null;
  let deliveryWorkerError = '';
  try {
    deliveryWorker = tinodeSyncWorkerConfig(env);
  } catch (error) {
    deliveryWorkerError = error instanceof Error ? error.message : String(error);
  }

  addCheck(
    checks,
    'tinode_deployment_mode',
    deploymentModeValid ? 'pass' : 'fail',
    deploymentModeValid
      ? `Tinode deployment mode is ${deploymentMode}`
      : 'TINODE_DEPLOYMENT_MODE must be external or self_hosted'
  );
  if (selfHosted) {
    addCheck(
      checks,
      'tinode_postgres_dsn',
      postgresDsnConfigured ? 'pass' : 'fail',
      postgresDsnConfigured
        ? 'Tinode PostgreSQL DSN is configured'
        : 'TINODE_POSTGRES_DSN is required in self_hosted mode and must target a PostgreSQL database'
    );
    addCheck(
      checks,
      'tinode_auth_token_key',
      authTokenKeyConfigured ? 'pass' : 'fail',
      authTokenKeyConfigured
        ? 'Tinode authentication token key has the required length'
        : 'TINODE_AUTH_TOKEN_KEY must be base64 for exactly 32 bytes in self_hosted mode'
    );
    addCheck(
      checks,
      'tinode_uid_encryption_key',
      uidEncryptionKeyConfigured ? 'pass' : 'fail',
      uidEncryptionKeyConfigured
        ? 'Tinode UID encryption key has the required length'
        : 'TINODE_UID_ENCRYPTION_KEY must be base64 for exactly 16 bytes in self_hosted mode'
    );
  }
  if (productionDeployment) {
    addCheck(
      checks,
      'tinode_public_ws_url',
      browserClientConfigured ? 'pass' : 'fail',
      browserClientConfigured
        ? 'Tinode public browser WebSocket URL uses wss'
        : 'TINODE_PUBLIC_WS_URL must use wss, or TINODE_PUBLIC_BASE_URL must use https, in production'
    );
  }
  addCheck(
    checks,
    'tinode_base_url',
    providerUrlConfigured ? 'pass' : 'fail',
    providerUrlConfigured
      ? 'Tinode HTTP or WebSocket server URL is configured'
      : 'TINODE_BASE_URL or TINODE_WS_URL is required and must use http(s) or ws(s)'
  );
  addCheck(
    checks,
    'tinode_delivery_worker',
    deliveryWorkerError ? 'fail' : deliveryWorker?.enabled ? 'pass' : 'warn',
    deliveryWorkerError || (deliveryWorker?.enabled
      ? `Tinode durable delivery worker is enabled with a ${deliveryWorker.claimLeaseMs}ms claim lease`
      : 'Tinode durable delivery worker is disabled because the provider or worker switch is not enabled')
  );
  addCheck(
    checks,
    'tinode_api_key',
    apiKeyConfigured ? 'pass' : 'fail',
    apiKeyConfigured ? 'TINODE_API_KEY is configured' : 'TINODE_API_KEY is required'
  );
  addCheck(
    checks,
    'tinode_root_api_key',
    rootApiKeyConfigured ? 'pass' : 'fail',
    rootApiKeyConfigured
      ? 'TINODE_ROOT_API_KEY is configured for server-side protocol connections'
      : 'TINODE_ROOT_API_KEY is required for server-side trusted metadata operations'
  );
  if (apiKeyConfigured && rootApiKeyConfigured) {
    addCheck(
      checks,
      'tinode_api_key_separation',
      apiKeysDistinct ? 'pass' : 'fail',
      apiKeysDistinct
        ? 'Browser and server root API keys are distinct'
        : 'TINODE_API_KEY and TINODE_ROOT_API_KEY must be different'
    );
  }
  addCheck(
    checks,
    'tinode_root_auth',
    rootAuthConfigured ? 'pass' : 'fail',
    rootAuthConfigured
      ? 'Tinode root authentication is configured'
      : 'TINODE_AUTH_TOKEN or TINODE_BASIC_USER with TINODE_BASIC_PASSWORD is required'
  );
  addCheck(
    checks,
    'tinode_user_password_secret',
    userProvisioningConfigured ? 'pass' : 'fail',
    userProvisioningConfigured
      ? 'TINODE_USER_PASSWORD_SECRET is configured'
      : 'TINODE_USER_PASSWORD_SECRET is required'
  );
  addCheck(
    checks,
    'tinode_smoke_tenant',
    smokeTenantConfigured ? 'pass' : 'fail',
    smokeTenantConfigured
      ? 'TINODE_CHAT_SMOKE_TENANT_ID is configured'
      : 'TINODE_CHAT_SMOKE_TENANT_ID is required'
  );
  addCheck(
    checks,
    'tinode_client_ws_url',
    clientWsUrl ? 'pass' : 'warn',
    clientWsUrl
      ? 'Tinode client WebSocket URL is configured'
      : 'Tinode client WebSocket URL cannot be derived'
  );

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    summary: {
      deploymentMode,
      serverRuntimeConfigured,
      browserClientConfigured,
      providerConfigured: providerUrlConfigured && apiKeyConfigured &&
        rootApiKeyConfigured && apiKeysDistinct,
      rootApiKeyConfigured,
      apiKeysDistinct,
      rootAuthConfigured,
      userProvisioningConfigured,
      baseUrl,
      wsUrl,
      clientWsUrl,
      smokeTenantConfigured,
      deliveryWorkerEnabled: Boolean(deliveryWorker?.enabled),
      deliveryClaimLeaseMs: deliveryWorker?.claimLeaseMs ?? null
    },
    checks
  };
}

export function renderTinodeDeploymentEnvChecklist(env: NodeJS.ProcessEnv): string {
  const items = tinodeDeploymentEnvChecklistItems(env);
  const sections = Array.from(new Set(items.map((item) => item.section)));
  const lines = [
    '# Tinode Deployment Env Checklist',
    '',
    'This checklist is generated locally from environment variables. Secret values are never printed.',
    ''
  ];

  for (const section of sections) {
    lines.push(`## ${section}`, '');
    lines.push('| Variable | Required | Current | Notes |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of items.filter((candidate) => candidate.section === section)) {
      lines.push(`| ${item.name} | ${item.required ? 'required' : 'optional'} | \`${displayEnvValue(item)}\` | ${item.description} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeTinodeDeploymentEnvChecklist(
  outputFile: string,
  env: NodeJS.ProcessEnv
): TinodeDeploymentEnvChecklistWriteResult {
  const items = tinodeDeploymentEnvChecklistItems(env);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, renderTinodeDeploymentEnvChecklist(env), 'utf8');
  return {
    outputFile,
    variables: items.length,
    missing: items
      .filter((item) => item.required && !item.value)
      .map((item) => item.name)
  };
}

export function writeTinodeDeploymentPreflightReport(
  outputFile: string,
  env: NodeJS.ProcessEnv,
  report: TinodeDeploymentPreflightReport = createTinodeDeploymentPreflightReport(env)
): TinodeDeploymentPreflightReportWriteResult {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return {
    outputFile,
    ok: report.ok,
    checks: report.checks.length
  };
}

function tinodeDeploymentEnvChecklistItems(
  env: NodeJS.ProcessEnv
): TinodeDeploymentEnvChecklistItem[] {
  const selfHosted = String(env.TINODE_DEPLOYMENT_MODE || 'external').trim() === 'self_hosted';
  const productionDeployment = env.NODE_ENV === 'production';
  const baseUrlConfigured = hasValue(env.TINODE_BASE_URL);
  const wsUrlConfigured = hasValue(env.TINODE_WS_URL);
  const publicBaseConfigured = isHttpsUrl(normalizeUrl(env.TINODE_PUBLIC_BASE_URL));
  const publicWsConfigured = isSecureWebSocketUrl(normalizeUrl(env.TINODE_PUBLIC_WS_URL));
  const rootTokenConfigured = hasValue(env.TINODE_AUTH_TOKEN);
  const basicRootAuthConfigured = hasValue(env.TINODE_BASIC_USER) && hasValue(env.TINODE_BASIC_PASSWORD);
  const deliveryWorkerRequired = (baseUrlConfigured || wsUrlConfigured) && String(resolveBrandEnv(env, 'TINODE_DELIVERY_WORKER_ENABLED') || '1').trim() !== '0';

  return [
    item('Tinode Server', 'TINODE_BASE_URL', !wsUrlConfigured, false, env.TINODE_BASE_URL, 'Tinode HTTP(S) server URL used by OPC services. Optional when TINODE_WS_URL is configured.'),
    item('Tinode Server', 'TINODE_WS_URL', !baseUrlConfigured, false, env.TINODE_WS_URL, 'Tinode WebSocket URL. Optional when TINODE_BASE_URL is configured.'),
    item('Tinode Runtime', 'TINODE_DEPLOYMENT_MODE', false, false, env.TINODE_DEPLOYMENT_MODE, 'Use external for a managed server or self_hosted for the bundled PostgreSQL-backed Tinode service.'),
    item('Tinode Runtime', 'TINODE_IMAGE_TAG', false, false, env.TINODE_IMAGE_TAG, 'Tinode container image tag used in self_hosted mode.'),
    item('Tinode Runtime', 'TINODE_POSTGRES_DSN', selfHosted, true, env.TINODE_POSTGRES_DSN, 'Dedicated PostgreSQL DSN required by the self-hosted Tinode server.'),
    item('Tinode Runtime', 'TINODE_AUTH_TOKEN_KEY', selfHosted, true, env.TINODE_AUTH_TOKEN_KEY, 'Base64-encoded 32-byte Tinode authentication token key.'),
    item('Tinode Runtime', 'TINODE_UID_ENCRYPTION_KEY', selfHosted, true, env.TINODE_UID_ENCRYPTION_KEY, 'Base64-encoded 16-byte Tinode UID encryption key.'),
    item('Tinode Runtime', 'TINODE_SAMPLE_DATA', false, false, env.TINODE_SAMPLE_DATA, 'Optional path to Tinode sample data; leave blank in production.'),
    item('Tinode Runtime', 'TINODE_UPGRADE_DB', false, false, env.TINODE_UPGRADE_DB, 'Set true only for an intentional Tinode schema upgrade.'),
    item('Tinode Auth', 'TINODE_API_KEY', true, true, env.TINODE_API_KEY, 'Non-root Tinode API key exposed only in browser client plans.'),
    item('Tinode Auth', 'TINODE_ROOT_API_KEY', true, true, env.TINODE_ROOT_API_KEY, 'Root Tinode API key used only by OPC server-side protocol connections.'),
    item('Tinode Auth', 'TINODE_AUTH_TOKEN', !basicRootAuthConfigured, true, env.TINODE_AUTH_TOKEN, 'Tinode root auth token. Optional when complete basic root credentials are configured.'),
    item('Tinode Auth', 'TINODE_BASIC_USER', !rootTokenConfigured, false, env.TINODE_BASIC_USER, 'Tinode root basic-auth user. Optional when TINODE_AUTH_TOKEN is configured.'),
    item('Tinode Auth', 'TINODE_BASIC_PASSWORD', !rootTokenConfigured, true, env.TINODE_BASIC_PASSWORD, 'Tinode root basic-auth password. Optional when TINODE_AUTH_TOKEN is configured.'),
    item('Tinode Auth', 'TINODE_USER_PASSWORD_SECRET', true, true, env.TINODE_USER_PASSWORD_SECRET, 'Secret used to derive managed Tinode user passwords.'),
    item('Client Plan', 'TINODE_PUBLIC_BASE_URL', productionDeployment && !publicWsConfigured, false, env.TINODE_PUBLIC_BASE_URL, 'Public Tinode HTTPS base URL exposed to browser clients; may derive the WSS endpoint.'),
    item('Client Plan', 'TINODE_PUBLIC_WS_URL', productionDeployment && !publicBaseConfigured, false, env.TINODE_PUBLIC_WS_URL, 'Public Tinode WSS URL exposed to browser clients.'),
    item('Delivery Worker', 'TINODE_REQUEST_TIMEOUT_MS', deliveryWorkerRequired, false, env.TINODE_REQUEST_TIMEOUT_MS, 'Per-stage Tinode WebSocket timeout. The claim lease must cover five stages plus margin.'),
    item('Delivery Worker', 'CONVERACT_TINODE_DELIVERY_WORKER_ENABLED', false, false, resolveBrandEnv(env, 'TINODE_DELIVERY_WORKER_ENABLED'), 'Set to 0 to disable automatic durable provider delivery retries.'),
    item('Delivery Worker', 'CONVERACT_TINODE_DELIVERY_INTERVAL_MS', deliveryWorkerRequired, false, resolveBrandEnv(env, 'TINODE_DELIVERY_INTERVAL_MS'), 'Polling interval for due provider deliveries.'),
    item('Delivery Worker', 'CONVERACT_TINODE_DELIVERY_BATCH_SIZE', deliveryWorkerRequired, false, resolveBrandEnv(env, 'TINODE_DELIVERY_BATCH_SIZE'), 'Maximum due messages examined per worker run.'),
    item('Delivery Worker', 'CONVERACT_TINODE_DELIVERY_MAX_ATTEMPTS', deliveryWorkerRequired, false, resolveBrandEnv(env, 'TINODE_DELIVERY_MAX_ATTEMPTS'), 'Maximum provider publish attempts before terminal failure.'),
    item('Delivery Worker', 'CONVERACT_TINODE_DELIVERY_CLAIM_LEASE_MS', deliveryWorkerRequired, false, resolveBrandEnv(env, 'TINODE_DELIVERY_CLAIM_LEASE_MS'), 'Claim lease; must be at least five provider timeouts plus 1000ms.'),
    item('Delivery Worker', 'CONVERACT_TINODE_DELIVERY_RETRY_DELAYS_MS', deliveryWorkerRequired, false, resolveBrandEnv(env, 'TINODE_DELIVERY_RETRY_DELAYS_MS'), 'Comma-separated retry delays in milliseconds.'),
    item('Smoke', 'TINODE_CHAT_SMOKE_TENANT_ID', true, false, env.TINODE_CHAT_SMOKE_TENANT_ID, 'Tenant used by smoke:chat:tinode.'),
    item('Smoke', 'TINODE_CHAT_SMOKE_PARTICIPANT_IDENTITY', false, false, env.TINODE_CHAT_SMOKE_PARTICIPANT_IDENTITY, 'Optional participant provisioned by the Tinode smoke.'),
    item('Smoke', 'TINODE_CHAT_SMOKE_PARTICIPANT_USER_ID', false, false, env.TINODE_CHAT_SMOKE_PARTICIPANT_USER_ID, 'Optional existing Tinode user id for the smoke participant.'),
    item('Preflight Artifacts', 'CONVERACT_TINODE_PREFLIGHT_ENV_CHECKLIST_FILE', false, false, resolveBrandEnv(env, 'TINODE_PREFLIGHT_ENV_CHECKLIST_FILE'), 'Optional Markdown checklist output path.'),
    item('Preflight Artifacts', 'CONVERACT_TINODE_PREFLIGHT_REPORT_FILE', false, false, resolveBrandEnv(env, 'TINODE_PREFLIGHT_REPORT_FILE'), 'Optional JSON preflight report output path.')
  ];
}

function item(
  section: string,
  name: string,
  required: boolean,
  secret: boolean,
  value: string | undefined,
  description: string
): TinodeDeploymentEnvChecklistItem {
  return {
    section,
    name,
    required,
    secret,
    value: String(value || '').trim(),
    description
  };
}

function displayEnvValue(item: TinodeDeploymentEnvChecklistItem): string {
  if (!item.value) return 'missing';
  if (item.name.endsWith('_URL')) return safeReportUrl(item.value) || 'invalid';
  return item.secret ? 'configured' : item.value;
}

function addCheck(
  checks: TinodeDeploymentPreflightCheck[],
  id: string,
  status: TinodeDeploymentPreflightStatus,
  message: string
): void {
  checks.push({ id, status, message });
}

function resolveClientWsUrl(env: NodeJS.ProcessEnv): string {
  const publicUrl = resolvePublicClientWsUrl(env);
  if (publicUrl) return publicUrl;
  const explicit = normalizeUrl(env.TINODE_WS_URL);
  if (explicit) return isWebSocketUrl(explicit) ? explicit : '';
  const baseUrl = normalizeUrl(env.TINODE_BASE_URL);
  if (!isHttpUrl(baseUrl)) return '';
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v0/channels';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function resolvePublicClientWsUrl(env: NodeJS.ProcessEnv): string {
  const explicit = normalizeUrl(env.TINODE_PUBLIC_WS_URL);
  if (explicit) return isWebSocketUrl(explicit) ? explicit : '';
  const baseUrl = normalizeUrl(env.TINODE_PUBLIC_BASE_URL);
  if (!isHttpUrl(baseUrl)) return '';
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v0/channels';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function hasValue(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}

function isPostgresDsn(value: string | undefined): boolean {
  try {
    const url = new URL(String(value || '').trim());
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      Boolean(url.hostname) &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function isBase64Key(value: string | undefined, expectedBytes: number): boolean {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return false;
  }
  const decoded = Buffer.from(normalized, 'base64');
  return decoded.length === expectedBytes && decoded.toString('base64') === normalized;
}

function normalizeUrl(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function safeReportUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, value.endsWith('/') ? '/' : '');
  } catch {
    return '';
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

function isSecureWebSocketUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'wss:';
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const checklistFile = String(resolveBrandEnv(process.env, 'TINODE_PREFLIGHT_ENV_CHECKLIST_FILE') || '').trim();
  const envChecklist = checklistFile
    ? writeTinodeDeploymentEnvChecklist(checklistFile, process.env)
    : undefined;
  const report = createTinodeDeploymentPreflightReport(process.env);
  const reportFilePath = String(resolveBrandEnv(process.env, 'TINODE_PREFLIGHT_REPORT_FILE') || '').trim();
  const reportFile = reportFilePath
    ? writeTinodeDeploymentPreflightReport(reportFilePath, process.env, report)
    : undefined;

  console.log(JSON.stringify({
    ...report,
    ...(envChecklist ? { envChecklist } : {}),
    ...(reportFile ? { reportFile } : {})
  }, null, 2));
  if (!report.ok) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
