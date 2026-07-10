import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRustDeskClientAcceptanceRunbookConfigFromEnv,
  createRustDeskClientAcceptanceTemplateConfigFromEnv,
  writeRustDeskClientAcceptanceRunbook,
  writeRustDeskClientAcceptanceTemplate
} from './rustdesk-client-acceptance.js';
import { writeRustDeskDeploymentCommands } from './rustdesk-deployment-commands.js';
import {
  writeRustDeskDeploymentEnvChecklist,
  writeRustDeskDeploymentPreflightReport
} from './rustdesk-deployment-preflight.js';
import {
  createRustDeskEventForwarderConfigFromEnv,
  writeRustDeskEventTemplate
} from './rustdesk-event-forwarder.js';
import { writeRustDeskEvidencePack } from './rustdesk-evidence-pack.js';
import {
  createRustDeskHandoffPackConfigFromEnv,
  writeRustDeskHandoffPack
} from './rustdesk-handoff-pack.js';

export interface RustDeskAcceptanceBundleConfig {
  outputDir: string;
  title: string;
}

export interface RustDeskAcceptanceBundleArtifact {
  key: string;
  label: string;
  path: string;
}

export interface RustDeskAcceptanceBundleWriteResult {
  outputDir: string;
  manifestFile: string;
  evidencePackOk: boolean;
  missingRequired: string[];
  artifacts: RustDeskAcceptanceBundleArtifact[];
}

export function createRustDeskAcceptanceBundleConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskAcceptanceBundleConfig {
  const outputDir = String(env.OPC_RUSTDESK_ACCEPTANCE_BUNDLE_DIR || '').trim();
  if (!outputDir) throw new Error('OPC_RUSTDESK_ACCEPTANCE_BUNDLE_DIR is required');
  return {
    outputDir,
    title: String(env.OPC_RUSTDESK_ACCEPTANCE_BUNDLE_TITLE || 'RustDesk Acceptance Bundle').trim()
  };
}

export function writeRustDeskAcceptanceBundle(
  config: RustDeskAcceptanceBundleConfig,
  env: NodeJS.ProcessEnv = process.env
): RustDeskAcceptanceBundleWriteResult {
  mkdirSync(config.outputDir, { recursive: true });

  const paths = {
    deploymentCommands: join(config.outputDir, 'deployment-commands.md'),
    envChecklist: join(config.outputDir, 'env-checklist.md'),
    preflightReport: join(config.outputDir, 'preflight.json'),
    serverEvidence: join(config.outputDir, 'server-evidence.json'),
    readinessReport: join(config.outputDir, 'readiness.json'),
    clientConfigPack: join(config.outputDir, 'client-config-pack.md'),
    auditExport: join(config.outputDir, 'audit-export.jsonl'),
    auditCoverageReport: join(config.outputDir, 'audit-coverage.json'),
    serverReadinessRunbook: join(config.outputDir, 'server-readiness-runbook.md'),
    ledIntegrationQuickstart: join(config.outputDir, 'led-integration-quickstart.md'),
    ledSdkMinimalExample: join(config.outputDir, 'led-sdk-minimal-example.ts'),
    clientAcceptanceTemplate: join(config.outputDir, 'client-acceptance-template.json'),
    clientAcceptanceRunbook: join(config.outputDir, 'client-acceptance-runbook.md'),
    eventTemplate: join(config.outputDir, 'events-template.jsonl'),
    eventForwarderRunbook: join(config.outputDir, 'event-forwarder-runbook.md'),
    handoff: join(config.outputDir, 'handoff.md'),
    evidencePack: join(config.outputDir, 'evidence-pack.md'),
    manifest: join(config.outputDir, 'manifest.json')
  };

  writeRustDeskDeploymentCommands(paths.deploymentCommands, env);
  writeRustDeskDeploymentEnvChecklist(paths.envChecklist, env);
  writeRustDeskDeploymentPreflightReport(paths.preflightReport, env);
  writeFileSync(paths.serverReadinessRunbook, renderRustDeskServerReadinessRunbook(config, paths), 'utf8');
  writeFileSync(paths.ledIntegrationQuickstart, renderRustDeskLedIntegrationQuickstart(config), 'utf8');
  writeFileSync(paths.ledSdkMinimalExample, renderRustDeskLedSdkMinimalExample(), 'utf8');
  writeRustDeskClientAcceptanceTemplate(
    createRustDeskClientAcceptanceTemplateConfigFromEnv({
      ...env,
      OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE: paths.clientAcceptanceTemplate
    })
  );
  writeRustDeskClientAcceptanceRunbook(
    createRustDeskClientAcceptanceRunbookConfigFromEnv({
      ...env,
      OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE: paths.clientAcceptanceRunbook
    })
  );
  writeRustDeskEventTemplate(
    createRustDeskEventForwarderConfigFromEnv({
      ...env,
      OPC_RUSTDESK_EVENT_TEMPLATE_FILE: paths.eventTemplate
    })
  );
  writeFileSync(paths.eventForwarderRunbook, renderRustDeskEventForwarderRunbook(config, paths), 'utf8');
  writeRustDeskHandoffPack({
    ...createRustDeskHandoffPackConfigFromEnv(env),
    outputFile: paths.handoff
  });
  const evidencePack = writeRustDeskEvidencePack({
    outputFile: paths.evidencePack,
    title: config.title,
    artifacts: {
      deploymentCommandsFile: paths.deploymentCommands,
      envChecklistFile: paths.envChecklist,
      preflightReportFile: paths.preflightReport,
      serverEvidenceFile: paths.serverEvidence,
      readinessReportFile: paths.readinessReport,
      clientConfigPackFile: paths.clientConfigPack,
      handoffFile: paths.handoff,
      clientAcceptanceReportFile: paths.clientAcceptanceTemplate,
      clientAcceptanceAuditFile: paths.auditExport,
      auditCoverageReportFile: paths.auditCoverageReport,
      eventTemplateFile: paths.eventTemplate
    }
  });

  const artifacts = [
    artifact('deployment_commands', 'Deployment command runbook', paths.deploymentCommands),
    artifact('env_checklist', 'Deployment environment checklist', paths.envChecklist),
    artifact('preflight_report', 'No-network preflight JSON report', paths.preflightReport),
    artifact('server_readiness_runbook', 'Server readiness execution runbook', paths.serverReadinessRunbook),
    artifact('led_integration_quickstart', 'LED integration quickstart', paths.ledIntegrationQuickstart),
    artifact('led_sdk_minimal_example', 'LED SDK minimal TypeScript example', paths.ledSdkMinimalExample),
    artifact('client_acceptance_template', 'Real-client acceptance report template', paths.clientAcceptanceTemplate),
    artifact('client_acceptance_runbook', 'Real-client operation runbook', paths.clientAcceptanceRunbook),
    artifact('event_template', 'RustDesk operation event JSONL template', paths.eventTemplate),
    artifact('event_forwarder_runbook', 'RustDesk operation event forwarder runbook', paths.eventForwarderRunbook),
    artifact('handoff', 'RustDesk integration handoff', paths.handoff),
    artifact('evidence_pack', 'Evidence pack summary', paths.evidencePack),
    artifact('manifest', 'Acceptance bundle manifest', paths.manifest)
  ];

  writeFileSync(paths.manifest, `${JSON.stringify({
    title: config.title,
    status: 'awaiting_real_environment_evidence',
    output_dir: config.outputDir,
    artifacts: {
      ...Object.fromEntries(artifacts.map((item) => [
        item.key,
        { label: item.label, path: item.path }
      ])),
      readiness_report: {
        label: 'Server readiness JSON report generated after real hbbs/hbbr and OPC deployment checks',
        expected_path: paths.readinessReport,
        command: 'OPC_RUSTDESK_READINESS_REPORT_FILE=<bundle>/readiness.json npm run rustdesk:readiness'
      }
    },
    expected_artifacts: {
      server_evidence: {
        label: 'Server runtime evidence JSON report generated from real hbbs/hbbr, key, ports, DNS, TLS, and Ingress checks',
        expected_path: paths.serverEvidence,
        command: 'OPC_RUSTDESK_SERVER_EVIDENCE_FILE=<bundle>/server-evidence.json npm run rustdesk:server-evidence'
      },
      readiness_report: {
        label: 'Server readiness JSON report generated after real hbbs/hbbr and OPC deployment checks',
        expected_path: paths.readinessReport,
        command: 'OPC_RUSTDESK_READINESS_REPORT_FILE=<bundle>/readiness.json npm run rustdesk:readiness'
      },
      client_config_pack: {
        label: 'RustDesk client install/config handoff pack generated from iveKit client-config and optional launch plan',
        expected_path: paths.clientConfigPack,
        command: 'OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE=<bundle>/client-config-pack.md OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID=<external_id> OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID=<rustdesk_id> npm run rustdesk:client-config-pack'
      },
      real_operation_event_file: {
        label: 'Real RustDesk operation event JSONL captured by the client sidecar or helper process',
        expected_path: paths.eventTemplate,
        command: 'Edit <bundle>/events-template.jsonl with real external_id, target, occurred_at, and operation metadata; validate with event-forwarder-runbook.md before forwarding'
      },
      filled_client_acceptance_report: {
        label: 'Filled copy of client-acceptance-template.json after real RustDesk client operation',
        expected_path: paths.clientAcceptanceTemplate,
        command: 'OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE=<bundle>/client-acceptance-template.json OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=<bundle>/audit-export.jsonl npm run rustdesk:client-acceptance'
      },
      audit_export: {
        label: 'Real RustDesk operation audit export for the same gateway external_id',
        expected_path: paths.auditExport,
        command: 'OPC_RUSTDESK_AUDIT_EXPORT_FILE=<bundle>/audit-export.jsonl OPC_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<external_id> npm run rustdesk:audit-export'
      },
      audit_coverage_report: {
        label: 'RustDesk audit coverage JSON report generated from real operation audit export',
        expected_path: paths.auditCoverageReport,
        command: 'OPC_RUSTDESK_AUDIT_COVERAGE_FILE=<bundle>/audit-export.jsonl OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=<bundle>/audit-coverage.json npm run rustdesk:audit-coverage'
      }
    },
    evidence_pack: {
      ok: evidencePack.ok,
      missing_required: evidencePack.missing_required
    },
    next_steps: [
      'Run deployment-commands.md and server-readiness-runbook.md in the target server environment.',
      'Share led-integration-quickstart.md with LED or other consuming project developers.',
      'Run rustdesk:server-evidence with OPC_RUSTDESK_SERVER_EVIDENCE_FILE pointing at server-evidence.json.',
      'Run rustdesk:readiness with OPC_RUSTDESK_READINESS_REPORT_FILE pointing at readiness.json.',
      'Run rustdesk:client-config-pack with OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE pointing at client-config-pack.md before client setup.',
      'Perform real RustDesk client screen, keyboard/mouse, file, clipboard, recording, revoke, and old-link checks.',
      'Use event-forwarder-runbook.md to validate and forward real operation events from the RustDesk client sidecar or helper process.',
      'Fill client-acceptance-template.json with real evidence and export the same gateway audit to audit-export.jsonl.',
      'Run rustdesk:audit-coverage against audit-export.jsonl.',
      'Regenerate evidence-pack.md and require ready_for_customer_review before customer handoff.'
    ]
  }, null, 2)}\n`, 'utf8');

  return {
    outputDir: config.outputDir,
    manifestFile: paths.manifest,
    evidencePackOk: evidencePack.ok,
    missingRequired: evidencePack.missing_required,
    artifacts
  };
}

function artifact(key: string, label: string, path: string): RustDeskAcceptanceBundleArtifact {
  return { key, label, path };
}

function renderRustDeskServerReadinessRunbook(
  config: RustDeskAcceptanceBundleConfig,
  paths: {
    deploymentCommands: string;
    envChecklist: string;
    preflightReport: string;
    serverEvidence: string;
    readinessReport: string;
    clientConfigPack: string;
    auditExport: string;
    auditCoverageReport: string;
    clientAcceptanceTemplate: string;
    clientAcceptanceRunbook: string;
    eventTemplate: string;
    handoff: string;
    evidencePack: string;
  }
): string {
  return [
    '# RustDesk Server Readiness Runbook',
    '',
    `Bundle: \`${config.outputDir}\``,
    `Title: ${config.title}`,
    '',
    'Run these commands inside the deployed OPC container, after hbbs/hbbr are started and RustDesk env/key mounts are present. This runbook records evidence paths; it does not prove the real environment passed until every command and client operation succeeds.',
    '',
    '## 1. Write Local Artifacts',
    '',
    '```bash',
    `OPC_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE=${paths.envChecklist} \\`,
    `OPC_RUSTDESK_PREFLIGHT_REPORT_FILE=${paths.preflightReport} \\`,
    'npm run rustdesk:deployment-preflight',
    '```',
    '',
    'Expected result: preflight exits 0, env checklist is updated, `preflight.json` is ok, and no secret values are printed.',
    '',
    '## 2. Collect Server Runtime Evidence',
    '',
    '```bash',
    `OPC_RUSTDESK_SERVER_EVIDENCE_FILE=${paths.serverEvidence} \\`,
    'npm run rustdesk:server-evidence',
    '```',
    '',
    'Expected result: `server-evidence.json` is ok and proves the RustDesk public key file is readable, hbbs/hbbr TCP ports are reachable, UDP probes are sent, and the public launch host resolves with a valid TLS/Ingress response. UDP send success still does not prove RustDesk protocol handshake.',
    '',
    '## 3. Run Server Readiness',
    '',
    '```bash',
    `OPC_RUSTDESK_READINESS_REPORT_FILE=${paths.readinessReport} \\`,
    'npm run rustdesk:readiness',
    '```',
    '',
    'Expected result: hbbs/hbbr TCP/UDP checks, device online mapping, client-config, launch plan, public launch page, protocol URL, operation audit, ended session behavior, and old-link rejection all pass.',
    '',
    '## 4. Generate Client Config Pack',
    '',
    '```bash',
    `OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE=${paths.clientConfigPack} \\`,
    'OPC_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID=<rustdesk-gateway-external-id> \\',
    'OPC_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID=<rustdesk-runtime-id> \\',
    'npm run rustdesk:client-config-pack',
    '```',
    '',
    'Expected result: `client-config-pack.md` contains the ID server, relay server, optional API server, public key, fingerprint, and current launch/protocol URL fields needed by the real RustDesk clients. This is setup guidance only, not remote-control proof.',
    '',
    '## 5. Run LED/iveKit Facade Smoke',
    '',
    '```bash',
    'npm run rustdesk:ivekit-smoke',
    '```',
    '',
    'Expected result: LED-facing facade can create/launch/end RustDesk sessions and write representative audit events.',
    '',
    '## 6. Prepare Real Client Evidence',
    '',
    '```bash',
    `OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE=${paths.clientAcceptanceRunbook} \\`,
    'npm run rustdesk:client-acceptance',
    '',
    `OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE=${paths.clientAcceptanceTemplate} \\`,
    'npm run rustdesk:client-acceptance',
    '```',
    '',
    'Then follow `client-acceptance-runbook.md` on the real agent and target devices. Fill `client-acceptance-template.json` with concrete evidence for screen view, keyboard/mouse, file transfer, clipboard, recording, authorization revoke, old launch URL 409, and audit timeline visibility.',
    '',
    '## 7. Validate Real Client Evidence',
    '',
    '```bash',
    `OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE=${paths.clientAcceptanceTemplate} \\`,
    `OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=${paths.auditExport} \\`,
    'npm run rustdesk:client-acceptance',
    '```',
    '',
    'Expected result: the report passes only after real client operation evidence and audit events are filled.',
    '',
    '## 8. Validate Audit Coverage',
    '',
    `Export the real RustDesk operation audit for the same \`external_id\` to \`${paths.auditExport}\`. The export command reuses \`OPC_RUSTDESK_IVEKIT_BASE_URL\`, \`OPC_BASE_URL\`, \`OPC_COLLABORATION_API_KEY\`, and tenant fallbacks when focused audit-export env is not set.`,
    '',
    '```bash',
    `OPC_RUSTDESK_AUDIT_EXPORT_FILE=${paths.auditExport} \\`,
    'OPC_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id> \\',
    'npm run rustdesk:audit-export',
    '```',
    '',
    'Then run:',
    '',
    '```bash',
    `OPC_RUSTDESK_AUDIT_COVERAGE_FILE=${paths.auditExport} \\`,
    'OPC_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID=<rustdesk-gateway-external-id> \\',
    `OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=${paths.auditCoverageReport} \\`,
    'npm run rustdesk:audit-coverage',
    '```',
    '',
    'Expected result: control action, file transfer started/completed, recording started/stopped, clipboard synced, and session ended events are all present with valid metadata granularity.',
    '',
    '## 9. Regenerate Final Evidence Pack',
    '',
    '```bash',
    `OPC_RUSTDESK_EVIDENCE_PACK_FILE=${paths.evidencePack} \\`,
    `OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE=${paths.deploymentCommands} \\`,
    `OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE=${paths.envChecklist} \\`,
    `OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE=${paths.preflightReport} \\`,
    `OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE=${paths.serverEvidence} \\`,
    `OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE=${paths.readinessReport} \\`,
    `OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=${paths.clientConfigPack} \\`,
    `OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE=${paths.clientAcceptanceTemplate} \\`,
    `OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_AUDIT_FILE=${paths.auditExport} \\`,
    `OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE=${paths.auditCoverageReport} \\`,
    `OPC_RUSTDESK_EVIDENCE_EVENT_TEMPLATE_FILE=${paths.eventTemplate} \\`,
    `OPC_RUSTDESK_EVIDENCE_HANDOFF_FILE=${paths.handoff} \\`,
    'npm run rustdesk:evidence-pack',
    '```',
    '',
    'Customer handoff requires the evidence pack status to be `ready_for_customer_review`. If it remains `incomplete`, do not claim customer-environment completion.',
    ''
  ].join('\n');
}

function renderRustDeskEventForwarderRunbook(
  config: RustDeskAcceptanceBundleConfig,
  paths: {
    eventTemplate: string;
    auditExport: string;
    auditCoverageReport: string;
  }
): string {
  const deadLetterFile = join(config.outputDir, 'event-forwarder-dead-letter.jsonl');
  const remainingFile = join(config.outputDir, 'event-forwarder-remaining.jsonl');
  return [
    '# RustDesk Operation Event Forwarder Runbook',
    '',
    `Bundle: \`${config.outputDir}\``,
    `Title: ${config.title}`,
    '',
    'This runbook is for the RustDesk client sidecar, file-transfer helper, recording helper, clipboard helper, or other process that captures real operation events. It fixes the local validation and forwarding steps; it does not prove real RustDesk client operation until the events come from actual screen, keyboard/mouse, file, clipboard, and recording actions.',
    '',
    '## 1. Generate Or Refresh The Template',
    '',
    '```bash',
    `OPC_RUSTDESK_EVENT_TEMPLATE_FILE=${paths.eventTemplate} \\`,
    'OPC_RUSTDESK_EVENT_EXTERNAL_ID=<rustdesk-gateway-external-id> \\',
    'OPC_RUSTDESK_EVENT_ACTOR_IDENTITY=<operator-or-sidecar-id> \\',
    'OPC_RUSTDESK_EVENT_TEMPLATE_TARGET=<rustdesk-runtime-id> \\',
    'npm run rustdesk:event-forwarder',
    '```',
    '',
    'Expected result: `events-template.jsonl` contains representative control action, file transfer started/completed, recording started/stopped, and clipboard synced events. Replace sample operation ids and metadata with real captured values before forwarding.',
    '',
    '## 2. Validate The Edited Event File Locally',
    '',
    '```bash',
    `OPC_RUSTDESK_EVENT_FILE=${paths.eventTemplate} \\`,
    'OPC_RUSTDESK_EVENT_VALIDATE_ONLY=1 \\',
    'npm run rustdesk:event-forwarder',
    '```',
    '',
    'Expected result: validate-only exits 0. It must fail if metadata is not an object, required operation ids are missing, clipboard/file directions are invalid, or recording evidence type is not `screen_recording`.',
    '',
    '## 3. Forward Real Operation Events',
    '',
    '```bash',
    `OPC_RUSTDESK_EVENT_FILE=${paths.eventTemplate} \\`,
    `OPC_RUSTDESK_EVENT_DEAD_LETTER_FILE=${deadLetterFile} \\`,
    'OPC_RUSTDESK_EVENT_RETRY_ATTEMPTS=2 \\',
    'OPC_RUSTDESK_EVENT_RETRY_DELAY_MS=1000 \\',
    'npm run rustdesk:event-forwarder',
    '```',
    '',
    'Expected result: each valid event is posted to the RustDesk control-plane `/events` endpoint. Transient 408/429/5xx failures are retried; 400/401/403/404 style configuration or contract failures fail fast. If dead-letter is written, keep this file for replay and root-cause review.',
    '',
    '## 4. Replay Failed Events',
    '',
    '```bash',
    `OPC_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE=${deadLetterFile} \\`,
    `OPC_RUSTDESK_EVENT_REPLAY_REMAINING_FILE=${remainingFile} \\`,
    'npm run rustdesk:event-forwarder',
    '```',
    '',
    'Expected result: successfully replayed events do not enter the remaining file. Remaining events retain attempts, latest error detail, and the explicit or derived idempotency key.',
    '',
    '## 5. Export And Check Audit Coverage',
    '',
    '```bash',
    `OPC_RUSTDESK_AUDIT_EXPORT_FILE=${paths.auditExport} \\`,
    'OPC_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id> \\',
    'npm run rustdesk:audit-export',
    '',
    `OPC_RUSTDESK_AUDIT_COVERAGE_FILE=${paths.auditExport} \\`,
    'OPC_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID=<rustdesk-gateway-external-id> \\',
    `OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=${paths.auditCoverageReport} \\`,
    'npm run rustdesk:audit-coverage',
    '```',
    '',
    'Expected result: audit coverage passes for control action, file transfer started/completed, recording started/stopped, clipboard synced, and session ended. If coverage fails, do not claim the real audit chain is ready.',
    '',
    '## Boundary',
    '',
    'This runbook validates event file shape, forwarding, retry/dead-letter handling, replay, export, and audit coverage. It does not prove real RustDesk client operation; the real client acceptance report must still contain concrete screen view, keyboard/mouse, file transfer, clipboard, recording, revoke, and old-link evidence.',
    ''
  ].join('\n');
}

function renderRustDeskLedIntegrationQuickstart(config: RustDeskAcceptanceBundleConfig): string {
  return [
    '# RustDesk LED Integration Quickstart',
    '',
    `Bundle: \`${config.outputDir}\``,
    `Title: ${config.title}`,
    '',
    'This file is for LED or another consuming service that wants to reuse the iveKit RustDesk capability. It documents the supported SDK and HTTP sequence. It does not prove real RustDesk client control; the customer environment still needs the server readiness runbook and real client acceptance evidence.',
    '',
    '## Preconditions',
    '',
    '- `rustdesk:deployment-preflight`, `rustdesk:readiness`, and `rustdesk:ivekit-smoke` should pass in the OPC server environment.',
    '- The RustDesk target device must be registered or registerable through a RustDesk runtime ID.',
    '- The consuming service must have an OPC/iveKit base URL, API key, tenant ID, remote business session ID, actor identity, and requested remote permissions.',
    '- The agent UI should open `launch.openUrl`; native clients can prefer `launch.protocolUrl` when the RustDesk protocol handler is installed.',
    '',
    '## Recommended SDK Path',
    '',
    'A standalone copyable example is generated as `led-sdk-minimal-example.ts` in this bundle.',
    '',
    '```typescript',
    "import { createIveKitRustDeskLedSdk } from './src/agent-runtime/ivekit/index.js';",
    '',
    'const sdk = createIveKitRustDeskLedSdk({',
    '  baseUrl: process.env.OPC_BASE_URL,',
    '  apiKey: process.env.OPC_COLLABORATION_API_KEY,',
    '  tenantId: process.env.OPC_REMOTE_GATEWAY_TENANT_ID,',
    "  userId: 'led-service'",
    '});',
    '',
    'const session = await sdk.startSession({',
    '  remoteSessionId: process.env.OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID!,',
    '  rustdeskId: process.env.OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID!,',
    '  businessRef: {',
    '    type: process.env.OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_TYPE || \"service_order\",',
    '    id: process.env.OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_ID!',
    '  },',
    '  deviceDisplayName: process.env.OPC_RUSTDESK_LED_EXAMPLE_DEVICE_DISPLAY_NAME || \"LED control PC\",',
    '  actorIdentity: process.env.OPC_RUSTDESK_LED_EXAMPLE_ACTOR_IDENTITY || \"agent_led\",',
    "  permissions: ['view_screen', 'control_mouse_keyboard']",
    '});',
    '',
    'console.log(session.launch.openUrl);',
    'console.log(session.launch.protocolUrl);',
    '',
    'await sdk.recordControlAction(session.gatewaySession.external_id, {',
    "  actorIdentity: 'agent_led',",
    '  target: session.device.rustdesk_id,',
    "  operationId: `led-${session.gatewaySession.external_id}-mouse-click`,",
    "  action: 'mouse.click',",
    "  permission: 'control_mouse_keyboard',",
    "  idempotencyKey: `led:${session.gatewaySession.external_id}:control-action`",
    '});',
    '',
    'await sdk.recordFileTransfer(session.gatewaySession.external_id, {',
    "  actorIdentity: 'agent_led',",
    '  target: session.device.rustdesk_id,',
    "  transferId: `led-${session.gatewaySession.external_id}-file-1`,",
    "  status: 'completed',",
    "  direction: 'upload',",
    "  fileName: 'diagnostic.txt'",
    '});',
    '',
    'await sdk.recordScreenRecording(session.gatewaySession.external_id, {',
    "  actorIdentity: 'agent_led',",
    '  target: session.device.rustdesk_id,',
    "  recordingId: `led-${session.gatewaySession.external_id}-recording-1`,",
    "  status: 'stopped',",
    "  storageUrl: 's3://replace-with-real-recording-object'",
    '});',
    '',
    'await sdk.recordClipboardSync(session.gatewaySession.external_id, {',
    "  actorIdentity: 'agent_led',",
    '  target: session.device.rustdesk_id,',
    "  clipboardId: `led-${session.gatewaySession.external_id}-clipboard-1`,",
    "  direction: 'agent_to_device',",
    "  contentKind: 'text'",
    '});',
    '',
    'const audit = await sdk.listGatewayAuditEvents(session.gatewaySession.external_id);',
    'await sdk.endGatewaySession(session.gatewaySession.external_id, { actor_identity: \"agent_led\" });',
    '```',
    '',
    '## Equivalent HTTP Sequence',
    '',
    'Use headers `x-api-key`, `x-tenant-id`, and optional `x-user-id` on every request.',
    '',
    '1. `GET /api/ivekit/rustdesk/client-config`',
    '2. `GET /api/ivekit/rustdesk/devices/by-ref?business_ref_type=...&business_ref_id=...`',
    '3. If no active device matches, `POST /api/ivekit/rustdesk/devices` with `business_ref`, `rustdesk_id`, and `display_name`.',
    '4. `POST /api/ivekit/rustdesk/devices/:device_id/heartbeat` with `runtime_status=online`.',
    '5. `POST /api/ivekit/rustdesk/gateway-sessions` with `remote_session_id`, `device_id`, `actor_identity`, and `permissions`.',
    '6. `GET /api/ivekit/rustdesk/gateway-sessions/:external_id/launch` and open the returned launch URL or protocol URL.',
    '7. `POST /api/ivekit/rustdesk/gateway-sessions/:external_id/events` for operation audit events such as `remote.rustdesk.control_action.performed`.',
    '8. `GET /api/ivekit/rustdesk/gateway-sessions/:external_id/audit` for timeline display or evidence export.',
    '9. `DELETE /api/ivekit/rustdesk/gateway-sessions/:external_id` when the LED workflow revokes authorization or finishes.',
    '',
    'The SDK helpers map to the same HTTP event contract: `recordControlAction()` writes `remote.rustdesk.control_action.performed` with `metadata.operation_id/action/permission`; `recordFileTransfer()` writes file transfer started/completed/failed events; `recordScreenRecording()` writes recording started/stopped/failed events with `evidence_type=screen_recording`; `recordClipboardSync()` writes clipboard sync events with a fixed direction value.',
    '',
    '## Runnable Example',
    '',
    '```bash',
    'OPC_RUSTDESK_LED_EXAMPLE_BASE_URL=https://opc.example.com \\',
    'OPC_RUSTDESK_LED_EXAMPLE_API_KEY=<api-key> \\',
    'OPC_RUSTDESK_LED_EXAMPLE_TENANT_ID=tenant_led \\',
    'OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID=<led-session-id> \\',
    'OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID=<target-rustdesk-id> \\',
    'OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_TYPE=service_order \\',
    'OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_ID=<order-id> \\',
    'OPC_RUSTDESK_LED_EXAMPLE_PERMISSIONS=view_screen,control_mouse_keyboard \\',
    'npm run rustdesk:led-example',
    '```',
    '',
    'The example should return `deviceId`, `externalId`, `launchUrl`, `protocolUrl`, and client config status. Keep `OPC_RUSTDESK_LED_EXAMPLE_END_SESSION=0` while a human validates the launch flow; set it to `1` only for service-side cleanup checks.',
    '',
    '## Required Real Evidence',
    '',
    '- Real RustDesk client opens from the returned launch URL or protocol URL.',
    '- The target RustDesk ID, ID server, relay server, public key, and server key fingerprint match the server readiness output.',
    '- Screen view, keyboard/mouse, file transfer, clipboard, recording, authorization revoke, old launch URL 409, and audit timeline are filled in `client-acceptance-template.json`.',
    '- Final handoff is allowed only after `evidence-pack.md` reports `ready_for_customer_review`.',
    ''
  ].join('\n');
}

function renderRustDeskLedSdkMinimalExample(): string {
  return [
    "// Adjust this import to the extracted iveKit package path used by your service.",
    "import { createIveKitRustDeskLedSdk } from './src/agent-runtime/ivekit/index.js';",
    '',
    'function requiredEnv(name: string): string {',
    '  const value = process.env[name]?.trim();',
    '  if (!value) throw new Error(`${name} is required`);',
    '  return value;',
    '}',
    '',
    'const actorIdentity = process.env.OPC_RUSTDESK_LED_EXAMPLE_ACTOR_IDENTITY || "led-service";',
    '',
    'const sdk = createIveKitRustDeskLedSdk({',
    '  baseUrl: requiredEnv("OPC_BASE_URL"),',
    '  apiKey: requiredEnv("OPC_COLLABORATION_API_KEY"),',
    '  tenantId: requiredEnv("OPC_REMOTE_GATEWAY_TENANT_ID"),',
    '  userId: actorIdentity',
    '});',
    '',
    'const session = await sdk.startSession({',
    '  remoteSessionId: requiredEnv("OPC_RUSTDESK_LED_EXAMPLE_REMOTE_SESSION_ID"),',
    '  rustdeskId: requiredEnv("OPC_RUSTDESK_LED_EXAMPLE_RUSTDESK_ID"),',
    '  businessRef: {',
    '    type: process.env.OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_TYPE || "service_order",',
    '    id: requiredEnv("OPC_RUSTDESK_LED_EXAMPLE_BUSINESS_REF_ID")',
    '  },',
    '  deviceDisplayName: process.env.OPC_RUSTDESK_LED_EXAMPLE_DEVICE_DISPLAY_NAME || "LED control PC",',
    '  actorIdentity,',
    '  permissions: ["view_screen", "control_mouse_keyboard"],',
    '  metadata: { source: "led-sdk-minimal-example" }',
    '});',
    '',
    'console.log(JSON.stringify({',
    '  externalId: session.gatewaySession.external_id,',
    '  deviceId: session.device.id,',
    '  rustdeskId: session.device.rustdesk_id,',
    '  launchUrl: session.launch.openUrl,',
    '  protocolUrl: session.launch.protocolUrl',
    '}, null, 2));',
    '',
    'await sdk.recordControlAction(session.gatewaySession.external_id, {',
    '  actorIdentity,',
    '  target: session.device.rustdesk_id,',
    '  operationId: `led-${session.gatewaySession.external_id}-mouse-click`,',
    '  action: "mouse.click",',
    '  permission: "control_mouse_keyboard",',
    '  idempotencyKey: `led:${session.gatewaySession.external_id}:control-action`,',
    '  metadata: { source: "led-sdk-minimal-example" }',
    '});',
    '',
    'const audit = await sdk.listGatewayAuditEvents(session.gatewaySession.external_id);',
    'console.log(`audit events: ${audit.length}`);',
    '',
    'if (process.env.OPC_RUSTDESK_LED_EXAMPLE_END_SESSION === "1") {',
    '  await sdk.endGatewaySession(session.gatewaySession.external_id, { actor_identity: actorIdentity });',
    '}',
    ''
  ].join('\n');
}

async function main(): Promise<void> {
  const result = writeRustDeskAcceptanceBundle(createRustDeskAcceptanceBundleConfigFromEnv(process.env), process.env);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
