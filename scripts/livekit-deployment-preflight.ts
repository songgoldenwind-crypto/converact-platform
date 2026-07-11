import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LiveKitDeploymentPreflightStatus = 'pass' | 'warn' | 'fail';

export interface LiveKitDeploymentPreflightCheck {
  id: string;
  status: LiveKitDeploymentPreflightStatus;
  message: string;
}

export interface LiveKitDeploymentPreflightReport {
  ok: boolean;
  summary: {
    livekitUrl: string;
    livekitInternalUrl: string;
    livekitPublicUrl: string;
    deploymentMode: LiveKitDeploymentMode;
    opcBaseUrl: string;
    frontendUrl: string;
    mediaTokenConfigured: boolean;
    inviteSecretConfigured: boolean;
    tenantConfigured: boolean;
    egressConfigured: boolean;
    targets: string[];
  };
  checks: LiveKitDeploymentPreflightCheck[];
}

interface LiveKitDeploymentEnvChecklistItem {
  section: string;
  name: string;
  required: boolean;
  secret?: boolean;
  value: string;
  description: string;
}

export interface LiveKitDeploymentEnvChecklistWriteResult {
  outputFile: string;
  variables: number;
  missing: string[];
}

export interface LiveKitDeploymentPreflightReportWriteResult {
  outputFile: string;
  ok: boolean;
  checks: number;
}

type LiveKitReadinessTarget =
  | 'media'
  | 'avatar'
  | 'ai-callback'
  | 'agent-browser'
  | 'customer-browser'
  | 'web-assist-browser'
  | 'collaboration'
  | 'remote-gateway'
  | 'sip-volte';

type LiveKitDeploymentMode = 'external' | 'standalone-vm' | 'bundled-dev';

const DEFAULT_MEDIA_IMAGE_TAGS = {
  server: 'v1.13.3',
  egress: 'v1.13.0',
  sip: 'v1.6.0',
  caddyl4: 'v2.11.3',
  redis: '7.4.9'
} as const;

const DEFAULT_TARGETS: LiveKitReadinessTarget[] = [
  'media',
  'avatar',
  'ai-callback',
  'agent-browser',
  'customer-browser',
  'collaboration',
  'sip-volte'
];

export function createLiveKitDeploymentPreflightReport(
  env: NodeJS.ProcessEnv
): LiveKitDeploymentPreflightReport {
  const checks: LiveKitDeploymentPreflightCheck[] = [];
  const targets = parseTargets(env.OPC_VIDEO_READINESS_TARGETS);
  const browserRequired = targets.some((target) =>
    target === 'agent-browser' || target === 'customer-browser' || target === 'web-assist-browser'
  );
  const livekitInternalUrl = String(env.LIVEKIT_URL || env.OPC_LIVEKIT_URL || '').trim();
  const livekitPublicUrl = String(env.LIVEKIT_PUBLIC_URL || env.OPC_LIVEKIT_PUBLIC_URL || '').trim();
  const deploymentMode = parseDeploymentMode(env.OPC_LIVEKIT_DEPLOYMENT_MODE);
  const opcBaseUrl = stripTrailingSlash(env.OPC_BASE_URL);
  const frontendUrl = stripTrailingSlash(env.OPC_FRONTEND_URL);
  const mediaToken = String(env.OPC_MEDIA_API_TOKEN || env.LIVEKIT_MEDIA_API_TOKEN || '').trim();
  const inviteSecret = String(env.OPC_MEDIA_INVITE_SECRET || env.LIVEKIT_MEDIA_INVITE_SECRET || '').trim();
  const mediaTenant = String(env.OPC_MEDIA_SMOKE_TENANT_ID || env.OPC_TENANT_ID || '').trim();
  const minioAccessKey = String(env.MINIO_ACCESS_KEY || '').trim();
  const minioSecretKey = String(env.MINIO_SECRET_KEY || '').trim();

  addCheck(
    checks,
    'livekit_internal_url',
    isLiveKitUrl(livekitInternalUrl) ? 'pass' : 'fail',
    livekitInternalUrl
      ? 'LIVEKIT_URL is configured for server-side LiveKit connections'
      : 'LIVEKIT_URL or OPC_LIVEKIT_URL is required'
  );
  addCheck(
    checks,
    'livekit_public_url',
    livekitPublicUrl ? 'pass' : browserRequired ? 'fail' : 'warn',
    livekitPublicUrl
      ? 'LIVEKIT_PUBLIC_URL is configured for browser joins'
      : browserRequired
        ? 'LIVEKIT_PUBLIC_URL or OPC_LIVEKIT_PUBLIC_URL is required for browser targets'
        : 'LIVEKIT_PUBLIC_URL is not required by the selected server-only targets'
  );
  addCheck(
    checks,
    'livekit_public_wss',
    livekitPublicUrl ? (isSecureLiveKitUrl(livekitPublicUrl) ? 'pass' : 'fail') : 'warn',
    livekitPublicUrl
      ? isSecureLiveKitUrl(livekitPublicUrl)
        ? 'LIVEKIT_PUBLIC_URL uses wss://'
        : 'LIVEKIT_PUBLIC_URL must use wss:// for production browser joins'
      : 'LIVEKIT_PUBLIC_URL WSS validation was not evaluated'
  );
  addCheck(
    checks,
    'livekit_deployment_mode',
    deploymentMode ? (env.NODE_ENV === 'production' && deploymentMode === 'bundled-dev' ? 'fail' : 'pass') : 'fail',
    deploymentMode
      ? env.NODE_ENV === 'production' && deploymentMode === 'bundled-dev'
        ? 'bundled-dev is not allowed for production LiveKit deployment'
        : `LiveKit deployment mode is ${deploymentMode}`
      : 'OPC_LIVEKIT_DEPLOYMENT_MODE must be external, standalone-vm, or bundled-dev'
  );
  if (deploymentMode === 'standalone-vm') {
    addDomainCheck(checks, 'livekit_signal_domain', env.LIVEKIT_SIGNAL_DOMAIN);
    addDomainCheck(checks, 'livekit_turn_domain', env.LIVEKIT_TURN_DOMAIN, env.LIVEKIT_SIGNAL_DOMAIN);
    addEmailCheck(checks, 'livekit_acme_email', env.LIVEKIT_ACME_EMAIL);
    addPinnedImageTagCheck(checks, 'livekit_server_image_tag', env.LIVEKIT_SERVER_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.server);
    addPinnedImageTagCheck(checks, 'livekit_egress_image_tag', env.LIVEKIT_EGRESS_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.egress);
    addPinnedImageTagCheck(checks, 'livekit_sip_image_tag', env.LIVEKIT_SIP_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.sip);
    addPinnedImageTagCheck(checks, 'livekit_caddyl4_image_tag', env.LIVEKIT_CADDYL4_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.caddyl4);
    addPinnedImageTagCheck(checks, 'livekit_redis_image_tag', env.LIVEKIT_REDIS_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.redis);
  }
  addRequiredSecret(checks, 'livekit_api_key', env.LIVEKIT_API_KEY || env.OPC_LIVEKIT_API_KEY, 'LIVEKIT_API_KEY or OPC_LIVEKIT_API_KEY is required');
  addRequiredSecret(checks, 'livekit_api_secret', env.LIVEKIT_API_SECRET || env.OPC_LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET or OPC_LIVEKIT_API_SECRET is required');
  addHttpUrlCheck(checks, 'opc_base_url', opcBaseUrl, 'OPC_BASE_URL is configured');
  addRequiredSecret(checks, 'media_api_token', mediaToken, 'OPC_MEDIA_API_TOKEN or LIVEKIT_MEDIA_API_TOKEN is required');
  addRequiredSecret(checks, 'media_invite_secret', inviteSecret, 'OPC_MEDIA_INVITE_SECRET or LIVEKIT_MEDIA_INVITE_SECRET is required');
  addRequiredValue(checks, 'media_smoke_tenant', mediaTenant, 'OPC_MEDIA_SMOKE_TENANT_ID or OPC_TENANT_ID is required');
  addRequiredSecret(checks, 'minio_access_key', minioAccessKey, 'MINIO_ACCESS_KEY is required for LiveKit Egress config');
  addRequiredSecret(checks, 'minio_secret_key', minioSecretKey, 'MINIO_SECRET_KEY is required for LiveKit Egress config');
  addIntegerRangeCheck(
    checks,
    'media_recording_retention_days',
    env.OPC_MEDIA_RECORDING_RETENTION_DAYS || '90',
    1,
    3650
  );
  addIntegerRangeCheck(
    checks,
    'media_recording_http_timeout',
    env.OPC_RECORDING_HTTP_TIMEOUT_MS || '15000',
    1,
    300_000
  );
  addIntegerRangeCheck(
    checks,
    'media_recording_object_timeout',
    env.OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS || '60000',
    1,
    3_600_000
  );
  addIntegerRangeCheck(
    checks,
    'media_recording_object_poll_interval',
    env.OPC_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS || '2000',
    1,
    60_000
  );

  if (targets.includes('agent-browser')) {
    addHttpUrlCheck(checks, 'agent_browser_frontend_url', frontendUrl, 'OPC_FRONTEND_URL is configured for agent browser smoke');
    addRequiredValue(checks, 'agent_browser_agent_a_token', env.OPC_BROWSER_SMOKE_AGENT_A_TOKEN, 'OPC_BROWSER_SMOKE_AGENT_A_TOKEN is required');
    addRequiredValue(checks, 'agent_browser_agent_a_user_id', env.OPC_BROWSER_SMOKE_AGENT_A_USER_ID, 'OPC_BROWSER_SMOKE_AGENT_A_USER_ID is required');
    addRequiredValue(checks, 'agent_browser_agent_a_seat_id', env.OPC_BROWSER_SMOKE_AGENT_A_SEAT_ID, 'OPC_BROWSER_SMOKE_AGENT_A_SEAT_ID is required');
    addRequiredValue(checks, 'agent_browser_agent_b_token', env.OPC_BROWSER_SMOKE_AGENT_B_TOKEN, 'OPC_BROWSER_SMOKE_AGENT_B_TOKEN is required');
    addRequiredValue(checks, 'agent_browser_agent_b_user_id', env.OPC_BROWSER_SMOKE_AGENT_B_USER_ID, 'OPC_BROWSER_SMOKE_AGENT_B_USER_ID is required');
    addRequiredValue(checks, 'agent_browser_agent_b_seat_id', env.OPC_BROWSER_SMOKE_AGENT_B_SEAT_ID, 'OPC_BROWSER_SMOKE_AGENT_B_SEAT_ID is required');
  }

  if (targets.includes('customer-browser')) {
    addHttpUrlCheck(checks, 'customer_browser_frontend_url', frontendUrl, 'OPC_FRONTEND_URL is configured for customer browser smoke');
    addRequiredValue(
      checks,
      'customer_browser_url_or_room',
      env.OPC_CUSTOMER_VIDEO_URL || env.OPC_CUSTOMER_BROWSER_SMOKE_URL || env.OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME,
      'OPC_CUSTOMER_VIDEO_URL, OPC_CUSTOMER_BROWSER_SMOKE_URL, or OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME is required'
    );
    addRequiredValue(
      checks,
      'customer_browser_tenant',
      env.OPC_CUSTOMER_VIDEO_URL || env.OPC_CUSTOMER_BROWSER_SMOKE_URL || env.OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID || env.OPC_TENANT_ID,
      'OPC_CUSTOMER_VIDEO_URL, OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID, or OPC_TENANT_ID is required'
    );
  }

  if (targets.includes('web-assist-browser')) {
    addHttpUrlCheck(checks, 'web_assist_frontend_url', frontendUrl, 'OPC_FRONTEND_URL is configured for Web Assist browser smoke');
    addRequiredValue(
      checks,
      'web_assist_customer_url',
      env.OPC_WEB_ASSIST_CUSTOMER_URL || env.OPC_REMOTE_ASSIST_CUSTOMER_URL,
      'OPC_WEB_ASSIST_CUSTOMER_URL or OPC_REMOTE_ASSIST_CUSTOMER_URL is required'
    );
    addRequiredValue(checks, 'web_assist_engineer_token', env.OPC_WEB_ASSIST_ENGINEER_TOKEN, 'OPC_WEB_ASSIST_ENGINEER_TOKEN is required');
    addRequiredValue(checks, 'web_assist_engineer_user_id', env.OPC_WEB_ASSIST_ENGINEER_USER_ID, 'OPC_WEB_ASSIST_ENGINEER_USER_ID is required');
    addRequiredValue(
      checks,
      'web_assist_tenant',
      env.OPC_WEB_ASSIST_TENANT_ID || env.OPC_TENANT_ID,
      'OPC_WEB_ASSIST_TENANT_ID or OPC_TENANT_ID is required'
    );
  }

  if (targets.includes('sip-volte')) {
    addRequiredValue(checks, 'sip_bridge_target', env.LIVEKIT_SIP_BRIDGE_TARGET, 'LIVEKIT_SIP_BRIDGE_TARGET is required');
    addRequiredValue(checks, 'rustpbx_livekit_trunk', env.RUSTPBX_LIVEKIT_TRUNK, 'RUSTPBX_LIVEKIT_TRUNK is required');
    addRequiredValue(checks, 'rustpbx_rwi_url', env.RUSTPBX_RWI_URL, 'RUSTPBX_RWI_URL is required');
    addRequiredSecret(checks, 'rustpbx_rwi_token', env.RUSTPBX_RWI_TOKEN, 'RUSTPBX_RWI_TOKEN is required');
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    summary: {
      livekitUrl: livekitInternalUrl,
      livekitInternalUrl,
      livekitPublicUrl,
      deploymentMode: deploymentMode || 'bundled-dev',
      opcBaseUrl,
      frontendUrl,
      mediaTokenConfigured: Boolean(mediaToken),
      inviteSecretConfigured: Boolean(inviteSecret),
      tenantConfigured: Boolean(mediaTenant),
      egressConfigured: Boolean(minioAccessKey && minioSecretKey),
      targets
    },
    checks
  };
}

export function renderLiveKitDeploymentEnvChecklist(env: NodeJS.ProcessEnv): string {
  const items = liveKitDeploymentEnvChecklistItems(env);
  const sections = Array.from(new Set(items.map((item) => item.section)));
  const lines = [
    '# LiveKit Deployment Env Checklist',
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

export function writeLiveKitDeploymentEnvChecklist(
  outputFile: string,
  env: NodeJS.ProcessEnv
): LiveKitDeploymentEnvChecklistWriteResult {
  const items = liveKitDeploymentEnvChecklistItems(env);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, renderLiveKitDeploymentEnvChecklist(env), 'utf8');
  return {
    outputFile,
    variables: items.length,
    missing: items.filter((item) => item.required && !item.value).map((item) => item.name)
  };
}

export function writeLiveKitDeploymentPreflightReport(
  outputFile: string,
  env: NodeJS.ProcessEnv,
  report: LiveKitDeploymentPreflightReport = createLiveKitDeploymentPreflightReport(env)
): LiveKitDeploymentPreflightReportWriteResult {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return {
    outputFile,
    ok: report.ok,
    checks: report.checks.length
  };
}

function liveKitDeploymentEnvChecklistItems(env: NodeJS.ProcessEnv): LiveKitDeploymentEnvChecklistItem[] {
  const targets = parseTargets(env.OPC_VIDEO_READINESS_TARGETS);
  const browserRequired = targets.some((target) =>
    target === 'agent-browser' || target === 'customer-browser' || target === 'web-assist-browser'
  );
  const webAssistRequired = targets.includes('web-assist-browser');
  const sipRequired = targets.includes('sip-volte');

  return [
    item('LiveKit Server', 'LIVEKIT_URL', true, 'Internal LiveKit WebSocket URL used by OPC and service workloads. Can fall back to OPC_LIVEKIT_URL.', env.LIVEKIT_URL || env.OPC_LIVEKIT_URL),
    item('LiveKit Server', 'LIVEKIT_PUBLIC_URL', browserRequired, 'Public wss:// URL returned to browser clients. Can fall back to OPC_LIVEKIT_PUBLIC_URL.', env.LIVEKIT_PUBLIC_URL || env.OPC_LIVEKIT_PUBLIC_URL),
    item('LiveKit Server', 'OPC_LIVEKIT_DEPLOYMENT_MODE', true, 'external, standalone-vm, or bundled-dev.', parseDeploymentMode(env.OPC_LIVEKIT_DEPLOYMENT_MODE) || ''),
    item('LiveKit Server', 'LIVEKIT_SIGNAL_DOMAIN', parseDeploymentMode(env.OPC_LIVEKIT_DEPLOYMENT_MODE) === 'standalone-vm', 'Signal domain for standalone VM WSS.', env.LIVEKIT_SIGNAL_DOMAIN),
    item('LiveKit Server', 'LIVEKIT_TURN_DOMAIN', parseDeploymentMode(env.OPC_LIVEKIT_DEPLOYMENT_MODE) === 'standalone-vm', 'TURN domain for standalone VM TURN/TLS.', env.LIVEKIT_TURN_DOMAIN),
    item('LiveKit Server', 'LIVEKIT_ACME_EMAIL', parseDeploymentMode(env.OPC_LIVEKIT_DEPLOYMENT_MODE) === 'standalone-vm', 'ACME account email for standalone VM certificates.', env.LIVEKIT_ACME_EMAIL),
    item('LiveKit Server', 'LIVEKIT_SERVER_IMAGE_TAG', false, 'Pinned LiveKit Server image tag.', env.LIVEKIT_SERVER_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.server),
    item('LiveKit Server', 'LIVEKIT_EGRESS_IMAGE_TAG', false, 'Pinned LiveKit Egress image tag.', env.LIVEKIT_EGRESS_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.egress),
    item('LiveKit Server', 'LIVEKIT_SIP_IMAGE_TAG', false, 'Pinned LiveKit SIP image tag.', env.LIVEKIT_SIP_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.sip),
    item('LiveKit Server', 'LIVEKIT_CADDYL4_IMAGE_TAG', false, 'Pinned LiveKit Caddy L4 image tag.', env.LIVEKIT_CADDYL4_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.caddyl4),
    item('LiveKit Server', 'LIVEKIT_REDIS_IMAGE_TAG', false, 'Pinned Redis image tag for standalone Media Core.', env.LIVEKIT_REDIS_IMAGE_TAG || DEFAULT_MEDIA_IMAGE_TAGS.redis),
    item('LiveKit Server', 'LIVEKIT_API_KEY', true, 'LiveKit API key. Can fall back to OPC_LIVEKIT_API_KEY.', env.LIVEKIT_API_KEY || env.OPC_LIVEKIT_API_KEY, true),
    item('LiveKit Server', 'LIVEKIT_API_SECRET', true, 'LiveKit API secret. Can fall back to OPC_LIVEKIT_API_SECRET.', env.LIVEKIT_API_SECRET || env.OPC_LIVEKIT_API_SECRET, true),
    item('LiveKit Server', 'OPC_BASE_URL', true, 'Public or internal OPC backend base URL used by smoke scripts.', env.OPC_BASE_URL),
    item('LiveKit Server', 'OPC_FRONTEND_URL', browserRequired, 'Frontend URL required by browser readiness targets.', env.OPC_FRONTEND_URL),
    item('Media API', 'OPC_MEDIA_API_TOKEN', true, 'Bearer token for /api/media/livekit management APIs. Can fall back to LIVEKIT_MEDIA_API_TOKEN.', env.OPC_MEDIA_API_TOKEN || env.LIVEKIT_MEDIA_API_TOKEN, true),
    item('Media API', 'OPC_MEDIA_INVITE_SECRET', true, 'HMAC secret for signed customer video invite links. Can fall back to LIVEKIT_MEDIA_INVITE_SECRET.', env.OPC_MEDIA_INVITE_SECRET || env.LIVEKIT_MEDIA_INVITE_SECRET, true),
    item('Media API', 'OPC_MEDIA_INVITE_TTL_MS', false, 'Customer invite TTL in milliseconds.', env.OPC_MEDIA_INVITE_TTL_MS || '86400000'),
    item('Media API', 'OPC_MEDIA_SMOKE_TENANT_ID', true, 'Tenant used by media smoke. Can fall back to OPC_TENANT_ID.', env.OPC_MEDIA_SMOKE_TENANT_ID || env.OPC_TENANT_ID),
    item('Media API', 'OPC_MEDIA_SMOKE_ROOM_NAME', false, 'Room name used by media smoke.', env.OPC_MEDIA_SMOKE_ROOM_NAME || 'opc-media-smoke'),
    item('Media API', 'OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT', false, 'Set to 1 to reject dev-token fallback during smoke.', env.OPC_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT || '0'),
    item('Media API', 'OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT', false, 'Set to 1 to poll object readability and download the recording during server smoke.', env.OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT || '0'),
    item('Media API', 'OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS', false, 'Maximum wait for an Egress object to become readable.', env.OPC_MEDIA_SMOKE_RECORDING_OBJECT_TIMEOUT_MS || '60000'),
    item('Media API', 'OPC_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS', false, 'Polling interval while waiting for an Egress object.', env.OPC_MEDIA_SMOKE_RECORDING_OBJECT_POLL_INTERVAL_MS || '2000'),
    item('Egress / Storage', 'OPC_MEDIA_CONFIG_DIR', false, 'Directory where render:media-configs writes livekit.yaml and egress.yaml.', env.OPC_MEDIA_CONFIG_DIR || '.runtime/media'),
    item('Egress / Storage', 'OPC_MEDIA_RECORDING_RETENTION_DAYS', false, 'Default retention period for Media Core recordings (1-3650 days).', env.OPC_MEDIA_RECORDING_RETENTION_DAYS || '90'),
    item('Egress / Storage', 'OPC_RECORDING_HTTP_ALLOWED_ORIGINS', false, 'Comma-separated HTTP origins allowed for production recording reads.', env.OPC_RECORDING_HTTP_ALLOWED_ORIGINS),
    item('Egress / Storage', 'OPC_RECORDING_HTTP_TIMEOUT_MS', false, 'Timeout for controlled HTTP recording reads.', env.OPC_RECORDING_HTTP_TIMEOUT_MS || '15000'),
    item('Egress / Storage', 'MINIO_ENDPOINT', false, 'S3-compatible endpoint used by LiveKit Egress.', env.MINIO_ENDPOINT || 'http://minio:9000'),
    item('Egress / Storage', 'MINIO_BUCKET', false, 'S3 bucket used by LiveKit Egress.', env.MINIO_BUCKET || 'recordings'),
    item('Egress / Storage', 'MINIO_ACCESS_KEY', true, 'S3 access key used by LiveKit Egress.', env.MINIO_ACCESS_KEY, true),
    item('Egress / Storage', 'MINIO_SECRET_KEY', true, 'S3 secret key used by LiveKit Egress.', env.MINIO_SECRET_KEY, true),
    item('Readiness Suite', 'OPC_VIDEO_READINESS_TARGETS', false, 'Comma-separated readiness targets. Empty means the suite default target set.', env.OPC_VIDEO_READINESS_TARGETS || DEFAULT_TARGETS.join(',')),
    item('Readiness Suite', 'OPC_VIDEO_READINESS_CONTINUE_ON_FAILURE', false, 'Set to 1 to collect all target failures before exiting.', env.OPC_VIDEO_READINESS_CONTINUE_ON_FAILURE || '0'),
    item('Readiness Suite', 'OPC_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE', false, 'Optional Markdown output path for this generated checklist.', env.OPC_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE),
    item('Readiness Suite', 'OPC_LIVEKIT_PREFLIGHT_REPORT_FILE', false, 'Optional JSON output path for this preflight report.', env.OPC_LIVEKIT_PREFLIGHT_REPORT_FILE),
    item('Browser Smoke', 'OPC_BROWSER_SMOKE_AGENT_A_TOKEN', targets.includes('agent-browser'), 'Signed agent A browser token.', env.OPC_BROWSER_SMOKE_AGENT_A_TOKEN, true),
    item('Browser Smoke', 'OPC_BROWSER_SMOKE_AGENT_A_USER_ID', targets.includes('agent-browser'), 'Agent A user id.', env.OPC_BROWSER_SMOKE_AGENT_A_USER_ID),
    item('Browser Smoke', 'OPC_BROWSER_SMOKE_AGENT_A_SEAT_ID', targets.includes('agent-browser'), 'Agent A seat id.', env.OPC_BROWSER_SMOKE_AGENT_A_SEAT_ID),
    item('Browser Smoke', 'OPC_BROWSER_SMOKE_AGENT_B_TOKEN', targets.includes('agent-browser'), 'Signed agent B browser token.', env.OPC_BROWSER_SMOKE_AGENT_B_TOKEN, true),
    item('Browser Smoke', 'OPC_BROWSER_SMOKE_AGENT_B_USER_ID', targets.includes('agent-browser'), 'Agent B user id.', env.OPC_BROWSER_SMOKE_AGENT_B_USER_ID),
    item('Browser Smoke', 'OPC_BROWSER_SMOKE_AGENT_B_SEAT_ID', targets.includes('agent-browser'), 'Agent B seat id.', env.OPC_BROWSER_SMOKE_AGENT_B_SEAT_ID),
    item('Browser Smoke', 'OPC_CUSTOMER_VIDEO_URL', targets.includes('customer-browser'), 'Signed customer video URL. Can be replaced by customer-browser smoke room fields.', env.OPC_CUSTOMER_VIDEO_URL || env.OPC_CUSTOMER_BROWSER_SMOKE_URL || env.OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME),
    item('Browser Smoke', 'OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID', targets.includes('customer-browser'), 'Customer browser smoke tenant. Can fall back to OPC_TENANT_ID or signed customer URL.', env.OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID || env.OPC_TENANT_ID || env.OPC_CUSTOMER_VIDEO_URL || env.OPC_CUSTOMER_BROWSER_SMOKE_URL),
    item('Web Assist', 'OPC_WEB_ASSIST_CUSTOMER_URL', webAssistRequired, 'Signed Web Assist customer URL.', env.OPC_WEB_ASSIST_CUSTOMER_URL || env.OPC_REMOTE_ASSIST_CUSTOMER_URL),
    item('Web Assist', 'OPC_WEB_ASSIST_ENGINEER_TOKEN', webAssistRequired, 'Signed engineer token used by Web Assist browser smoke.', env.OPC_WEB_ASSIST_ENGINEER_TOKEN, true),
    item('Web Assist', 'OPC_WEB_ASSIST_ENGINEER_USER_ID', webAssistRequired, 'Engineer user id used by Web Assist browser smoke.', env.OPC_WEB_ASSIST_ENGINEER_USER_ID),
    item('Web Assist', 'OPC_WEB_ASSIST_TENANT_ID', webAssistRequired, 'Web Assist tenant. Can fall back to OPC_TENANT_ID.', env.OPC_WEB_ASSIST_TENANT_ID || env.OPC_TENANT_ID),
    item('SIP / VoLTE', 'LIVEKIT_SIP_BRIDGE_TARGET', sipRequired, 'SIP URI for livekit-sip bridge.', env.LIVEKIT_SIP_BRIDGE_TARGET),
    item('SIP / VoLTE', 'RUSTPBX_LIVEKIT_TRUNK', sipRequired, 'RustPBX trunk name that routes to LiveKit SIP.', env.RUSTPBX_LIVEKIT_TRUNK),
    item('SIP / VoLTE', 'RUSTPBX_RWI_URL', sipRequired, 'RustPBX RWI WebSocket URL.', env.RUSTPBX_RWI_URL),
    item('SIP / VoLTE', 'RUSTPBX_RWI_TOKEN', sipRequired, 'RustPBX RWI token.', env.RUSTPBX_RWI_TOKEN, true)
  ];
}

function item(
  section: string,
  name: string,
  required: boolean,
  description: string,
  value: string | undefined,
  secret = false
): LiveKitDeploymentEnvChecklistItem {
  return {
    section,
    name,
    required,
    secret,
    value: String(value || '').trim(),
    description
  };
}

function displayEnvValue(item: LiveKitDeploymentEnvChecklistItem): string {
  if (!item.value) return 'missing';
  return item.secret ? 'configured' : item.value;
}

function addRequiredValue(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  value: string | undefined,
  failMessage: string
): void {
  const configured = Boolean(String(value || '').trim());
  addCheck(checks, id, configured ? 'pass' : 'fail', configured ? `${id} is configured` : failMessage);
}

function addRequiredSecret(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  value: string | undefined,
  failMessage: string
): void {
  const normalized = String(value || '').trim();
  const configured = Boolean(normalized) && !isPlaceholderSecret(normalized);
  addCheck(
    checks,
    id,
    configured ? 'pass' : 'fail',
    configured ? `${id} is configured` : normalized ? `${id} must replace the example placeholder` : failMessage
  );
}

function addDomainCheck(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  value: string | undefined,
  disallowedValue?: string
): void {
  const normalized = String(value || '').trim().toLowerCase();
  const validDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(normalized);
  const distinct = !disallowedValue || normalized !== String(disallowedValue).trim().toLowerCase();
  const valid = validDomain && distinct;
  addCheck(
    checks,
    id,
    valid ? 'pass' : 'fail',
    valid
      ? `${id} is configured`
      : !normalized
        ? `${id} is required for standalone-vm`
        : !distinct
          ? 'LIVEKIT_TURN_DOMAIN must differ from LIVEKIT_SIGNAL_DOMAIN'
          : `${id} must be a valid DNS domain`
  );
}

function addEmailCheck(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  value: string | undefined
): void {
  const normalized = String(value || '').trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  addCheck(
    checks,
    id,
    valid ? 'pass' : 'fail',
    valid ? `${id} is configured` : normalized ? `${id} must be a valid email address` : `${id} is required for standalone-vm`
  );
}

function isPlaceholderSecret(value: string): boolean {
  return /^(?:replace_with|change_me|your_)/i.test(value) ||
    new Set(['admin', 'devkey', 'minioadmin', 'password', 'secret']).has(value.toLowerCase());
}

function addHttpUrlCheck(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  value: string,
  passMessage: string
): void {
  if (!value) {
    addCheck(checks, id, 'fail', `${id} is required`);
    return;
  }
  addCheck(checks, id, isHttpUrl(value) ? 'pass' : 'fail', isHttpUrl(value) ? passMessage : `${id} must use http(s)`);
}

function addCheck(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  status: LiveKitDeploymentPreflightStatus,
  message: string
): void {
  checks.push({ id, status, message });
}

function addIntegerRangeCheck(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  value: string,
  min: number,
  max: number
): void {
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  addCheck(
    checks,
    id,
    valid ? 'pass' : 'fail',
    valid ? `${id} is ${parsed}` : `${id} must be an integer between ${min} and ${max}`
  );
}

function addPinnedImageTagCheck(
  checks: LiveKitDeploymentPreflightCheck[],
  id: string,
  value: string
): void {
  const valid = /^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value);
  addCheck(
    checks,
    id,
    valid ? 'pass' : 'fail',
    valid ? `${id} is pinned to ${value}` : `${id} must be an exact semantic version tag and cannot use latest`
  );
}

function parseTargets(value: string | undefined): LiveKitReadinessTarget[] {
  const raw = String(value || '').trim();
  if (!raw) return [...DEFAULT_TARGETS];
  const result: LiveKitReadinessTarget[] = [];
  for (const item of raw.split(',')) {
    const target = targetAlias(item.trim().toLowerCase());
    if (!target || result.includes(target)) continue;
    result.push(target);
  }
  return result.length ? result : [...DEFAULT_TARGETS];
}

function targetAlias(value: string): LiveKitReadinessTarget | null {
  if (value === 'media') return 'media';
  if (value === 'avatar') return 'avatar';
  if (value === 'ai-callback' || value === 'callback') return 'ai-callback';
  if (value === 'agent-browser' || value === 'browser') return 'agent-browser';
  if (value === 'customer-browser' || value === 'customer') return 'customer-browser';
  if (value === 'web-assist-browser' || value === 'web-assist' || value === 'remote-assist-browser') return 'web-assist-browser';
  if (value === 'collaboration' || value === 'collab') return 'collaboration';
  if (value === 'remote-gateway' || value === 'gateway') return 'remote-gateway';
  if (value === 'sip-volte' || value === 'sip') return 'sip-volte';
  return null;
}

function isLiveKitUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

function isSecureLiveKitUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'wss:';
  } catch {
    return false;
  }
}

function parseDeploymentMode(value: string | undefined): LiveKitDeploymentMode | null {
  const normalized = String(value || 'bundled-dev').trim().toLowerCase();
  if (normalized === 'external' || normalized === 'standalone-vm' || normalized === 'bundled-dev') {
    return normalized;
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripTrailingSlash(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function main(): Promise<void> {
  const checklistFile = String(process.env.OPC_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE || '').trim();
  const envChecklist = checklistFile ? writeLiveKitDeploymentEnvChecklist(checklistFile, process.env) : undefined;
  const reportFilePath = String(process.env.OPC_LIVEKIT_PREFLIGHT_REPORT_FILE || '').trim();
  const report = createLiveKitDeploymentPreflightReport(process.env);
  const reportFile = reportFilePath
    ? writeLiveKitDeploymentPreflightReport(reportFilePath, process.env, report)
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
