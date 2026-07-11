import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderLiveKitClientAcceptanceRunbook,
  writeLiveKitClientAcceptanceTemplate,
  type LiveKitAcceptanceDeploymentMode
} from './livekit-client-acceptance.js';
import {
  createLiveKitAcceptanceMetadata,
  liveKitAcceptanceMetadataEnv,
  type LiveKitAcceptanceMetadata
} from './livekit-acceptance-metadata.js';
import {
  createLiveKitDeploymentPreflightReport,
  writeLiveKitDeploymentEnvChecklist,
  writeLiveKitDeploymentPreflightReport
} from './livekit-deployment-preflight.js';
import { writeLiveKitEvidencePack } from './livekit-evidence-pack.js';

export interface LiveKitAcceptanceBundleConfig {
  outputDir: string;
  title: string;
  env: NodeJS.ProcessEnv;
}

export interface LiveKitAcceptanceBundleWriteResult {
  outputDir: string;
  manifestFile: string;
  status: 'awaiting_real_environment_evidence';
  evidencePackOk: boolean;
}

export function createLiveKitAcceptanceBundleConfigFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitAcceptanceBundleConfig {
  const outputDir = String(env.OPC_LIVEKIT_ACCEPTANCE_BUNDLE_DIR || '').trim();
  if (!outputDir) throw new Error('OPC_LIVEKIT_ACCEPTANCE_BUNDLE_DIR is required');
  return {
    outputDir,
    title: String(env.OPC_LIVEKIT_ACCEPTANCE_BUNDLE_TITLE || 'LiveKit Acceptance Bundle').trim(),
    env
  };
}

export function writeLiveKitAcceptanceBundle(
  config: LiveKitAcceptanceBundleConfig
): LiveKitAcceptanceBundleWriteResult {
  mkdirSync(config.outputDir, { recursive: true });
  const paths = bundlePaths(config.outputDir);
  refuseExistingRealEvidence(paths);
  const coreMode = optional(config.env.OPC_LIVEKIT_DEPLOYMENT_MODE);
  const acceptanceModeValue = optional(config.env.OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE);
  if (coreMode && acceptanceModeValue && coreMode !== acceptanceModeValue) {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE must match OPC_LIVEKIT_DEPLOYMENT_MODE');
  }
  const mode = acceptanceMode(coreMode);
  const canonicalEnv: NodeJS.ProcessEnv = {
    ...config.env,
    OPC_LIVEKIT_DEPLOYMENT_MODE: mode,
    OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE: mode
  };
  const metadata = createLiveKitAcceptanceMetadata(canonicalEnv, { generateRunId: true });
  const env: NodeJS.ProcessEnv = { ...canonicalEnv, ...liveKitAcceptanceMetadataEnv(metadata) };
  const preflight = createLiveKitDeploymentPreflightReport(env);

  writeLiveKitDeploymentEnvChecklist(paths.envChecklist, env);
  writeLiveKitDeploymentPreflightReport(paths.preflight, env, preflight);
  writeFileSync(paths.serverRunbook, renderServerRunbook(config, paths, metadata), 'utf8');
  writeFileSync(paths.clientRunbook, renderLiveKitClientAcceptanceRunbook(), 'utf8');
  writeLiveKitClientAcceptanceTemplate({
    templateFile: paths.clientTemplate,
    environmentId: metadata.environment_id,
    deploymentMode: mode,
    deployedCommit: metadata.deployed_commit,
    operator: optional(config.env.OPC_LIVEKIT_ACCEPTANCE_OPERATOR) || 'replace-with-operator',
    checkedAt: optional(config.env.OPC_LIVEKIT_ACCEPTANCE_CHECKED_AT),
    runId: metadata.run_id,
    deploymentFingerprint: metadata.deployment_fingerprint,
    runStartedAt: metadata.started_at
  });

  const evidencePack = writeLiveKitEvidencePack({
    outputFile: paths.evidencePack,
    title: config.title,
    expectedAcceptance: metadata,
    expectedDeploymentMode: mode,
    qaPublicKeyFile: optional(env.OPC_LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FILE),
    qaPublicKeyFingerprint: optional(env.OPC_LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FINGERPRINT),
    artifacts: {
      envChecklistFile: paths.envChecklist,
      preflightReportFile: paths.preflight,
      serverEvidenceFile: paths.serverEvidence,
      readinessReportFile: paths.readiness,
      clientAcceptanceReportFile: paths.clientTemplate,
      clientAcceptanceResultFile: paths.clientResult,
      serverRunbookFile: paths.serverRunbook,
      clientRunbookFile: paths.clientRunbook
    }
  });

  const commands = {
    deployment_preflight: `${metadataCommand(metadata)} ${assignment('OPC_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE', paths.envChecklist)} ${assignment('OPC_LIVEKIT_PREFLIGHT_REPORT_FILE', paths.preflight)} npm run livekit:deployment-preflight`,
    server_evidence: `${metadataCommand(metadata)} ${assignment('OPC_LIVEKIT_SERVER_EVIDENCE_FILE', paths.serverEvidence)} npm run livekit:server-evidence`,
    readiness: `${metadataCommand(metadata)} ${assignment('OPC_VIDEO_READINESS_REPORT_FILE', paths.readiness)} npm run smoke:media:readiness`,
    client_acceptance: `${metadataCommand(metadata)} ${qaKeyCommand(env)} ${clientInputAssignments(paths)} ${assignment('OPC_LIVEKIT_ACCEPTANCE_REPORT_FILE', paths.clientTemplate)} ${assignment('OPC_LIVEKIT_ACCEPTANCE_OUTPUT_FILE', paths.clientResult)} npm run livekit:client-acceptance`,
    evidence_pack: evidencePackCommand(paths, metadata, env)
  };
  writeFileSync(paths.manifest, `${JSON.stringify({
    schema_version: 1,
    title: config.title,
    status: 'awaiting_real_environment_evidence',
    acceptance: metadata,
    output_dir: config.outputDir,
    preflight: {
      ok: preflight.ok,
      report: paths.preflight
    },
    generated_artifacts: {
      env_checklist: paths.envChecklist,
      preflight_report: paths.preflight,
      server_runbook: paths.serverRunbook,
      client_acceptance_runbook: paths.clientRunbook,
      client_acceptance_template: paths.clientTemplate,
      evidence_pack: paths.evidencePack
    },
    expected_real_environment_artifacts: {
      server_evidence: paths.serverEvidence,
      readiness: paths.readiness,
      client_acceptance_result: paths.clientResult
    },
    commands,
    evidence_pack: {
      ok: evidencePack.ok,
      status: evidencePack.status,
      missing_required: evidencePack.missing_required
    },
    completion_rule: 'Regenerate the evidence pack and require ready_for_customer_review after every real-environment artifact passes.'
  }, null, 2)}\n`, 'utf8');

  return {
    outputDir: config.outputDir,
    manifestFile: paths.manifest,
    status: 'awaiting_real_environment_evidence',
    evidencePackOk: evidencePack.ok
  };
}

interface BundlePaths {
  envChecklist: string;
  preflight: string;
  serverRunbook: string;
  clientRunbook: string;
  clientTemplate: string;
  serverEvidence: string;
  readiness: string;
  clientResult: string;
  evidencePack: string;
  manifest: string;
}

function bundlePaths(outputDir: string): BundlePaths {
  return {
    envChecklist: join(outputDir, 'env-checklist.md'),
    preflight: join(outputDir, 'preflight.json'),
    serverRunbook: join(outputDir, 'server-runbook.md'),
    clientRunbook: join(outputDir, 'client-acceptance-runbook.md'),
    clientTemplate: join(outputDir, 'client-acceptance-template.json'),
    serverEvidence: join(outputDir, 'server-evidence.json'),
    readiness: join(outputDir, 'readiness.json'),
    clientResult: join(outputDir, 'client-acceptance-result.json'),
    evidencePack: join(outputDir, 'evidence-pack.md'),
    manifest: join(outputDir, 'manifest.json')
  };
}

function acceptanceMode(value: string | undefined): LiveKitAcceptanceDeploymentMode {
  const normalized = String(value || '').trim();
  if (normalized !== 'standalone-vm' && normalized !== 'external') {
    throw new Error('OPC_LIVEKIT_ACCEPTANCE_DEPLOYMENT_MODE must be standalone-vm or external');
  }
  return normalized;
}

function renderServerRunbook(
  config: LiveKitAcceptanceBundleConfig,
  paths: BundlePaths,
  metadata: LiveKitAcceptanceMetadata
): string {
  return [
    '# LiveKit Server Evidence Runbook',
    '',
    `Title: ${config.title}`,
    `Bundle: \`${config.outputDir}\``,
    '',
    'This runbook collects evidence from the deployed server. Generated templates and UDP send-only probes are not proof of real media connectivity.',
    '',
    '## 1. Deployment Preflight',
    '',
    '```bash',
    `${metadataCommand(metadata)} ${assignment('OPC_LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE', paths.envChecklist)} ${assignment('OPC_LIVEKIT_PREFLIGHT_REPORT_FILE', paths.preflight)} npm run livekit:deployment-preflight`,
    '```',
    '',
    '## 2. Server Runtime Evidence',
    '',
    '```bash',
    `${metadataCommand(metadata)} ${assignment('OPC_LIVEKIT_SERVER_EVIDENCE_FILE', paths.serverEvidence)} npm run livekit:server-evidence`,
    '```',
    '',
    '## 3. Full Media Readiness',
    '',
    '```bash',
    `${metadataCommand(metadata)} ${assignment('OPC_VIDEO_READINESS_REPORT_FILE', paths.readiness)} npm run smoke:media:readiness`,
    '```',
    '',
    '## 4. Real Client Acceptance',
    '',
    `Follow \`${paths.clientRunbook}\`, replace every template description with concrete real-environment evidence, then run:`,
    '',
    '```bash',
    `${metadataCommand(metadata)} ${qaKeyCommand(config.env)} ${clientInputAssignments(paths)} ${assignment('OPC_LIVEKIT_ACCEPTANCE_REPORT_FILE', paths.clientTemplate)} ${assignment('OPC_LIVEKIT_ACCEPTANCE_OUTPUT_FILE', paths.clientResult)} npm run livekit:client-acceptance`,
    '```',
    '',
    '## 5. Final Evidence Pack',
    '',
    '```bash',
    evidencePackCommand(paths, metadata, config.env),
    '```',
    '',
    'The final status must be `ready_for_customer_review`. An `incomplete` result means evidence is missing, invalid or failed.',
    ''
  ].join('\n');
}

function evidencePackCommand(
  paths: BundlePaths,
  metadata: LiveKitAcceptanceMetadata,
  env: NodeJS.ProcessEnv
): string {
  return [
    metadataCommand(metadata),
    qaKeyCommand(env),
    assignment('OPC_LIVEKIT_EVIDENCE_PACK_FILE', paths.evidencePack),
    assignment('OPC_LIVEKIT_EVIDENCE_ENV_CHECKLIST_FILE', paths.envChecklist),
    assignment('OPC_LIVEKIT_EVIDENCE_PREFLIGHT_REPORT_FILE', paths.preflight),
    assignment('OPC_LIVEKIT_EVIDENCE_SERVER_EVIDENCE_FILE', paths.serverEvidence),
    assignment('OPC_LIVEKIT_EVIDENCE_READINESS_REPORT_FILE', paths.readiness),
    assignment('OPC_LIVEKIT_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE', paths.clientTemplate),
    assignment('OPC_LIVEKIT_EVIDENCE_CLIENT_ACCEPTANCE_RESULT_FILE', paths.clientResult),
    assignment('OPC_LIVEKIT_EVIDENCE_SERVER_RUNBOOK_FILE', paths.serverRunbook),
    assignment('OPC_LIVEKIT_EVIDENCE_CLIENT_RUNBOOK_FILE', paths.clientRunbook),
    'npm run livekit:evidence-pack'
  ].join(' ');
}

function qaKeyCommand(env: NodeJS.ProcessEnv): string {
  return [
    assignment(
      'OPC_LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FILE',
      optional(env.OPC_LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FILE) || '<replace-with-trusted-qa-public-key.pem>'
    ),
    assignment(
      'OPC_LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FINGERPRINT',
      optional(env.OPC_LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FINGERPRINT) || '<replace-with-trusted-qa-public-key-sha256>'
    )
  ].join(' ');
}

function clientInputAssignments(paths: BundlePaths): string {
  return [
    assignment('OPC_LIVEKIT_ACCEPTANCE_PREFLIGHT_REPORT_FILE', paths.preflight),
    assignment('OPC_LIVEKIT_ACCEPTANCE_SERVER_EVIDENCE_FILE', paths.serverEvidence),
    assignment('OPC_LIVEKIT_ACCEPTANCE_READINESS_REPORT_FILE', paths.readiness)
  ].join(' ');
}

function metadataCommand(metadata: LiveKitAcceptanceMetadata): string {
  return Object.entries(liveKitAcceptanceMetadataEnv(metadata))
    .map(([key, value]) => assignment(key, value || ''))
    .join(' ');
}

function assignment(key: string, value: string): string {
  return `${key}=${shellQuote(value)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function refuseExistingRealEvidence(paths: BundlePaths): void {
  const existing = [paths.serverEvidence, paths.readiness, paths.clientResult].filter(existsSync);
  if (existing.length) {
    throw new Error(`Acceptance bundle already contains real-environment evidence: ${existing.join(', ')}`);
  }
}

function optional(value: string | undefined): string {
  return String(value || '').trim();
}

async function main(): Promise<void> {
  const result = writeLiveKitAcceptanceBundle(createLiveKitAcceptanceBundleConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
