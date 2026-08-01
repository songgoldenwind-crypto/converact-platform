import { resolveBrandEnv } from '../src/config/converact-env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RustDeskDeploymentCommandMode = 'compose' | 'k8s';

export interface RustDeskDeploymentCommandSection {
  title: string;
  purpose: string;
  commands: string[];
}

export interface RustDeskDeploymentCommandPlan {
  mode: RustDeskDeploymentCommandMode;
  summary: Record<string, string>;
  ports: string[];
  sections: RustDeskDeploymentCommandSection[];
}

export interface RustDeskDeploymentCommandsWriteResult {
  outputFile: string;
  mode: RustDeskDeploymentCommandMode;
  commands: number;
}

const RUSTDESK_PORTS = [
  '21115/TCP',
  '21116/TCP+UDP',
  '21117/TCP',
  '21118/TCP',
  '21119/TCP'
];
const DEFAULT_DEPLOYMENT_COMMANDS_ARTIFACT = '/tmp/rustdesk-deployment-commands.md';

export function createRustDeskDeploymentCommandPlan(env: NodeJS.ProcessEnv): RustDeskDeploymentCommandPlan {
  const mode = parseMode(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_MODE'));
  return mode === 'k8s' ? createK8sPlan(env) : createComposePlan(env);
}

export function renderRustDeskDeploymentCommands(plan: RustDeskDeploymentCommandPlan): string {
  const lines = [
    '# RustDesk Deployment Commands',
    '',
    'Generated locally. Commands are intentionally explicit and do not include secret values.',
    '',
    `Mode: \`${plan.mode}\``,
    '',
    '## Runtime Inputs',
    '',
    ...Object.entries(plan.summary).map(([key, value]) => `- ${key}: \`${value}\``),
    '',
    '## Required Ports',
    '',
    ...plan.ports.map((port) => `- \`${port}\``),
    '',
    'RustDesk OSS hbbs generates `id_ed25519.pub` in its data directory. Converact must be able to read the mounted public key at `/rustdesk/id_ed25519.pub` or receive the same value through `CONVERACT_RUSTDESK_PUBLIC_KEY`.',
    ''
  ];

  for (const section of plan.sections) {
    lines.push(`## ${section.title}`, '', section.purpose, '', '```bash');
    lines.push(...section.commands);
    lines.push('```', '');
  }

  return lines.join('\n');
}

export function writeRustDeskDeploymentCommands(
  outputFile: string,
  env: NodeJS.ProcessEnv
): RustDeskDeploymentCommandsWriteResult {
  const plan = createRustDeskDeploymentCommandPlan(env);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, renderRustDeskDeploymentCommands(plan), 'utf8');
  return {
    outputFile,
    mode: plan.mode,
    commands: countCommands(plan)
  };
}

function createComposePlan(env: NodeJS.ProcessEnv): RustDeskDeploymentCommandPlan {
  const composeFile = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_COMPOSE_FILE')) || 'docker-compose.callcenter.yml';
  const compose = `docker compose -f ${composeFile}`;
  const profileCompose = `docker compose --profile rustdesk -f ${composeFile}`;
  const deploymentCommandsArtifact = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_COMMANDS_FILE')) || DEFAULT_DEPLOYMENT_COMMANDS_ARTIFACT;

  return {
    mode: 'compose',
    summary: {
      compose_file: composeFile,
      rustdesk_services: 'rustdesk-hbbs rustdesk-hbbr',
      converact_public_key_path: '/rustdesk/id_ed25519.pub'
    },
    ports: [...RUSTDESK_PORTS],
    sections: [
      section(
        'Validate Compose Config',
        'Render the Compose model first so missing profile services or invalid env interpolation fail before deployment.',
        [
          `${compose} config rustdesk-hbbs rustdesk-hbbr`
        ]
      ),
      section(
        'Start RustDesk Server',
        'Start hbbs/hbbr with the RustDesk profile and inspect process state/logs before running Converact checks.',
        [
          `${profileCompose} up -d rustdesk-hbbs rustdesk-hbbr`,
          `${profileCompose} ps rustdesk-hbbs rustdesk-hbbr`,
          `${profileCompose} logs rustdesk-hbbs rustdesk-hbbr`
        ]
      ),
      section(
        'Verify Key Mount And Env',
        'Confirm hbbs generated the public key and the Converact container can read the mounted key file, then run the no-network deployment preflight and server runtime evidence collector.',
        [
          `${compose} exec rustdesk-hbbs test -s /root/id_ed25519.pub`,
          `${compose} exec converact test -s /rustdesk/id_ed25519.pub`,
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE: '/tmp/rustdesk-env-checklist.md',
            CONVERACT_RUSTDESK_PREFLIGHT_REPORT_FILE: '/tmp/rustdesk-preflight.json'
          }, 'rustdesk:deployment-preflight'),
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_SERVER_EVIDENCE_FILE: '/tmp/rustdesk-server-evidence.json'
          }, 'rustdesk:server-evidence')
        ]
      ),
      section(
        'Run Server Readiness',
        'Run strict RustDesk readiness and LED facade smoke after env, key file, ports, launch page, protocol URL, audit, and device target settings are present.',
        [
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_READINESS_REPORT_FILE: '/tmp/rustdesk-readiness.json'
          }, 'rustdesk:readiness'),
          `${compose} exec converact npm run rustdesk:converact-smoke`
        ]
      ),
      section(
        'Record Real Client Acceptance',
        'Generate and then fill the manual acceptance evidence after a real RustDesk client verifies screen view, control, file transfer, clipboard, recording, revoke disconnect, and old-link rejection. Export the matching gateway audit, validate coverage, and regenerate the final evidence pack before customer handoff.',
        [
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_FILE: '/tmp/rustdesk-client-config-pack.md',
            CONVERACT_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: '<rustdesk-gateway-external-id>',
            CONVERACT_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '<rustdesk-runtime-id>'
          }, 'rustdesk:client-config-pack'),
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE: '/tmp/rustdesk-client-acceptance-runbook.md'
          }, 'rustdesk:client-acceptance'),
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE: '/tmp/rustdesk-client-acceptance-template.json'
          }, 'rustdesk:client-acceptance'),
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID: '<rustdesk-gateway-external-id>'
          }, 'rustdesk:audit-export'),
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE: '/tmp/rustdesk-client-acceptance-template.json',
            CONVERACT_RUSTDESK_ACCEPTANCE_AUDIT_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_ACCEPTANCE_OUTPUT_FILE: '/tmp/rustdesk-client-acceptance-result.json'
          }, 'rustdesk:client-acceptance'),
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE: '/tmp/rustdesk-audit-coverage.json'
          }, 'rustdesk:audit-coverage'),
          composeConveractCommand(compose, {
            CONVERACT_RUSTDESK_EVIDENCE_PACK_FILE: '/tmp/rustdesk-evidence-pack.md',
            CONVERACT_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: deploymentCommandsArtifact,
            CONVERACT_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: '/tmp/rustdesk-env-checklist.md',
            CONVERACT_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE: '/tmp/rustdesk-preflight.json',
            CONVERACT_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE: '/tmp/rustdesk-server-evidence.json',
            CONVERACT_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE: '/tmp/rustdesk-readiness.json',
            CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: '/tmp/rustdesk-client-config-pack.md',
            CONVERACT_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: '/tmp/rustdesk-client-acceptance-template.json',
            CONVERACT_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_AUDIT_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE: '/tmp/rustdesk-audit-coverage.json'
          }, 'rustdesk:evidence-pack')
        ]
      ),
      section(
        'Rollback / Cleanup',
        'Stop only the RustDesk server containers if the deployment must be rolled back; keep the data volume until key/session evidence is reviewed.',
        [
          `${profileCompose} stop rustdesk-hbbs rustdesk-hbbr`
        ]
      )
    ]
  };
}

function createK8sPlan(env: NodeJS.ProcessEnv): RustDeskDeploymentCommandPlan {
  const namespace = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_K8S_NAMESPACE')) || 'converact';
  const helmRelease = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_HELM_RELEASE')) || 'converact';
  const helmChart = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_HELM_CHART')) || 'infra/k8s';
  const helmValuesFile = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_HELM_VALUES_FILE')) || '<production-values.yaml>';
  const converactDeployment = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_CONTROL_PLANE')) || `${helmRelease}-converact`;
  const rustdeskDeployment = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_RUSTDESK_DEPLOYMENT')) || `${helmRelease}-rustdesk`;
  const deploymentCommandsArtifact = optionalString(resolveBrandEnv(env, 'RUSTDESK_DEPLOYMENT_COMMANDS_FILE')) || DEFAULT_DEPLOYMENT_COMMANDS_ARTIFACT;

  return {
    mode: 'k8s',
    summary: {
      namespace,
      helm_release: helmRelease,
      helm_chart: helmChart,
      helm_values_file: helmValuesFile,
      converact_deployment: converactDeployment,
      rustdesk_deployment: rustdeskDeployment,
      converact_public_key_path: '/rustdesk/id_ed25519.pub'
    },
    ports: [...RUSTDESK_PORTS],
    sections: [
      section(
        'Install Or Upgrade Helm Release',
        'Enable the RustDesk chart resources and wait for hbbs/hbbr to roll out before running Converact checks.',
        [
          `helm upgrade --install ${helmRelease} ${helmChart} --namespace ${namespace} --create-namespace --values ${helmValuesFile} --set rustdesk.enabled=true`,
          `kubectl -n ${namespace} rollout status deployment/${rustdeskDeployment}`,
          `kubectl -n ${namespace} get service ${rustdeskDeployment} -o wide`,
          `kubectl -n ${namespace} logs deployment/${rustdeskDeployment} --all-containers --tail=200`
        ]
      ),
      section(
        'Verify Key Mount And Env',
        'Confirm hbbs generated the public key and the Converact pod can read the mounted key file, then run the no-network deployment preflight and server runtime evidence collector.',
        [
          `kubectl -n ${namespace} exec deploy/${rustdeskDeployment} -c hbbs -- test -s /root/id_ed25519.pub`,
          `kubectl -n ${namespace} exec deploy/${converactDeployment} -- test -s /rustdesk/id_ed25519.pub`,
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE: '/tmp/rustdesk-env-checklist.md',
            CONVERACT_RUSTDESK_PREFLIGHT_REPORT_FILE: '/tmp/rustdesk-preflight.json'
          }, 'rustdesk:deployment-preflight'),
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_SERVER_EVIDENCE_FILE: '/tmp/rustdesk-server-evidence.json'
          }, 'rustdesk:server-evidence')
        ]
      ),
      section(
        'Run Server Readiness',
        'Run strict RustDesk readiness and LED facade smoke after DNS, Service, public key, launch page, protocol URL, audit, and target device settings are present.',
        [
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_READINESS_REPORT_FILE: '/tmp/rustdesk-readiness.json'
          }, 'rustdesk:readiness'),
          `kubectl -n ${namespace} exec deploy/${converactDeployment} -- npm run rustdesk:converact-smoke`
        ]
      ),
      section(
        'Record Real Client Acceptance',
        'Generate and then fill the manual acceptance evidence after a real RustDesk client verifies screen view, control, file transfer, clipboard, recording, revoke disconnect, and old-link rejection. Export the matching gateway audit, validate coverage, and regenerate the final evidence pack before customer handoff.',
        [
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_FILE: '/tmp/rustdesk-client-config-pack.md',
            CONVERACT_RUSTDESK_CLIENT_CONFIG_EXTERNAL_ID: '<rustdesk-gateway-external-id>',
            CONVERACT_RUSTDESK_CLIENT_CONFIG_TARGET_RUSTDESK_ID: '<rustdesk-runtime-id>'
          }, 'rustdesk:client-config-pack'),
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE: '/tmp/rustdesk-client-acceptance-runbook.md'
          }, 'rustdesk:client-acceptance'),
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE: '/tmp/rustdesk-client-acceptance-template.json'
          }, 'rustdesk:client-acceptance'),
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID: '<rustdesk-gateway-external-id>'
          }, 'rustdesk:audit-export'),
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE: '/tmp/rustdesk-client-acceptance-template.json',
            CONVERACT_RUSTDESK_ACCEPTANCE_AUDIT_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_ACCEPTANCE_OUTPUT_FILE: '/tmp/rustdesk-client-acceptance-result.json'
          }, 'rustdesk:client-acceptance'),
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE: '/tmp/rustdesk-audit-coverage.json'
          }, 'rustdesk:audit-coverage'),
          k8sConveractCommand(namespace, converactDeployment, {
            CONVERACT_RUSTDESK_EVIDENCE_PACK_FILE: '/tmp/rustdesk-evidence-pack.md',
            CONVERACT_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: deploymentCommandsArtifact,
            CONVERACT_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: '/tmp/rustdesk-env-checklist.md',
            CONVERACT_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE: '/tmp/rustdesk-preflight.json',
            CONVERACT_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE: '/tmp/rustdesk-server-evidence.json',
            CONVERACT_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE: '/tmp/rustdesk-readiness.json',
            CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: '/tmp/rustdesk-client-config-pack.md',
            CONVERACT_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: '/tmp/rustdesk-client-acceptance-template.json',
            CONVERACT_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_AUDIT_FILE: '/tmp/rustdesk-audit-export.jsonl',
            CONVERACT_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE: '/tmp/rustdesk-audit-coverage.json'
          }, 'rustdesk:evidence-pack')
        ]
      ),
      section(
        'Rollback / Cleanup',
        'Disable only the RustDesk chart resources if rollback is required; keep PVC data until key/session evidence is reviewed.',
        [
          `helm upgrade --install ${helmRelease} ${helmChart} --namespace ${namespace} --values ${helmValuesFile} --set rustdesk.enabled=false`
        ]
      )
    ]
  };
}

function section(title: string, purpose: string, commands: string[]): RustDeskDeploymentCommandSection {
  return { title, purpose, commands };
}

function composeConveractCommand(compose: string, env: Record<string, string>, script: string): string {
  return `${compose} exec converact env ${envAssignments(env)} npm run ${script}`;
}

function k8sConveractCommand(
  namespace: string,
  deployment: string,
  env: Record<string, string>,
  script: string
): string {
  return `kubectl -n ${namespace} exec deploy/${deployment} -- env ${envAssignments(env)} npm run ${script}`;
}

function envAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function parseMode(value: string | undefined): RustDeskDeploymentCommandMode {
  const mode = optionalString(value) || 'compose';
  if (mode === 'compose' || mode === 'k8s') return mode;
  if (mode === 'kubernetes') return 'k8s';
  throw new Error('CONVERACT_RUSTDESK_DEPLOYMENT_MODE must be compose or k8s');
}

function countCommands(plan: RustDeskDeploymentCommandPlan): number {
  return plan.sections.reduce((total, section) => total + section.commands.length, 0);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

async function main(): Promise<void> {
  const outputFile = optionalString(resolveBrandEnv(process.env, 'RUSTDESK_DEPLOYMENT_COMMANDS_FILE'));
  if (outputFile) {
    console.log(JSON.stringify(writeRustDeskDeploymentCommands(outputFile, process.env), null, 2));
    return;
  }

  console.log(renderRustDeskDeploymentCommands(createRustDeskDeploymentCommandPlan(process.env)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
