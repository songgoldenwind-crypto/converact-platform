import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRustDeskDeploymentCommandPlan,
  renderRustDeskDeploymentCommands,
  writeRustDeskDeploymentCommands
} from '../scripts/rustdesk-deployment-commands.js';

test('RustDesk deployment command plan renders the Docker Compose server bring-up flow', () => {
  const plan = createRustDeskDeploymentCommandPlan({
    CONVERACT_RUSTDESK_DEPLOYMENT_MODE: 'compose',
    CONVERACT_RUSTDESK_DEPLOYMENT_COMPOSE_FILE: 'docker-compose.callcenter.yml',
    CONVERACT_RUSTDESK_API_TOKEN: 'secret-token'
  });

  assert.equal(plan.mode, 'compose');
  assert.deepEqual(plan.ports, [
    '21115/TCP',
    '21116/TCP+UDP',
    '21117/TCP',
    '21118/TCP',
    '21119/TCP'
  ]);

  const commands = commandLines(plan);
  assert.equal(commands.includes('docker compose --profile rustdesk -f docker-compose.callcenter.yml up -d rustdesk-hbbs rustdesk-hbbr'), true);
  assert.equal(commands.includes('docker compose --profile rustdesk -f docker-compose.callcenter.yml logs rustdesk-hbbs rustdesk-hbbr'), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_PREFLIGHT_REPORT_FILE=/tmp/rustdesk-preflight.json') && command.includes('npm run rustdesk:deployment-preflight')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_SERVER_EVIDENCE_FILE=/tmp/rustdesk-server-evidence.json') && command.includes('npm run rustdesk:server-evidence')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_READINESS_REPORT_FILE=/tmp/rustdesk-readiness.json') && command.includes('npm run rustdesk:readiness')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_FILE=/tmp/rustdesk-client-config-pack.md') && command.includes('npm run rustdesk:client-config-pack')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE=/tmp/rustdesk-client-acceptance-template.json') && command.includes('npm run rustdesk:client-acceptance')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE=/tmp/rustdesk-audit-export.jsonl') && command.includes('CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id>') && command.includes('npm run rustdesk:audit-export')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=/tmp/rustdesk-audit-coverage.json') && command.includes('npm run rustdesk:audit-coverage')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_EVIDENCE_PACK_FILE=/tmp/rustdesk-evidence-pack.md') && command.includes('CONVERACT_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE=/tmp/rustdesk-deployment-commands.md') && command.includes('CONVERACT_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE=/tmp/rustdesk-server-evidence.json') && command.includes('CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=/tmp/rustdesk-client-config-pack.md') && command.includes('CONVERACT_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE=/tmp/rustdesk-audit-coverage.json') && command.includes('npm run rustdesk:evidence-pack')), true);
  assert.equal(JSON.stringify(plan).includes('secret-token'), false);
});

test('RustDesk deployment command plan renders the Kubernetes Helm server bring-up flow', () => {
  const plan = createRustDeskDeploymentCommandPlan({
    CONVERACT_RUSTDESK_DEPLOYMENT_MODE: 'k8s',
    CONVERACT_RUSTDESK_DEPLOYMENT_K8S_NAMESPACE: 'converact',
    CONVERACT_RUSTDESK_DEPLOYMENT_HELM_RELEASE: 'converact',
    CONVERACT_RUSTDESK_DEPLOYMENT_HELM_CHART: 'infra/k8s',
    CONVERACT_RUSTDESK_DEPLOYMENT_HELM_VALUES_FILE: 'infra/k8s/values.production.yaml',
    CONVERACT_RUSTDESK_DEPLOYMENT_CONTROL_PLANE: 'converact',
    CONVERACT_RUSTDESK_DEPLOYMENT_RUSTDESK_DEPLOYMENT: 'converact-rustdesk'
  });

  assert.equal(plan.mode, 'k8s');
  const commands = commandLines(plan);
  assert.equal(commands.includes('helm upgrade --install converact infra/k8s --namespace converact --create-namespace --values infra/k8s/values.production.yaml --set rustdesk.enabled=true'), true);
  assert.equal(commands.includes('helm upgrade --install converact infra/k8s --namespace converact --values infra/k8s/values.production.yaml --set rustdesk.enabled=false'), true);
  assert.equal(commands.includes('kubectl -n converact rollout status deployment/converact-rustdesk'), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_PREFLIGHT_REPORT_FILE=/tmp/rustdesk-preflight.json') && command.includes('npm run rustdesk:deployment-preflight')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_SERVER_EVIDENCE_FILE=/tmp/rustdesk-server-evidence.json') && command.includes('npm run rustdesk:server-evidence')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_READINESS_REPORT_FILE=/tmp/rustdesk-readiness.json') && command.includes('npm run rustdesk:readiness')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_FILE=/tmp/rustdesk-client-config-pack.md') && command.includes('npm run rustdesk:client-config-pack')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_ACCEPTANCE_OUTPUT_FILE=/tmp/rustdesk-client-acceptance-result.json') && command.includes('npm run rustdesk:client-acceptance')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE=/tmp/rustdesk-audit-export.jsonl') && command.includes('CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id>') && command.includes('npm run rustdesk:audit-export')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE=/tmp/rustdesk-audit-export.jsonl') && command.includes('npm run rustdesk:audit-coverage')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE=/tmp/rustdesk-client-acceptance-template.json') && command.includes('npm run rustdesk:evidence-pack')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE=/tmp/rustdesk-server-evidence.json') && command.includes('npm run rustdesk:evidence-pack')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=/tmp/rustdesk-client-config-pack.md') && command.includes('npm run rustdesk:evidence-pack')), true);
  assert.equal(commands.some((command) => command.includes('CONVERACT_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE=/tmp/rustdesk-deployment-commands.md') && command.includes('npm run rustdesk:evidence-pack')), true);
});

test('RustDesk deployment command markdown captures ports, key mount, validation, and rollback steps', () => {
  const markdown = renderRustDeskDeploymentCommands(createRustDeskDeploymentCommandPlan({
    CONVERACT_RUSTDESK_DEPLOYMENT_MODE: 'compose',
    CONVERACT_RUSTDESK_DEPLOYMENT_COMPOSE_FILE: 'infra/docker-compose.production.yml'
  }));

  assert.match(markdown, /^# RustDesk Deployment Commands/m);
  assert.match(markdown, /21115\/TCP/);
  assert.match(markdown, /21116\/TCP\+UDP/);
  assert.match(markdown, /21119\/TCP/);
  assert.match(markdown, /id_ed25519\.pub/);
  assert.match(markdown, /npm run rustdesk:deployment-preflight/);
  assert.match(markdown, /npm run rustdesk:server-evidence/);
  assert.match(markdown, /npm run rustdesk:readiness/);
  assert.match(markdown, /npm run rustdesk:client-config-pack/);
  assert.match(markdown, /npm run rustdesk:client-acceptance/);
  assert.match(markdown, /npm run rustdesk:audit-export/);
  assert.match(markdown, /npm run rustdesk:audit-coverage/);
  assert.match(markdown, /npm run rustdesk:evidence-pack/);
  assert.match(markdown, /CONVERACT_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE=\/tmp\/rustdesk-env-checklist\.md/);
  assert.match(markdown, /CONVERACT_RUSTDESK_SERVER_EVIDENCE_FILE=\/tmp\/rustdesk-server-evidence\.json/);
  assert.match(markdown, /CONVERACT_RUSTDESK_CLIENT_CONFIG_PACK_FILE=\/tmp\/rustdesk-client-config-pack\.md/);
  assert.match(markdown, /CONVERACT_RUSTDESK_ACCEPTANCE_AUDIT_FILE=\/tmp\/rustdesk-audit-export\.jsonl/);
  assert.match(markdown, /CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID=<rustdesk-gateway-external-id>/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE=\/tmp\/rustdesk-deployment-commands\.md/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE=\/tmp\/rustdesk-readiness\.json/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE=\/tmp\/rustdesk-server-evidence\.json/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=\/tmp\/rustdesk-client-config-pack\.md/);
  assert.match(markdown, /rollback/i);
});

test('RustDesk deployment commands write an artifact and expose package/env wiring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-rustdesk-deployment-commands-'));
  const outputFile = join(dir, 'rustdesk-deployment-commands.md');
  const result = writeRustDeskDeploymentCommands(outputFile, {
    CONVERACT_RUSTDESK_DEPLOYMENT_MODE: 'compose',
    CONVERACT_RUSTDESK_DEPLOYMENT_COMPOSE_FILE: 'docker-compose.callcenter.yml'
  });

  assert.equal(result.outputFile, outputFile);
  assert.equal(result.mode, 'compose');
  assert.equal(result.commands > 8, true);
  assert.match(readFileSync(outputFile, 'utf8'), /RustDesk Deployment Commands/);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:deployment-commands'], 'tsx scripts/rustdesk-deployment-commands.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const key of [
    'CONVERACT_RUSTDESK_DEPLOYMENT_COMMANDS_FILE=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_MODE=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_COMPOSE_FILE=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_K8S_NAMESPACE=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_HELM_RELEASE=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_HELM_CHART=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_HELM_VALUES_FILE=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_CONTROL_PLANE=',
    'CONVERACT_RUSTDESK_DEPLOYMENT_RUSTDESK_DEPLOYMENT='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnvExample, new RegExp(`^${key}`, 'm'));
  }
});

test('RustDesk deployment commands CLI can emit a markdown artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-rustdesk-deployment-commands-cli-'));
  const outputFile = join(dir, 'rustdesk-deployment-commands.md');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rustdesk-deployment-commands.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      CONVERACT_RUSTDESK_DEPLOYMENT_COMMANDS_FILE: outputFile,
      CONVERACT_RUSTDESK_DEPLOYMENT_MODE: 'k8s',
      CONVERACT_RUSTDESK_DEPLOYMENT_K8S_NAMESPACE: 'converact',
      CONVERACT_RUSTDESK_DEPLOYMENT_HELM_RELEASE: 'converact',
      CONVERACT_RUSTDESK_DEPLOYMENT_HELM_CHART: 'infra/k8s',
      CONVERACT_RUSTDESK_DEPLOYMENT_CONTROL_PLANE: 'converact',
      CONVERACT_RUSTDESK_DEPLOYMENT_RUSTDESK_DEPLOYMENT: 'converact-rustdesk'
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputFile, outputFile);
  assert.equal(payload.mode, 'k8s');
  assert.equal(payload.commands > 8, true);
  assert.match(readFileSync(outputFile, 'utf8'), /helm upgrade --install converact infra\/k8s/);
});

function commandLines(plan: ReturnType<typeof createRustDeskDeploymentCommandPlan>): string[] {
  return plan.sections.flatMap((section) => section.commands);
}
