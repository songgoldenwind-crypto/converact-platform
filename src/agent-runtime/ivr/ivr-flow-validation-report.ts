/**
 * 不一致-6 §6-MIG.2 — 租户级流程校验报告。
 */
import type { IvrFlowRecord } from './ivr-flow-store.js';
import type { FlowValidationReport } from './ivr-types.js';
import { validateFlowGraphDetailed } from './ivr-types.js';
import { publishBlockingIssues, saveBlockingIssues } from './ivr-validation-policy.js';

export interface FlowValidationEntry {
  id: string;
  name: string;
  status: IvrFlowRecord['status'];
  version: number;
  updated_at: string;
  valid: boolean;
  saveBlocked: boolean;
  publishBlocked: boolean;
  errors: FlowValidationReport['errors'];
  warnings: FlowValidationReport['warnings'];
}

export interface TenantValidationReport {
  flows: FlowValidationEntry[];
  summary: {
    total: number;
    saveBlocked: number;
    publishBlocked: number;
    needsRepair: number;
  };
}

export function buildFlowValidationEntry(flow: IvrFlowRecord): FlowValidationEntry {
  const validation = validateFlowGraphDetailed(flow.graph);
  const saveBlocked = saveBlockingIssues(validation).length > 0;
  const publishBlocked = publishBlockingIssues(validation).length > 0;
  return {
    id: flow.id,
    name: flow.name,
    status: flow.status,
    version: flow.version,
    updated_at: flow.updated_at,
    valid: validation.errors.length === 0 && validation.warnings.length === 0,
    saveBlocked,
    publishBlocked,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

export function buildTenantValidationReport(flows: IvrFlowRecord[]): TenantValidationReport {
  const entries = flows.map(buildFlowValidationEntry);
  return {
    flows: entries,
    summary: {
      total: entries.length,
      saveBlocked: entries.filter((e) => e.saveBlocked).length,
      publishBlocked: entries.filter((e) => e.publishBlocked).length,
      needsRepair: entries.filter((e) => e.publishBlocked && e.status === 'published').length,
    },
  };
}
