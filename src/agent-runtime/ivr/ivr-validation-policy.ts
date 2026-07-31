/**
 * 不一致-6 阶段 C — save/publish 校验策略（IVR_STRICT_VALIDATE=warn|block）。
 */
import {
  publishBlockingIssues as sharedPublishBlocking,
  saveBlockingIssues as sharedSaveBlocking,
  type IvrValidationMode,
} from '../../../shared/ivr/validation-policy.js';
import type { FlowValidationReport, GraphValidationError } from './ivr-types.js';

export type { IvrValidationMode };

export function getIvrValidationMode(): IvrValidationMode {
  return process.env.IVR_STRICT_VALIDATE === 'block' ? 'block' : 'warn';
}

export function saveBlockingIssues(report: FlowValidationReport): GraphValidationError[] {
  return sharedSaveBlocking(report, getIvrValidationMode());
}

export function publishBlockingIssues(report: FlowValidationReport): GraphValidationError[] {
  return sharedPublishBlocking(report);
}
