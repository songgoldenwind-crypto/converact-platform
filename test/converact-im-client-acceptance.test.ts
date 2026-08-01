import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CONVERACT_IM_REQUIRED_ACCEPTANCE_CHECKS,
  createConveractFabricImAcceptanceTemplate,
  renderConveractFabricImAcceptanceRunbook,
  runConveractFabricImAcceptance,
  runConveractFabricImAcceptanceFromEnv,
  writeConveractFabricImAcceptanceTemplate
} from '../scripts/converact-im-client-acceptance.js';

test('IM acceptance template is intentionally incomplete and covers every real check', () => {
  const template = createConveractFabricImAcceptanceTemplate();
  assert.equal(template.source, 'real_environment');
  assert.equal(template.status, 'incomplete');
  for (const id of CONVERACT_IM_REQUIRED_ACCEPTANCE_CHECKS) {
    assert.equal(template.checks[id].passed, false, id);
    assert.match(String(template.checks[id].evidence.artifact_file), /replace-with/);
  }
  assert.doesNotMatch(JSON.stringify(template), /Bearer\s|PRIVATE KEY|eyJ[A-Za-z0-9_-]+\./);
});

test('IM acceptance validates complete secret-safe two-browser evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-pass-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    const result = runConveractFabricImAcceptance({ reportFile });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'ready_for_review');
    assert.equal(result.summary.passed, CONVERACT_IM_REQUIRED_ACCEPTANCE_CHECKS.length);
    assert.deepEqual(result.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IM acceptance rejects placeholders secrets missing evidence and identical identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-fail-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    report.environment_id = 'replace-with-environment';
    report.identities.customer = report.identities.agent;
    report.auth_token = 'Bearer top-secret-token';
    delete report.checks['message.send_receive'];
    report.checks['layout.mobile'].evidence.sha256 = '0'.repeat(64);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    const result = runConveractFabricImAcceptance({ reportFile });
    assert.equal(result.ok, false);
    for (const id of ['report.environment_id', 'report.identities', 'report.secrets', 'message.send_receive', 'layout.mobile']) {
      assert.equal(result.failures.some((failure) => failure.id === id), true, id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IM acceptance reports not_run without real environment input instead of fabricating checks', () => {
  const result = runConveractFabricImAcceptanceFromEnv({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_run');
  assert.deepEqual(result.missing_environment, ['CONVERACT_FABRIC_IM_ACCEPTANCE_REPORT_FILE']);
  assert.equal('checks' in result, false);
});

test('IM acceptance reads the v1 ivekit endpoint key as a compatibility alias', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-legacy-endpoint-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    report.endpoints.ivekit = report.endpoints.converact;
    delete report.endpoints.converact;
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(runConveractFabricImAcceptance({ reportFile }).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IM acceptance rejects stale artifacts and report output path collisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-window-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    report.checks['receipt.read'].evidence.captured_at = '2026-07-01T12:10:00.000Z';
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    const result = runConveractFabricImAcceptance({ reportFile });
    assert.equal(result.failures.some((failure) => failure.id === 'receipt.read' && /time window/.test(failure.reason)), true);
    assert.throws(() => runConveractFabricImAcceptance({ reportFile, outputFile: reportFile }), /must differ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IM acceptance binds each unique JSON observation to its check run and environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-binding-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    const send = report.checks['message.send_receive'].evidence;
    const receipt = report.checks['receipt.read'].evidence;
    receipt.artifact_file = send.artifact_file;
    receipt.sha256 = send.sha256;
    const reactionFile = join(dir, report.checks['message.reaction_pin'].evidence.artifact_file);
    const reaction = JSON.parse(readFileSync(reactionFile, 'utf8'));
    reaction.check_id = 'message.send_receive';
    const reactionContent = Buffer.from(JSON.stringify(reaction));
    writeFileSync(reactionFile, reactionContent);
    report.checks['message.reaction_pin'].evidence.sha256 = createHash('sha256').update(reactionContent).digest('hex');
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    const result = runConveractFabricImAcceptance({ reportFile });
    assert.equal(result.failures.some((failure) => failure.id === 'receipt.read' && /unique/.test(failure.reason)), true);
    assert.equal(result.failures.some((failure) => failure.id === 'message.reaction_pin' && /check_id/.test(failure.reason)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IM acceptance rejects symlink evidence and common Basic or Cookie secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-secret-'));
  const outside = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-outside-'));
  const reportFile = join(dir, 'report.json');
  try {
    const report = completeReport(dir) as any;
    const target = join(outside, 'outside.json');
    writeFileSync(target, JSON.stringify({ observed: true }));
    const link = join(dir, 'linked.json');
    symlinkSync(target, link);
    const linked = report.checks['layout.desktop'].evidence;
    linked.artifact_file = 'linked.json';
    linked.sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
    report.checks['layout.mobile'].evidence.details = {
      observation: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      cookie: 'session=top-secret-cookie'
    };
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    const result = runConveractFabricImAcceptance({ reportFile });
    assert.equal(result.failures.some((failure) => failure.id === 'layout.desktop' && /symbolic link/.test(failure.reason)), true);
    assert.equal(result.failures.some((failure) => failure.id === 'report.secrets'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('IM acceptance writes a template and a runbook with the two-browser procedure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-im-acceptance-template-'));
  const templateFile = join(dir, 'template.json');
  try {
    writeConveractFabricImAcceptanceTemplate(templateFile);
    const template = JSON.parse(readFileSync(templateFile, 'utf8'));
    assert.equal(Object.keys(template.checks).length, CONVERACT_IM_REQUIRED_ACCEPTANCE_CHECKS.length);
    const runbook = renderConveractFabricImAcceptanceRunbook();
    assert.match(runbook, /two real browsers/i);
    assert.match(runbook, /real Tinode/i);
    assert.match(runbook, /do not include.*token/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function completeReport(dir: string): Record<string, any> {
  const runId = 'converact-im-real-run-1';
  const checks: Record<string, unknown> = {};
  for (const id of CONVERACT_IM_REQUIRED_ACCEPTANCE_CHECKS) {
    const artifact = `${id.replaceAll('.', '-')}.json`;
    const content = Buffer.from(JSON.stringify({
      schema_version: 1,
      source: 'real_environment',
      check_id: id,
      run_id: runId,
      environment_id: 'led-staging-sfo2',
      captured_at: '2026-07-11T12:10:00.000Z',
      tool: id.startsWith('layout.') ? 'browser-screenshot-review' : 'real-browser-observation',
      observation: {
        observed: true,
        identity_count: 2,
        summary: id === 'session.list' ? 'Basic workflow passed' : 'Expected behavior observed'
      },
      redaction_review: id.startsWith('layout.')
        ? { reviewed_by: 'qa-reviewer-1', reviewed_at: '2026-07-11T12:12:00.000Z', sensitive_data_absent: true }
        : undefined
    }));
    writeFileSync(join(dir, artifact), content);
    checks[id] = {
      passed: true,
      evidence: {
        artifact_file: artifact,
        sha256: createHash('sha256').update(content).digest('hex'),
        captured_at: '2026-07-11T12:10:00.000Z',
        tool: id.startsWith('layout.') ? 'browser-screenshot-review' : 'real-browser-observation',
        run_id: runId,
        details: { observed: true, identity_count: 2 }
      }
    };
  }
  return {
    schema_version: 1,
    source: 'real_environment',
    status: 'completed',
    run_id: runId,
    environment_id: 'led-staging-sfo2',
    deployed_commit: 'a'.repeat(40),
    checked_at: '2026-07-11T12:15:00.000Z',
    identities: { agent: 'agent-real-1', customer: 'customer-real-1' },
    endpoints: { converact: 'https://fabric.converact.example.com', tinode: 'wss://tinode.example.com/v0/channels' },
    checks
  };
}
