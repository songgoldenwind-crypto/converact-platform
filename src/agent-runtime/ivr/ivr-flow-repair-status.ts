/**
 * §6-MIG — mark published flows with validation issues as needs_repair.
 */
import type { IvrFlowRecord } from './ivr-flow-store.js';
import { IvrFlowStore } from './ivr-flow-store.js';
import { validateFlowGraphDetailed } from './ivr-types.js';
import { publishBlockingIssues } from './ivr-validation-policy.js';

export function flowNeedsRepair(flow: IvrFlowRecord): boolean {
  if (flow.status !== 'published' && flow.status !== 'needs_repair') return false;
  const report = validateFlowGraphDetailed(flow.graph);
  return publishBlockingIssues(report).length > 0;
}

export function refreshFlowRepairStatuses(
  store: IvrFlowStore,
  tenantId: string
): { marked: number; cleared: number } {
  let marked = 0;
  let cleared = 0;
  for (const flow of store.listFlows(tenantId)) {
    const blocked = publishBlockingIssues(validateFlowGraphDetailed(flow.graph)).length > 0;
    if (flow.status === 'published' && blocked) {
      store.setFlowStatus(tenantId, flow.id, 'needs_repair');
      marked++;
    } else if (flow.status === 'needs_repair' && !blocked) {
      store.setFlowStatus(tenantId, flow.id, 'published');
      cleared++;
    }
  }
  return { marked, cleared };
}
