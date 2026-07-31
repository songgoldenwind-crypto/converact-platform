import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { QualityGateContext, QualityGateRegistry } from '../quality/quality-gate-registry.js';

interface EvalRuntimeLike {
  runPlaybook: (input: JsonRecord) => Promise<JsonRecord>;
}

interface EvalRunnerOptions {
  runtime: EvalRuntimeLike;
  qualityGateRegistry: QualityGateRegistry;
  agentRegistry?: unknown;
}

interface EvalCheck {
  name: string;
  passed: boolean;
  actual: unknown;
  expected: unknown;
  missing?: unknown[];
}

export class EvalRunner {
  runtime: EvalRuntimeLike;
  qualityGateRegistry: QualityGateRegistry;
  agentRegistry: unknown;

  constructor({ runtime, qualityGateRegistry, agentRegistry = null }: EvalRunnerOptions) {
    this.runtime = runtime;
    this.qualityGateRegistry = qualityGateRegistry;
    this.agentRegistry = agentRegistry;
  }

  async runPlaybookCase(testCase: JsonRecord): Promise<JsonRecord> {
    requireFields(testCase, ['id', 'input', 'expect']);
    const result = await this.runtime.runPlaybook(testCase.input);
    const producedArtifacts = (result.artifacts || []).map((artifact) => artifact.type);
    const checks = [
      checkEqual('agent_run.status', result.agent_run.status, testCase.expect.agent_status),
      checkEqual('workflow_run.status', result.workflow_run.status, testCase.expect.workflow_status),
      checkIncludes('artifacts', producedArtifacts, testCase.expect.artifacts || [])
    ].filter(Boolean);

    return {
      id: testCase.id,
      type: 'playbook',
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      result
    };
  }

  async runQualityGateCase(testCase: JsonRecord): Promise<JsonRecord> {
    requireFields(testCase, ['id', 'gate_ids', 'context', 'expect']);
    const results = await this.qualityGateRegistry.run(testCase.gate_ids, testCase.context);
    const statuses = Object.fromEntries(results.map((result) => [result.gate_id, result.status]));
    const checks = Object.entries(testCase.expect.statuses || {}).map(([gateId, expected]) =>
      checkEqual(`quality_gate.${gateId}`, statuses[gateId], expected)
    );

    return {
      id: testCase.id,
      type: 'quality_gate',
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      result: results
    };
  }

  async runSuite(suite: JsonRecord): Promise<JsonRecord> {
    const playbookResults: JsonRecord[] = [];
    for (const testCase of suite.playbook_cases || []) {
      playbookResults.push(await this.runPlaybookCase(testCase));
    }
    const qualityGateResults: JsonRecord[] = [];
    for (const testCase of suite.quality_gate_cases || []) {
      qualityGateResults.push(await this.runQualityGateCase(testCase));
    }
    const results = [...playbookResults, ...qualityGateResults];
    return {
      id: suite.id || 'eval_suite',
      status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
      total: results.length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: results.filter((result) => result.status === 'failed').length,
      results
    };
  }
}

export function createQualityGateFixture({ tenant_id, playbook, agentRun, artifacts = [] }: JsonRecord): QualityGateContext {
  return {
    playbook,
    agentRun,
    artifacts: artifacts.map((artifact) => ({
      tenant_id,
      status: 'draft',
      version: 1,
      ...artifact
    }))
  };
}

function checkEqual(name: string, actual: unknown, expected: unknown): EvalCheck | null {
  if (expected === undefined) return null;
  return {
    name,
    passed: actual === expected,
    actual,
    expected
  };
}

function checkIncludes(name: string, actual: unknown[], expectedItems: unknown[]): EvalCheck {
  const missing = expectedItems.filter((item) => !actual.includes(item));
  return {
    name,
    passed: missing.length === 0,
    actual,
    expected: expectedItems,
    missing
  };
}

function requireFields(value: JsonRecord, fields: string[]): void {
  for (const field of fields) {
    if (value?.[field] === undefined || value?.[field] === null) throw new Error(`eval case ${field} is required`);
  }
}
