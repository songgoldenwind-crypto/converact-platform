import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rustDeskMinimumCommandLeaseMs } from './rustdesk-edge-command.js';

export type RustDeskDeploymentPreflightStatus = 'pass' | 'warn' | 'fail';

export interface RustDeskDeploymentPreflightCheck {
  id: string;
  status: RustDeskDeploymentPreflightStatus;
  message: string;
}

export interface RustDeskDeploymentPreflightReport {
  ok: boolean;
  summary: {
    controlPlaneBaseUrl: string;
    publicKeySource: 'env' | 'file' | 'none';
    targetMode: 'configured' | 'edge-agent' | 'missing';
    tenantConfigured: boolean;
    deviceOnlineCheck: boolean;
    operationAuditCheck: boolean;
    serverPortsCheck: boolean;
    launchPageCheck: boolean;
    protocolUrlRequired: boolean;
    httpsLaunchRequired: boolean;
    physicalDisconnectRequired: boolean;
    physicalDisconnectReadinessCheck: boolean;
    edgeCommandExecutionEnabled: boolean;
    edgeCommandTokenConfigured: boolean;
    edgeTokenSecretConfigured: boolean;
    commandPollIntervalMs: number;
    commandLeaseMs: number;
    commandTimeoutMs: number;
    portCheckHost: string;
  };
  checks: RustDeskDeploymentPreflightCheck[];
}

interface RustDeskDeploymentEnvChecklistItem {
  section: string;
  name: string;
  required: boolean;
  secret?: boolean;
  value: string;
  description: string;
}

export interface RustDeskDeploymentEnvChecklistWriteResult {
  outputFile: string;
  variables: number;
  missing: string[];
}

export interface RustDeskDeploymentPreflightReportWriteResult {
  outputFile: string;
  ok: boolean;
  checks: number;
}

export function createRustDeskDeploymentPreflightReport(env: NodeJS.ProcessEnv): RustDeskDeploymentPreflightReport {
  const checks: RustDeskDeploymentPreflightCheck[] = [];
  const runEdgeAgent = envFlag(env.OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT);
  const deviceOnlineCheck = readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE);
  const operationAuditCheck = readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT);
  const serverPortsCheck = readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS);
  const launchPageCheck = readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL);
  const protocolUrlRequired = readinessFlag(env.OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL);
  const httpsLaunchRequired = envFlag(env.OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL);
  const physicalDisconnectRequired = envFlag(env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT);
  const physicalDisconnectReadinessCheck = envFlag(
    env.OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT
  );
  const disconnectAdapterConfigured = Boolean(
    String(env.OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE || '').trim()
  );
  const restartAdapterConfigured = Boolean(
    String(env.OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE || '').trim()
  );
  const adapterConfigured = disconnectAdapterConfigured || restartAdapterConfigured;
  const edgeCommandTokenConfigured = Boolean(
    String(
      env.OPC_RUSTDESK_EDGE_COMMAND_TOKEN ||
      env.OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE ||
      ''
    ).trim()
  );
  const edgeTokenSecretConfigured = String(
    env.OPC_RUSTDESK_EDGE_TOKEN_SECRET || ''
  ).length >= 32;
  const edgeCommandChecksEnabled =
    (runEdgeAgent && physicalDisconnectReadinessCheck) || adapterConfigured;
  const commandPollIntervalMs = configuredInteger(
    env.OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS,
    2_000
  );
  const commandLeaseMs = configuredInteger(env.OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS, 40_000);
  const commandTimeoutMs = configuredInteger(env.OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS, 15_000);
  const controlPlaneBaseUrl = stripTrailingSlash(env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL || env.OPC_REMOTE_GATEWAY_BASE_URL || '');
  const edgeBaseUrl = stripTrailingSlash(
    env.OPC_RUSTDESK_EDGE_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_COLLABORATION_BASE_URL ||
    controlPlaneBaseUrl
  );
  const launchBaseUrl = stripTrailingSlash(
    env.OPC_RUSTDESK_LAUNCH_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_REMOTE_GATEWAY_BASE_URL ||
    controlPlaneBaseUrl
  );
  const apiTokenConfigured = Boolean(String(env.OPC_RUSTDESK_API_TOKEN || env.OPC_REMOTE_GATEWAY_API_TOKEN || '').trim());
  const tenantConfigured = Boolean(String(env.OPC_REMOTE_GATEWAY_TENANT_ID || env.OPC_RUSTDESK_EDGE_TENANT_ID || env.OPC_TENANT_ID || '').trim());
  const collaborationApiKeyConfigured = Boolean(String(env.OPC_RUSTDESK_EDGE_API_KEY || env.OPC_COLLABORATION_API_KEY || env.OPC_API_KEY || '').trim());
  const targetId = String(env.OPC_REMOTE_GATEWAY_TARGET_ID || '').trim();
  const targetMode = targetId ? 'configured' : runEdgeAgent ? 'edge-agent' : 'missing';
  const publicKey = publicKeyStatus(env);
  const idServer = String(env.OPC_RUSTDESK_ID_SERVER || '').trim();
  const portCheckHost = String(env.OPC_RUSTDESK_CHECK_HOST || idServer || '').trim();

  addUrlCheck(checks, 'control_plane_base_url', controlPlaneBaseUrl, 'RustDesk control-plane base URL is configured');
  addCheck(
    checks,
    'control_plane_token',
    apiTokenConfigured ? 'pass' : 'fail',
    apiTokenConfigured
      ? 'RustDesk control-plane token is configured'
      : 'OPC_RUSTDESK_API_TOKEN or OPC_REMOTE_GATEWAY_API_TOKEN is required'
  );
  addCheck(checks, 'public_key', publicKey.status, publicKey.message);
  addCheck(
    checks,
    'id_server',
    idServer ? 'pass' : 'fail',
    idServer ? 'OPC_RUSTDESK_ID_SERVER is configured' : 'OPC_RUSTDESK_ID_SERVER is required for client setup and port checks'
  );
  addUrlCheck(checks, 'launch_base_url', launchBaseUrl, 'RustDesk public launch base URL is configured');
  addCheck(
    checks,
    'launch_base_url_https',
    !httpsLaunchRequired || isHttpsUrl(launchBaseUrl) ? 'pass' : 'fail',
    !httpsLaunchRequired
      ? 'RustDesk HTTPS launch URL requirement is disabled'
      : isHttpsUrl(launchBaseUrl)
        ? 'RustDesk public launch base URL uses HTTPS'
        : 'OPC_RUSTDESK_LAUNCH_BASE_URL or its fallback must use https:// when OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL=1'
  );
  addCheck(
    checks,
    'target',
    targetMode === 'missing' ? 'fail' : 'pass',
    targetMode === 'configured'
      ? 'OPC_REMOTE_GATEWAY_TARGET_ID is configured'
      : targetMode === 'edge-agent'
        ? 'OPC_REMOTE_GATEWAY_TARGET_ID will be derived from the readiness edge agent'
        : 'OPC_REMOTE_GATEWAY_TARGET_ID is required unless OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT=1'
  );
  addCheck(
    checks,
    'tenant',
    tenantConfigured ? 'pass' : 'fail',
    tenantConfigured
      ? 'Tenant is configured for RustDesk device and gateway checks'
      : 'OPC_REMOTE_GATEWAY_TENANT_ID, OPC_RUSTDESK_EDGE_TENANT_ID, or OPC_TENANT_ID is required'
  );
  addCheck(
    checks,
    'collaboration_api_key',
    collaborationApiKeyConfigured ? 'pass' : 'fail',
    collaborationApiKeyConfigured
      ? 'OPC collaboration API key is configured for device online and edge-agent checks'
      : 'OPC_RUSTDESK_EDGE_API_KEY, OPC_COLLABORATION_API_KEY, or OPC_API_KEY is required'
  );
  addCheck(
    checks,
    'port_check_host',
    !serverPortsCheck || portCheckHost ? 'pass' : 'fail',
    !serverPortsCheck
      ? 'RustDesk server port check is disabled'
      : portCheckHost
        ? 'RustDesk server port check host is configured'
        : 'OPC_RUSTDESK_CHECK_HOST or OPC_RUSTDESK_ID_SERVER is required when port checks are enabled'
  );
  addCheck(
    checks,
    'protocol_url_template',
    !protocolUrlRequired || validRustDeskProtocolTemplate(env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE) ? 'pass' : 'fail',
    !protocolUrlRequired
      ? 'RustDesk protocol URL requirement is disabled'
      : validRustDeskProtocolTemplate(env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE)
        ? 'RustDesk protocol URL template is configured'
        : 'OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE must be a rustdesk:// template when protocol URL is required'
  );
  addCheck(
    checks,
    'physical_disconnect_readiness',
    !physicalDisconnectRequired || physicalDisconnectReadinessCheck ? 'pass' : 'fail',
    !physicalDisconnectRequired
      ? 'RustDesk strict physical disconnect is disabled'
      : physicalDisconnectReadinessCheck
        ? 'RustDesk physical disconnect command/readiness integration is declared'
        : 'OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT=1 is required when OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT=1'
  );
  addCheck(
    checks,
    'physical_disconnect_edge_token_secret',
    !physicalDisconnectRequired && !physicalDisconnectReadinessCheck
      ? 'warn'
      : edgeTokenSecretConfigured ? 'pass' : 'fail',
    edgeTokenSecretConfigured
      ? 'RustDesk server edge-token signing secret is configured'
      : 'OPC_RUSTDESK_EDGE_TOKEN_SECRET must contain at least 32 characters before physical-disconnect commands are enabled'
  );

  if (edgeCommandChecksEnabled) {
    const edgeCredentialsConfigured = Boolean(
      String(
        env.OPC_RUSTDESK_EDGE_API_KEY || env.OPC_COLLABORATION_API_KEY || env.OPC_API_KEY || ''
      ).trim() &&
      String(
        env.OPC_RUSTDESK_EDGE_TENANT_ID || env.OPC_REMOTE_GATEWAY_TENANT_ID || ''
      ).trim()
    );
    addCheck(
      checks,
      'physical_disconnect_edge_credentials',
      edgeCredentialsConfigured ? 'pass' : 'fail',
      edgeCredentialsConfigured
        ? 'RustDesk edge command API key and tenant are configured'
        : 'RustDesk edge command execution requires an edge API key and tenant'
    );
    addCheck(
      checks,
      'physical_disconnect_edge_token',
      edgeCommandTokenConfigured ? 'pass' : 'fail',
      edgeCommandTokenConfigured
        ? 'A device-bound RustDesk edge command token is configured'
        : 'OPC_RUSTDESK_EDGE_COMMAND_TOKEN is required for edge command execution'
    );
    addCheck(
      checks,
      'physical_disconnect_adapter',
      adapterConfigured ? 'pass' : 'fail',
      adapterConfigured
        ? 'A RustDesk local disconnect or service-restart adapter is configured'
        : 'OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE or OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE is required for command execution'
    );
    const timingValid =
      Number.isInteger(commandPollIntervalMs) && commandPollIntervalMs >= 250 &&
      Number.isInteger(commandTimeoutMs) && commandTimeoutMs >= 100 &&
      Number.isInteger(commandLeaseMs) && commandLeaseMs >= 1_000 &&
      commandLeaseMs >= rustDeskMinimumCommandLeaseMs(commandTimeoutMs);
    addCheck(
      checks,
      'physical_disconnect_timing',
      timingValid ? 'pass' : 'fail',
      timingValid
        ? `RustDesk edge command timing is valid: poll=${commandPollIntervalMs}ms, lease=${commandLeaseMs}ms, timeout=${commandTimeoutMs}ms`
        : 'RustDesk edge command timing must use poll >= 250ms, timeout >= 100ms, and lease >= 2 * timeout + 1000ms'
    );
  }

  if (runEdgeAgent) {
    addCheck(checks, 'edge_agent_inputs', edgeAgentReady(env, edgeBaseUrl) ? 'pass' : 'fail', edgeAgentMessage(env, edgeBaseUrl));
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    summary: {
      controlPlaneBaseUrl,
      publicKeySource: publicKey.source,
      targetMode,
      tenantConfigured,
      deviceOnlineCheck,
      operationAuditCheck,
      serverPortsCheck,
      launchPageCheck,
      protocolUrlRequired,
      httpsLaunchRequired,
      physicalDisconnectRequired,
      physicalDisconnectReadinessCheck,
      edgeCommandExecutionEnabled: edgeCommandChecksEnabled && adapterConfigured,
      edgeCommandTokenConfigured,
      edgeTokenSecretConfigured,
      commandPollIntervalMs,
      commandLeaseMs,
      commandTimeoutMs,
      portCheckHost
    },
    checks
  };
}

export function renderRustDeskDeploymentEnvChecklist(env: NodeJS.ProcessEnv): string {
  const items = rustDeskDeploymentEnvChecklistItems(env);
  const sections = Array.from(new Set(items.map((item) => item.section)));
  const lines = [
    '# RustDesk Deployment Env Checklist',
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

export function writeRustDeskDeploymentEnvChecklist(
  outputFile: string,
  env: NodeJS.ProcessEnv
): RustDeskDeploymentEnvChecklistWriteResult {
  const items = rustDeskDeploymentEnvChecklistItems(env);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, renderRustDeskDeploymentEnvChecklist(env), 'utf8');
  return {
    outputFile,
    variables: items.length,
    missing: items.filter((item) => item.required && !item.value).map((item) => item.name)
  };
}

export function writeRustDeskDeploymentPreflightReport(
  outputFile: string,
  env: NodeJS.ProcessEnv,
  report: RustDeskDeploymentPreflightReport = createRustDeskDeploymentPreflightReport(env)
): RustDeskDeploymentPreflightReportWriteResult {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return {
    outputFile,
    ok: report.ok,
    checks: report.checks.length
  };
}

function rustDeskDeploymentEnvChecklistItems(env: NodeJS.ProcessEnv): RustDeskDeploymentEnvChecklistItem[] {
  const hasInlinePublicKey = Boolean(String(env.OPC_RUSTDESK_PUBLIC_KEY || '').trim());
  const runEdgeAgent = envFlag(env.OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT);
  const controlPlaneBaseUrl = stripTrailingSlash(env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL || env.OPC_REMOTE_GATEWAY_BASE_URL || '');
  const launchBaseUrl = stripTrailingSlash(
    env.OPC_RUSTDESK_LAUNCH_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_REMOTE_GATEWAY_BASE_URL ||
    controlPlaneBaseUrl
  );
  const clientConfigBaseUrl = stripTrailingSlash(
    env.OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL ||
    env.OPC_RUSTDESK_IVEKIT_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_REMOTE_GATEWAY_BASE_URL ||
    controlPlaneBaseUrl
  );
  const clientConfigApiKey =
    env.OPC_RUSTDESK_CLIENT_CONFIG_API_KEY ||
    env.OPC_RUSTDESK_IVEKIT_API_KEY ||
    env.OPC_COLLABORATION_API_KEY ||
    env.OPC_API_KEY;
  const clientConfigTenantId =
    env.OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID ||
    env.OPC_RUSTDESK_IVEKIT_TENANT_ID ||
    env.OPC_REMOTE_GATEWAY_TENANT_ID ||
    env.OPC_RUSTDESK_EDGE_TENANT_ID ||
    env.OPC_TENANT_ID;
  const serverPortsCheck = readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS);
  const protocolUrlRequired = readinessFlag(env.OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL);

  return [
    item(env, 'Server Readiness', 'OPC_RUSTDESK_CONTROL_PLANE_BASE_URL', true, 'RustDesk control-plane API base URL. Can fall back to OPC_REMOTE_GATEWAY_BASE_URL.', env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL || env.OPC_REMOTE_GATEWAY_BASE_URL),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_API_TOKEN', true, 'RustDesk control-plane token. Can fall back to OPC_REMOTE_GATEWAY_API_TOKEN.', env.OPC_RUSTDESK_API_TOKEN || env.OPC_REMOTE_GATEWAY_API_TOKEN, true),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_PUBLIC_KEY', false, 'Inline RustDesk public key. Use file variable when mounted from hbbs volume.', env.OPC_RUSTDESK_PUBLIC_KEY),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_PUBLIC_KEY_FILE', !hasInlinePublicKey, 'Mounted id_ed25519.pub path readable by OPC. Required when OPC_RUSTDESK_PUBLIC_KEY is not set.', env.OPC_RUSTDESK_PUBLIC_KEY_FILE),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_ID_SERVER', true, 'RustDesk ID server shown to clients and used by port checks.', env.OPC_RUSTDESK_ID_SERVER),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_RELAY_SERVER', false, 'RustDesk relay server shown to clients.', env.OPC_RUSTDESK_RELAY_SERVER),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_LAUNCH_BASE_URL', true, 'Public base URL for signed RustDesk launch pages. Can fall back to OPC_BASE_URL, OPC_REMOTE_GATEWAY_BASE_URL, or control-plane base URL.', launchBaseUrl),
    item(env, 'Server Readiness', 'OPC_REMOTE_GATEWAY_TENANT_ID', true, 'Tenant used by remote-gateway smoke/readiness. Can fall back to OPC_RUSTDESK_EDGE_TENANT_ID or OPC_TENANT_ID.', env.OPC_REMOTE_GATEWAY_TENANT_ID || env.OPC_RUSTDESK_EDGE_TENANT_ID || env.OPC_TENANT_ID),
    item(env, 'Server Readiness', 'OPC_REMOTE_GATEWAY_TARGET_ID', !runEdgeAgent, 'Internal rustdesk_devices.id when device online check is enabled, or raw target during early smoke. Optional when readiness edge-agent derives the target.', env.OPC_REMOTE_GATEWAY_TARGET_ID),
    item(env, 'Server Readiness', 'OPC_COLLABORATION_API_KEY', true, 'OPC API key used for device online checks. Can fall back to OPC_RUSTDESK_EDGE_API_KEY or OPC_API_KEY.', env.OPC_RUSTDESK_EDGE_API_KEY || env.OPC_COLLABORATION_API_KEY || env.OPC_API_KEY, true),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_CHECK_HOST', serverPortsCheck, 'Host used by hbbs/hbbr TCP/UDP port checks. Required when server port checks are enabled; can fall back to OPC_RUSTDESK_ID_SERVER.', env.OPC_RUSTDESK_CHECK_HOST || env.OPC_RUSTDESK_ID_SERVER),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE', protocolUrlRequired, 'rustdesk:// template containing {rustdesk_id}. Required when protocol URL checks are enabled.', env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT', false, 'Set to 1 to reject new RustDesk sessions unless the device heartbeat declares physical-disconnect command capability.', env.OPC_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT),
    item(env, 'Server Readiness', 'OPC_RUSTDESK_EDGE_TOKEN_SECRET', false, 'Server-only HMAC secret used to verify device-bound edge command tokens. Use at least 32 characters.', env.OPC_RUSTDESK_EDGE_TOKEN_SECRET, true),
    item(env, 'Readiness Switches', 'OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT', false, 'Set to 1 to register/heartbeat device before readiness.', env.OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT),
    item(env, 'Readiness Switches', 'OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE', false, 'Dedicated strict device-online switch. Defaults to enabled.', env.OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE),
    item(env, 'Readiness Switches', 'OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT', false, 'Dedicated strict operation-audit switch. Defaults to enabled.', env.OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT),
    item(env, 'Readiness Switches', 'OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS', false, 'Dedicated strict TCP/UDP port switch. Defaults to enabled.', env.OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS),
    item(env, 'Readiness Switches', 'OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL', false, 'Dedicated strict protocol URL switch. Defaults to enabled.', env.OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL),
    item(env, 'Readiness Switches', 'OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL', false, 'Set to 1 to require https:// public launch base URLs for production DNS/TLS/Ingress readiness.', env.OPC_RUSTDESK_READINESS_REQUIRE_HTTPS_LAUNCH_URL),
    item(env, 'Readiness Switches', 'OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT', false, 'Set to 1 to execute a fake/local edge command and require succeeded command evidence during combined readiness.', env.OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_INSTANCE_ID', false, 'Stable identity written into command claim and result evidence.', env.OPC_RUSTDESK_EDGE_INSTANCE_ID),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_COMMAND_TOKEN', false, 'Device-bound signed token used only by claim/progress/result routes.', env.OPC_RUSTDESK_EDGE_COMMAND_TOKEN, true),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE', false, 'Restricted local file containing the device-bound command token.', env.OPC_RUSTDESK_EDGE_COMMAND_TOKEN_FILE),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS', false, 'Command polling interval in milliseconds. Defaults to 2000.', env.OPC_RUSTDESK_EDGE_COMMAND_POLL_INTERVAL_MS),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS', false, 'Command lease in milliseconds. Defaults to 40000 and must cover primary and fallback timeouts plus reporting margin.', env.OPC_RUSTDESK_EDGE_COMMAND_LEASE_MS),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS', false, 'Local adapter timeout in milliseconds. Defaults to 15000.', env.OPC_RUSTDESK_EDGE_COMMAND_TIMEOUT_MS),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE', false, 'Device-local session disconnect wrapper. At least one local adapter is required for command execution.', env.OPC_RUSTDESK_EDGE_DISCONNECT_EXECUTABLE, true),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON', false, 'Fixed JSON string array passed to the disconnect wrapper. Server identifiers are supplied only through environment variables.', env.OPC_RUSTDESK_EDGE_DISCONNECT_ARGS_JSON, true),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE', false, 'Device-local RustDesk service restart wrapper used as fallback.', env.OPC_RUSTDESK_EDGE_RESTART_EXECUTABLE, true),
    item(env, 'Edge Command', 'OPC_RUSTDESK_EDGE_RESTART_ARGS_JSON', false, 'Fixed JSON string array passed to the restart wrapper.', env.OPC_RUSTDESK_EDGE_RESTART_ARGS_JSON, true),
    item(env, 'Event Audit', 'OPC_RUSTDESK_EVENT_TEMPLATE_FILE', false, 'Where to generate JSONL event templates for sidecar integration.', env.OPC_RUSTDESK_EVENT_TEMPLATE_FILE),
    item(env, 'Event Audit', 'OPC_RUSTDESK_EVENT_FILE', false, 'JSONL file used by event forwarder or validate-only mode.', env.OPC_RUSTDESK_EVENT_FILE),
    item(env, 'Event Audit', 'OPC_RUSTDESK_EVENT_VALIDATE_ONLY', false, 'Set to 1 to validate event JSONL without posting.', env.OPC_RUSTDESK_EVENT_VALIDATE_ONLY),
    item(env, 'Event Audit', 'OPC_RUSTDESK_EVENT_DEAD_LETTER_FILE', false, 'Local JSONL file for failed event forwards.', env.OPC_RUSTDESK_EVENT_DEAD_LETTER_FILE),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE', false, 'Markdown output path for the RustDesk client installation/config handoff pack.', env.OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_PACK_TITLE', false, 'Display title written into the client config handoff pack.', env.OPC_RUSTDESK_CLIENT_CONFIG_PACK_TITLE),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_BASE_URL', false, 'iveKit/OPC base URL used to fetch /api/ivekit/rustdesk/client-config. Can fall back to OPC_RUSTDESK_IVEKIT_BASE_URL, OPC_BASE_URL, OPC_REMOTE_GATEWAY_BASE_URL, or control-plane base URL.', clientConfigBaseUrl),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_API_KEY', false, 'API key used to fetch iveKit RustDesk client config. Can fall back to OPC_RUSTDESK_IVEKIT_API_KEY, OPC_COLLABORATION_API_KEY, or OPC_API_KEY.', clientConfigApiKey, true),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_TENANT_ID', false, 'Tenant used to fetch iveKit RustDesk client config. Can fall back to OPC_RUSTDESK_IVEKIT_TENANT_ID, OPC_REMOTE_GATEWAY_TENANT_ID, OPC_RUSTDESK_EDGE_TENANT_ID, or OPC_TENANT_ID.', clientConfigTenantId),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_USER_ID', false, 'Optional operator/user id sent when fetching the client config or launch plan.', env.OPC_RUSTDESK_CLIENT_CONFIG_USER_ID),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID', false, 'Optional gateway external_id used to include a concrete launch plan in the handoff pack.', env.OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID),
    item(env, 'Client Config Pack', 'OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID', false, 'Optional expected RustDesk runtime id used to validate the launch plan target.', env.OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID),
    item(env, 'Client Acceptance', 'OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE', false, 'Where to generate the manual real-client acceptance report template.', env.OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE),
    item(env, 'Client Acceptance', 'OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE', false, 'Filled real-client acceptance report path.', env.OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE),
    item(env, 'Client Acceptance', 'OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE', false, 'Optional audit JSON/JSONL export for acceptance gate.', env.OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE),
    item(env, 'Final Evidence', 'OPC_RUSTDESK_AUDIT_COVERAGE_FILE', false, 'Audit JSON/JSONL export consumed by rustdesk:audit-coverage.', env.OPC_RUSTDESK_AUDIT_COVERAGE_FILE),
    item(env, 'Final Evidence', 'OPC_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID', false, 'Optional external_id filter for audit coverage validation.', env.OPC_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID),
    item(env, 'Final Evidence', 'OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE', false, 'Audit coverage JSON report consumed by the final evidence pack.', env.OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE),
    item(env, 'Final Evidence', 'OPC_RUSTDESK_EVIDENCE_PACK_FILE', false, 'Final customer handoff evidence pack markdown output.', env.OPC_RUSTDESK_EVIDENCE_PACK_FILE),
    item(env, 'Final Evidence', 'OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE', false, 'Audit coverage report path passed into rustdesk:evidence-pack.', env.OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE),
    item(env, 'Final Evidence', 'OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE', false, 'Client config pack artifact path passed into rustdesk:evidence-pack.', env.OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE || env.OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE),
    item(env, 'LED Handoff', 'OPC_RUSTDESK_LED_EXAMPLE_BASE_URL', false, 'OPC base URL used by LED example. Can fall back to OPC_BASE_URL.', env.OPC_RUSTDESK_LED_EXAMPLE_BASE_URL || env.OPC_BASE_URL),
    item(env, 'LED Handoff', 'OPC_RUSTDESK_LED_EXAMPLE_API_KEY', false, 'API key used by LED example.', env.OPC_RUSTDESK_LED_EXAMPLE_API_KEY, true),
    item(env, 'LED Handoff', 'OPC_RUSTDESK_LED_EXAMPLE_TENANT_ID', false, 'Tenant used by LED example.', env.OPC_RUSTDESK_LED_EXAMPLE_TENANT_ID),
    item(env, 'LED Handoff', 'OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID', false, 'Existing remote_session_id provided by OPC/LED workflow.', env.OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID),
    item(env, 'LED Handoff', 'OPC_RUSTDESK_LED_EXAMPLE_DEVICE_ID', false, 'Existing internal rustdesk_devices.id for LED example.', env.OPC_RUSTDESK_LED_EXAMPLE_DEVICE_ID),
    item(env, 'LED Handoff', 'OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID', false, 'Raw RustDesk runtime ID when LED example should register a device.', env.OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID)
  ];
}

function item(
  env: NodeJS.ProcessEnv,
  section: string,
  name: string,
  required: boolean,
  description: string,
  value: string | undefined,
  secret = false
): RustDeskDeploymentEnvChecklistItem {
  return {
    section,
    name,
    required,
    secret,
    value: String(value || '').trim(),
    description
  };
}

function displayEnvValue(item: RustDeskDeploymentEnvChecklistItem): string {
  if (!item.value) return 'missing';
  return item.secret ? 'configured' : item.value;
}

function addUrlCheck(
  checks: RustDeskDeploymentPreflightCheck[],
  id: string,
  value: string,
  passMessage: string
): void {
  if (!value) {
    addCheck(checks, id, 'fail', `${idToEnvMessage(id)} is required`);
    return;
  }
  addCheck(checks, id, isHttpUrl(value) ? 'pass' : 'fail', isHttpUrl(value) ? passMessage : `${idToEnvMessage(id)} must use http(s)`);
}

function addCheck(
  checks: RustDeskDeploymentPreflightCheck[],
  id: string,
  status: RustDeskDeploymentPreflightStatus,
  message: string
): void {
  checks.push({ id, status, message });
}

function publicKeyStatus(env: NodeJS.ProcessEnv): {
  source: RustDeskDeploymentPreflightReport['summary']['publicKeySource'];
  status: RustDeskDeploymentPreflightStatus;
  message: string;
} {
  const envKey = String(env.OPC_RUSTDESK_PUBLIC_KEY || '').trim();
  if (envKey) return { source: 'env', status: 'pass', message: 'OPC_RUSTDESK_PUBLIC_KEY is configured' };
  const filePath = String(env.OPC_RUSTDESK_PUBLIC_KEY_FILE || '').trim();
  if (!filePath) return { source: 'none', status: 'fail', message: 'OPC_RUSTDESK_PUBLIC_KEY or OPC_RUSTDESK_PUBLIC_KEY_FILE is required' };
  try {
    const fileValue = readFileSync(filePath, 'utf8').trim();
    if (!fileValue) return { source: 'file', status: 'fail', message: `RustDesk public key file is empty: ${filePath}` };
    return { source: 'file', status: 'pass', message: `RustDesk public key file is readable: ${filePath}` };
  } catch {
    return { source: 'file', status: 'fail', message: `RustDesk public key file cannot be read: ${filePath}` };
  }
}

function edgeAgentReady(env: NodeJS.ProcessEnv, edgeBaseUrl: string): boolean {
  return Boolean(
    edgeBaseUrl &&
    isHttpUrl(edgeBaseUrl) &&
    String(env.OPC_RUSTDESK_EDGE_API_KEY || env.OPC_COLLABORATION_API_KEY || env.OPC_API_KEY || '').trim() &&
    String(env.OPC_RUSTDESK_EDGE_TENANT_ID || env.OPC_REMOTE_GATEWAY_TENANT_ID || '').trim() &&
    String(env.OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE || '').trim() &&
    String(env.OPC_RUSTDESK_EDGE_BUSINESS_REF_ID || '').trim() &&
    String(env.OPC_RUSTDESK_EDGE_RUSTDESK_ID || env.RUSTDESK_ID || '').trim()
  );
}

function edgeAgentMessage(env: NodeJS.ProcessEnv, edgeBaseUrl: string): string {
  if (edgeAgentReady(env, edgeBaseUrl)) return 'RustDesk readiness edge-agent inputs are configured';
  const missing: string[] = [];
  if (!edgeBaseUrl || !isHttpUrl(edgeBaseUrl)) missing.push('OPC_RUSTDESK_EDGE_BASE_URL or OPC_BASE_URL');
  if (!String(env.OPC_RUSTDESK_EDGE_API_KEY || env.OPC_COLLABORATION_API_KEY || env.OPC_API_KEY || '').trim()) missing.push('OPC_RUSTDESK_EDGE_API_KEY or OPC_COLLABORATION_API_KEY or OPC_API_KEY');
  if (!String(env.OPC_RUSTDESK_EDGE_TENANT_ID || env.OPC_REMOTE_GATEWAY_TENANT_ID || '').trim()) missing.push('OPC_RUSTDESK_EDGE_TENANT_ID or OPC_REMOTE_GATEWAY_TENANT_ID');
  if (!String(env.OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE || '').trim()) missing.push('OPC_RUSTDESK_EDGE_BUSINESS_REF_TYPE');
  if (!String(env.OPC_RUSTDESK_EDGE_BUSINESS_REF_ID || '').trim()) missing.push('OPC_RUSTDESK_EDGE_BUSINESS_REF_ID');
  if (!String(env.OPC_RUSTDESK_EDGE_RUSTDESK_ID || env.RUSTDESK_ID || '').trim()) missing.push('OPC_RUSTDESK_EDGE_RUSTDESK_ID or RUSTDESK_ID');
  return `RustDesk readiness edge-agent inputs missing: ${missing.join(', ')}`;
}

function validRustDeskProtocolTemplate(value: string | undefined): boolean {
  const template = String(value || '').trim();
  if (!template) return false;
  try {
    return new URL(template.replaceAll('{rustdesk_id}', '123456789').replaceAll('{external_id}', 'rdgw_preflight')).protocol === 'rustdesk:';
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
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

function envFlag(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function readinessFlag(value: string | undefined): boolean {
  return value === undefined ? true : envFlag(value);
}

function configuredInteger(value: string | undefined, defaultValue: number): number {
  const raw = String(value || '').trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function stripTrailingSlash(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function idToEnvMessage(id: string): string {
  if (id === 'control_plane_base_url') return 'OPC_RUSTDESK_CONTROL_PLANE_BASE_URL or OPC_REMOTE_GATEWAY_BASE_URL';
  if (id === 'launch_base_url') return 'OPC_RUSTDESK_LAUNCH_BASE_URL, OPC_BASE_URL, or OPC_REMOTE_GATEWAY_BASE_URL';
  return id;
}

async function main(): Promise<void> {
  const checklistFile = String(process.env.OPC_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE || '').trim();
  const envChecklist = checklistFile ? writeRustDeskDeploymentEnvChecklist(checklistFile, process.env) : undefined;
  const reportFilePath = String(process.env.OPC_RUSTDESK_PREFLIGHT_REPORT_FILE || '').trim();
  const report = createRustDeskDeploymentPreflightReport(process.env);
  const reportFile = reportFilePath
    ? writeRustDeskDeploymentPreflightReport(reportFilePath, process.env, report)
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
