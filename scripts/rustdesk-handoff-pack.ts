import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RustDeskHandoffPackConfig {
  outputFile?: string;
  title: string;
  audience: string;
  controlPlaneBaseUrl: string;
  tokenConfigured: boolean;
  idServer: string;
  relayServer: string;
  tenantId: string;
  targetId: string;
  publicKeySource: string;
  protocolTemplateConfigured: boolean;
  launchBaseUrl: string;
  ledBaseUrl: string;
  ledTenantId: string;
  ledRemoteSessionId: string;
  ledRustDeskId: string;
}

export interface RustDeskHandoffPackWriteResult {
  outputFile: string;
  sections: string[];
}

const HANDOFF_SECTIONS = [
  'configuration',
  'server-validation',
  'event-audit',
  'client-acceptance',
  'final-evidence',
  'led-integration'
];

export function createRustDeskHandoffPackConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskHandoffPackConfig {
  const controlPlaneBaseUrl = stripTrailingSlash(
    env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL ||
    env.OPC_REMOTE_GATEWAY_BASE_URL ||
    env.OPC_BASE_URL ||
    ''
  );
  return {
    outputFile: optionalString(env.OPC_RUSTDESK_HANDOFF_FILE),
    title: optionalString(env.OPC_RUSTDESK_HANDOFF_TITLE) || 'RustDesk Integration Handoff',
    audience: optionalString(env.OPC_RUSTDESK_HANDOFF_AUDIENCE) || 'OPC, LED, deployment, and QA teams',
    controlPlaneBaseUrl,
    tokenConfigured: Boolean(String(env.OPC_RUSTDESK_API_TOKEN || env.OPC_REMOTE_GATEWAY_API_TOKEN || '').trim()),
    idServer: optionalString(env.OPC_RUSTDESK_ID_SERVER) || '',
    relayServer: optionalString(env.OPC_RUSTDESK_RELAY_SERVER) || '',
    tenantId: optionalString(env.OPC_REMOTE_GATEWAY_TENANT_ID || env.OPC_RUSTDESK_EDGE_TENANT_ID || env.OPC_TENANT_ID) || '',
    targetId: optionalString(env.OPC_REMOTE_GATEWAY_TARGET_ID || env.OPC_RUSTDESK_LED_EXAMPLE_DEVICE_ID) || '',
    publicKeySource: publicKeySource(env),
    protocolTemplateConfigured: Boolean(String(env.OPC_RUSTDESK_PROTOCOL_URL_TEMPLATE || '').trim()),
    launchBaseUrl: stripTrailingSlash(
      env.OPC_RUSTDESK_LAUNCH_BASE_URL ||
      env.OPC_BASE_URL ||
      env.OPC_REMOTE_GATEWAY_BASE_URL ||
      controlPlaneBaseUrl
    ),
    ledBaseUrl: stripTrailingSlash(env.OPC_RUSTDESK_LED_EXAMPLE_BASE_URL || env.OPC_BASE_URL || controlPlaneBaseUrl),
    ledTenantId: optionalString(env.OPC_RUSTDESK_LED_EXAMPLE_TENANT_ID || env.OPC_REMOTE_GATEWAY_TENANT_ID || env.OPC_TENANT_ID) || '',
    ledRemoteSessionId: optionalString(env.OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID) || '',
    ledRustDeskId: optionalString(env.OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID || env.OPC_RUSTDESK_IVEKIT_RUSTDESK_ID) || ''
  };
}

export function renderRustDeskHandoffPack(config: RustDeskHandoffPackConfig): string {
  return [
    `# ${config.title}`,
    '',
    `Audience: ${config.audience}`,
    '',
    '## Configuration',
    '',
    `- control-plane base URL: \`${configured(config.controlPlaneBaseUrl)}\``,
    `- control-plane token: \`${config.tokenConfigured ? 'configured' : 'missing'}\``,
    `- public key: \`${config.publicKeySource}\``,
    `- id server: \`${configured(config.idServer)}\``,
    `- relay server: \`${configured(config.relayServer)}\``,
    `- launch base URL: \`${configured(config.launchBaseUrl)}\``,
    `- protocol URL template: \`${config.protocolTemplateConfigured ? 'configured' : 'missing'}\``,
    `- tenant: \`${configured(config.tenantId)}\``,
    `- target: \`${configured(config.targetId)}\``,
    '',
    'Missing items above must be fixed before claiming server readiness. Secret values are intentionally summarized only as configured or missing.',
    '',
    '## Server Validation',
    '',
    'Run these inside the deployed OPC container after env and RustDesk key files are mounted:',
    '',
    '```bash',
    'npm run rustdesk:deployment-preflight',
    'OPC_RUSTDESK_SERVER_EVIDENCE_FILE=/tmp/rustdesk-server-evidence.json npm run rustdesk:server-evidence',
    'npm run rustdesk:readiness',
    '```',
    '',
    'Expected coverage: server evidence proves public key readability, hbbs/hbbr TCP reachability, UDP probe send, DNS, TLS, and Ingress response; readiness then covers client-config, launch page, protocol URL, device online mapping, operation audit probe, ended session behavior, and old launch URL rejection.',
    '',
    '## Event Audit',
    '',
    'Generate a local JSONL template for the sidecar or helper process, then validate the edited file before sending it to OPC:',
    '',
    '```bash',
    'OPC_RUSTDESK_EVENT_TEMPLATE_FILE=/tmp/rustdesk-events-template.jsonl npm run rustdesk:event-forwarder',
    'OPC_RUSTDESK_EVENT_FILE=/tmp/rustdesk-events-template.jsonl OPC_RUSTDESK_EVENT_VALIDATE_ONLY=1 npm run rustdesk:event-forwarder',
    '```',
    '',
    'After real operation capture is wired, the same event file format should be sent without validate-only so control actions, file transfer, recording, and clipboard events enter the RustDesk gateway audit timeline.',
    '',
    '## Client Acceptance',
    '',
    'Create the client configuration handoff and schema-v2 acceptance report template before the real client session, then fill evidence and audit exports after the session:',
    '',
    '```bash',
    'OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE=/tmp/rustdesk-client-config-pack.md OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID=<rustdesk-gateway-external-id> OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID=<rustdesk-runtime-id> npm run rustdesk:client-config-pack',
    'OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE=/tmp/rustdesk-client-acceptance.json npm run rustdesk:client-acceptance',
    'OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE=/tmp/rustdesk-client-acceptance.json OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=/tmp/rustdesk-audit-export.jsonl OPC_RUSTDESK_ACCEPTANCE_OUTPUT_FILE=/tmp/rustdesk-client-acceptance-summary.json npm run rustdesk:client-acceptance',
    '```',
    '',
    '真实客户端验收仍需要人工完成：记录 hbbs/hbbr 和两端客户端版本、平台/架构、target ID、key fingerprint、ID/relay 路径以及不同的 operator/QA 身份；确认屏幕查看、键鼠、多显示器、文件传输、剪贴板、录屏播放、断网重连、授权撤销、物理断开和旧链接失效。',
    '',
    '每个检查必须使用独立 JSON observation，并绑定同一个 run_id、environment_id、deployed_commit、external_id 和 rustdesk_id。controlled E2E、Playwright、mock 或 synthetic 结果不能作为真实终端证据；未提供真实报告时状态必须保持 `not_run`。',
    '',
    '## Final Evidence Pack',
    '',
    'After real client evidence and audit exports are filled, validate audit coverage and regenerate the final customer handoff evidence pack:',
    '',
    '```bash',
    'OPC_RUSTDESK_AUDIT_EXPORT_FILE=/tmp/rustdesk-audit-export.jsonl OPC_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id> npm run rustdesk:audit-export',
    'OPC_RUSTDESK_AUDIT_COVERAGE_FILE=/tmp/rustdesk-audit-export.jsonl OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=/tmp/rustdesk-audit-coverage.json npm run rustdesk:audit-coverage',
    'OPC_RUSTDESK_EVIDENCE_PACK_FILE=/tmp/rustdesk-evidence-pack.md OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE=/tmp/rustdesk-server-evidence.json OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=/tmp/rustdesk-client-config-pack.md OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE=/tmp/rustdesk-audit-coverage.json npm run rustdesk:evidence-pack',
    '```',
    '',
    'Customer handoff requires `rustdesk:evidence-pack` to report `ready_for_customer_review`; otherwise the server/client/audit evidence is still incomplete.',
    '',
    '## LED Integration',
    '',
    'Use the minimal LED handoff script after OPC has a remote_session_id and a target RustDesk device:',
    '',
    '```bash',
    'npm run rustdesk:led-example',
    '```',
    '',
    `- LED base URL: \`${configured(config.ledBaseUrl)}\``,
    `- LED tenant: \`${configured(config.ledTenantId)}\``,
    `- LED remote_session_id: \`${configured(config.ledRemoteSessionId)}\``,
    `- LED RustDesk ID: \`${configured(config.ledRustDeskId)}\``,
    '',
    'The LED example proves API wiring and launch-plan consumption only. It does not prove the RustDesk client was launched or that remote operation quality is acceptable.',
    ''
  ].join('\n');
}

export function writeRustDeskHandoffPack(config: RustDeskHandoffPackConfig): RustDeskHandoffPackWriteResult {
  if (!config.outputFile) throw new Error('OPC_RUSTDESK_HANDOFF_FILE is required when writing a handoff pack');
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, renderRustDeskHandoffPack(config), 'utf8');
  return {
    outputFile: config.outputFile,
    sections: [...HANDOFF_SECTIONS]
  };
}

function publicKeySource(env: NodeJS.ProcessEnv): string {
  if (String(env.OPC_RUSTDESK_PUBLIC_KEY || '').trim()) return 'env';
  const filePath = optionalString(env.OPC_RUSTDESK_PUBLIC_KEY_FILE);
  return filePath ? `file:${filePath}` : 'missing';
}

function configured(value: string): string {
  return value || 'missing';
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

function stripTrailingSlash(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function main(): Promise<void> {
  const config = createRustDeskHandoffPackConfigFromEnv(process.env);
  if (config.outputFile) {
    console.log(JSON.stringify(writeRustDeskHandoffPack(config), null, 2));
    return;
  }
  console.log(renderRustDeskHandoffPack(config));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
