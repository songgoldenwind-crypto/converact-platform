/**
 * 不一致-6 — 为 menu / visual_menu 补齐 timeout / invalid / max_retries 出边（安全自动修复项）。
 */
import type { IvrFlowGraph } from './ivr-types.js';

export interface CompleteMenuEdgesOpts {
  prefix?: string;
  /** 占位节点相对 menu 的偏移；缺省基于 menu.position */
  offsetX?: number;
  offsetY?: number;
}

export function withCompleteMenuEdges(
  graph: IvrFlowGraph,
  menuId: string,
  opts: CompleteMenuEdgesOpts = {}
): IvrFlowGraph {
  const prefix = opts.prefix ?? menuId;
  const menuNode = graph.nodes.find((n) => n.id === menuId);
  const baseX = (menuNode?.position.x ?? 0) + (opts.offsetX ?? 220);
  const baseY = menuNode?.position.y ?? 0;

  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const present = new Set(edges.filter((e) => e.source === menuId).map((e) => e.sourceHandle || 'out'));

  const ensureDisconnect = (id: string, name: string, yOffset: number) => {
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        type: 'disconnect',
        name,
        position: { x: baseX + 180, y: baseY + yOffset },
        data: { endReason: 'completed' },
      });
    }
    return id;
  };

  const ensure = (
    handle: string,
    suffix: string,
    mode: 'disconnect' | 'play_then_disconnect',
    yOffset: number
  ) => {
    if (present.has(handle)) return;
    const targetId = `${prefix}_${suffix}`;
    if (mode === 'disconnect') {
      ensureDisconnect(targetId, suffix, yOffset);
      edges.push({
        id: `e_${menuId}_${handle}`,
        source: menuId,
        target: targetId,
        sourceHandle: handle,
      });
      return;
    }

    const playId = `${targetId}_play`;
    const hangupId = `${targetId}_hangup`;
    if (!nodes.some((n) => n.id === playId)) {
      nodes.push({
        id: playId,
        type: 'play',
        name: suffix,
        position: { x: baseX, y: baseY + yOffset },
        data: { contents: [{ playType: 'tts', text: suffix }] },
      });
    }
    ensureDisconnect(hangupId, `${suffix}_hangup`, yOffset);
    edges.push({
      id: `e_${menuId}_${handle}`,
      source: menuId,
      target: playId,
      sourceHandle: handle,
    });
    edges.push({
      id: `e_${playId}_out`,
      source: playId,
      target: hangupId,
      sourceHandle: 'out',
    });
  };

  ensure('timeout', 'timeout', 'disconnect', -80);
  ensure('invalid', 'invalid', 'play_then_disconnect', 0);
  ensure('max_retries', 'max_retries', 'play_then_disconnect', 80);

  return { ...graph, nodes, edges };
}

export interface AutoCompleteEdgesResult {
  graph: IvrFlowGraph;
  applied: Array<{ nodeId: string; handles: string[] }>;
}

/** 对图中全部 menu / visual_menu 应用安全补边。 */
export function completeFlowMissingEdges(graph: IvrFlowGraph): AutoCompleteEdgesResult {
  const applied: AutoCompleteEdgesResult['applied'] = [];
  let next = graph;

  for (const node of graph.nodes) {
    if (node.type !== 'menu' && node.type !== 'visual_menu') continue;
    const before = new Set(
      next.edges.filter((e) => e.source === node.id).map((e) => e.sourceHandle || 'out')
    );
    const patched = withCompleteMenuEdges(next, node.id);
    const after = new Set(
      patched.edges.filter((e) => e.source === node.id).map((e) => e.sourceHandle || 'out')
    );
    const added = [...after].filter((h) => !before.has(h));
    if (added.length > 0) {
      applied.push({ nodeId: node.id, handles: added });
    }
    next = patched;
  }

  return { graph: next, applied };
}
