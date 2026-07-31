import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export type QualityGateStatus = 'passed' | 'failed' | 'warning' | string;

export interface QualityGateResult {
  gate_id: string;
  status: QualityGateStatus;
  message: string;
  details?: JsonRecord;
}

export interface QualityGateContext {
  playbook?: JsonRecord;
  agentRun?: JsonRecord;
  artifacts: JsonRecord[];
  [key: string]: unknown;
}

export type QualityGateHandler = (context: QualityGateContext) => Promise<QualityGateResult> | QualityGateResult;

export class QualityGateRegistry {
  gates: Map<string, QualityGateHandler>;

  constructor() {
    this.gates = new Map();
  }

  register(gateId: string, handler: QualityGateHandler): void {
    if (this.gates.has(gateId)) throw new Error(`duplicate quality gate: ${gateId}`);
    if (typeof handler !== 'function') throw new Error(`quality gate handler required: ${gateId}`);
    this.gates.set(gateId, handler);
  }

  async run(gateIds: string[] = [], context: QualityGateContext): Promise<QualityGateResult[]> {
    const results: QualityGateResult[] = [];
    for (const gateId of gateIds || []) {
      const handler = this.gates.get(gateId);
      if (!handler) {
        results.push({ gate_id: gateId, status: 'failed', message: 'quality gate not registered' });
        continue;
      }
      results.push(await handler(context));
    }
    return results;
  }
}

export function registerDefaultQualityGates(registry: QualityGateRegistry): void {
  registry.register('artifact_presence_gate', async ({ playbook, artifacts }) => {
    const produced = new Set(artifacts.map((artifact) => artifact.type));
    const missing = (playbook.required_artifacts || []).filter((type) => !produced.has(type));
    return {
      gate_id: 'artifact_presence_gate',
      status: missing.length ? 'failed' : 'passed',
      message: missing.length ? `missing artifacts: ${missing.join(', ')}` : 'required artifacts produced',
      details: { missing }
    };
  });

  registry.register('tenant_scope_gate', async ({ agentRun, artifacts }) => {
    const leaked = artifacts.filter((artifact) => artifact.tenant_id !== agentRun.tenant_id);
    return {
      gate_id: 'tenant_scope_gate',
      status: leaked.length ? 'failed' : 'passed',
      message: leaked.length ? 'artifact tenant mismatch detected' : 'all artifacts match tenant scope',
      details: { leaked_artifact_ids: leaked.map((artifact) => artifact.id) }
    };
  });

  registry.register('metric_consistency_gate', async ({ artifacts }) => ({
    gate_id: 'metric_consistency_gate',
    status: artifacts.length ? 'passed' : 'warning',
    message: artifacts.length ? 'analytics artifact generated' : 'no analytics artifact generated',
    details: {}
  }));

  registry.register('brand_voice_gate', async () => ({
    gate_id: 'brand_voice_gate',
    status: 'warning',
    message: 'brand voice gate is registered but not yet connected to an evaluator',
    details: {}
  }));

  registry.register('factuality_gate', async () => ({
    gate_id: 'factuality_gate',
    status: 'warning',
    message: 'factuality gate is registered but not yet connected to evidence checking',
    details: {}
  }));
}
