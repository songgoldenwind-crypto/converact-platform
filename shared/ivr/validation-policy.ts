import type { FlowValidationReport, GraphValidationError } from './validate-flow-graph.js';

export type IvrValidationMode = 'warn' | 'block';

/** Issues that block publish — errors + warnings (phase C). */
export function publishBlockingIssues(report: FlowValidationReport): GraphValidationError[] {
  return [...report.errors, ...report.warnings];
}

/** Issues that block save — mode controls whether warnings block. */
export function saveBlockingIssues(
  report: FlowValidationReport,
  mode: IvrValidationMode = 'warn'
): GraphValidationError[] {
  if (mode === 'block') {
    return [...report.errors, ...report.warnings];
  }
  return report.errors;
}
