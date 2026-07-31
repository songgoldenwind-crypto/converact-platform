/**
 * Shared flow graph validation — SSOT for designer save-preview and server API.
 */

import {
  IVR_BRANCH,
  REQUIRED_HANDLES_BY_TYPE,
  type GraphValidationError,
  type MenuOptionLike,
} from './branch-handles.js';
import { isTerminalNode, normalizeGraphForValidation, type IvrFlowGraph, type IvrNodeBase } from './graph-types.js';

export type { GraphValidationError };

export interface FlowValidationReport {
  errors: GraphValidationError[];
  warnings: GraphValidationError[];
}

function formatValidationMessage(e: GraphValidationError): string {
  return e.handle ? `${e.nodeId}.${e.handle}: ${e.message}` : `${e.nodeId}: ${e.message}`;
}

function getMenuOptions(node: IvrNodeBase): MenuOptionLike[] {
  const data = node.data;
  const options = data.options as MenuOptionLike[] | undefined;
  if (options?.length) return options;
  const items = data.items as Array<{ digit: string; label?: string }> | undefined;
  return (items ?? []).map((i) => ({
    digit: i.digit,
    routeType: 'node' as const,
    routeTarget: '',
  }));
}

export function validateFlowGraphDetailed(graph: IvrFlowGraph): FlowValidationReport {
  const normalized = normalizeGraphForValidation(graph);
  const errors: GraphValidationError[] = [];
  const warnings: GraphValidationError[] = [];
  const nodeIds = new Set(normalized.nodes.map((n) => n.id));

  if (!normalized.entryNodeId) {
    errors.push({ nodeId: '', message: 'entryNodeId is required' });
  } else if (!nodeIds.has(normalized.entryNodeId)) {
    errors.push({
      nodeId: normalized.entryNodeId,
      message: `entryNodeId "${normalized.entryNodeId}" not found in nodes`,
    });
  }

  for (const edge of normalized.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push({
        nodeId: edge.source,
        message: `edge ${edge.id}: source "${edge.source}" not found`,
      });
    }
    if (!nodeIds.has(edge.target)) {
      errors.push({
        nodeId: edge.source,
        message: `edge ${edge.id}: target "${edge.target}" not found`,
      });
    }
  }

  const startNodes = normalized.nodes.filter((n) => n.type === 'start');
  if (startNodes.length !== 1 && normalized.nodes.length > 0) {
    errors.push({
      nodeId: '',
      message: `flow must have exactly one start node (found ${startNodes.length})`,
    });
  } else if (
    normalized.entryNodeId &&
    startNodes.length === 1 &&
    normalized.entryNodeId !== startNodes[0].id
  ) {
    warnings.push({
      nodeId: normalized.entryNodeId,
      message: 'entryNodeId should point to the start node',
    });
  }

  const hasTerminal = normalized.nodes.some((n) => isTerminalNode(n.type));
  if (!hasTerminal && normalized.nodes.length > 0) {
    errors.push({
      nodeId: '',
      message: 'flow has no terminal node (transfer/voicemail/sip/disconnect)',
    });
  }

  for (const node of normalized.nodes) {
    const rule = REQUIRED_HANDLES_BY_TYPE[node.type];
    if (!rule) continue;

    const outgoing = normalized.edges.filter((e) => e.source === node.id);
    const present = new Set(outgoing.map((e) => e.sourceHandle || IVR_BRANCH.OUT));

    for (const h of rule.required) {
      if (!present.has(h)) {
        warnings.push({
          nodeId: node.id,
          handle: h,
          message: `缺少必需出边 handle="${h}"`,
        });
      }
    }

    for (const h of rule.dynamic?.(node) ?? []) {
      if (!present.has(h)) {
        warnings.push({
          nodeId: node.id,
          handle: h,
          message: `选项需要出边 handle="${h}"`,
        });
      }
    }
  }

  for (const node of normalized.nodes) {
    if (node.type === 'transfer') {
      const outgoing = normalized.edges.filter((e) => e.source === node.id);
      const present = new Set(outgoing.map((e) => e.sourceHandle || IVR_BRANCH.OUT));
      if (present.size > 0 && !present.has('failed')) {
        warnings.push({
          nodeId: node.id,
          handle: 'failed',
          message: '转接节点建议配置 failed 出边（生产桥接失败时路由）',
        });
      }
    }
  }

  for (const node of normalized.nodes) {
    if (node.type === 'menu' || node.type === 'visual_menu') {
      for (const opt of getMenuOptions(node)) {
        const rt = opt.routeType || 'node';
        if (rt !== 'node' && !(opt.routeTarget ?? '').trim()) {
          warnings.push({
            nodeId: node.id,
            handle: IVR_BRANCH.digit(opt.digit),
            message: `按键 ${opt.digit} routeType=${rt} 需要填写 routeTarget`,
          });
        }
      }
    }
  }

  for (const sc of normalized.globalShortcuts ?? []) {
    for (const node of normalized.nodes) {
      if (node.type !== 'menu' && node.type !== 'visual_menu') continue;
      for (const opt of getMenuOptions(node)) {
        if (opt.digit === sc.digit) {
          warnings.push({
            nodeId: node.id,
            handle: IVR_BRANCH.digit(opt.digit),
            message: `全局快捷键「${sc.digit}」与菜单按键冲突（运行时全局优先）`,
          });
        }
      }
    }
  }

  return { errors, warnings };
}

export function validateFlowGraph(graph: IvrFlowGraph): string[] {
  return validateFlowGraphDetailed(graph).errors.map(formatValidationMessage);
}

export function validateFlowGraphAll(graph: IvrFlowGraph): string[] {
  const report = validateFlowGraphDetailed(graph);
  return [...report.errors, ...report.warnings].map(formatValidationMessage);
}
