import { useState } from 'react';

/**
 * IVR 节点编辑器 — 简化版列表+表单（非拖拽画布）。
 * 与 SpecEditorPage 风格一致：白底灰框，Tailwind 样式。
 */

export interface IvrNode {
  id: string;
  name: string;
  prompt?: string;
  transitions?: Record<string, string>;
}

interface IvrNodeEditorProps {
  nodes: IvrNode[];
  onChange: (nodes: IvrNode[]) => void;
}

export default function IvrNodeEditor({ nodes, onChange }: IvrNodeEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = nodes.find((n) => n.id === editingId);

  function addNode() {
    const id = `node_${Date.now().toString(36)}`;
    const node: IvrNode = { id, name: '新节点', prompt: '', transitions: {} };
    onChange([...nodes, node]);
    setEditingId(id);
  }

  function updateNode(id: string, patch: Partial<IvrNode>) {
    onChange(nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }

  function deleteNode(id: string) {
    onChange(nodes.filter((n) => n.id !== id));
    // Remove transitions pointing to deleted node
    onChange(
      nodes
        .filter((n) => n.id !== id)
        .map((n) => {
          if (!n.transitions) return n;
          const cleaned: Record<string, string> = {};
          for (const [key, target] of Object.entries(n.transitions)) {
            if (target !== id) cleaned[key] = target;
          }
          return { ...n, transitions: cleaned };
        })
    );
    if (editingId === id) setEditingId(null);
  }

  function addTransition(nodeId: string) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const key = `trigger_${Object.keys(node.transitions || {}).length + 1}`;
    updateNode(nodeId, {
      transitions: { ...(node.transitions || {}), [key]: nodes[0]?.id || '' }
    });
  }

  function updateTransition(nodeId: string, oldKey: string, newKey: string, target: string) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || !node.transitions) return;
    const updated = { ...node.transitions };
    delete updated[oldKey];
    updated[newKey] = target;
    updateNode(nodeId, { transitions: updated });
  }

  function deleteTransition(nodeId: string, key: string) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || !node.transitions) return;
    const updated = { ...node.transitions };
    delete updated[key];
    updateNode(nodeId, { transitions: updated });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">IVR 流程节点</p>
        <button
          type="button"
          onClick={addNode}
          className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded hover:bg-blue-100"
        >
          + 添加节点
        </button>
      </div>

      {nodes.length === 0 && (
        <p className="text-xs text-gray-400 py-4 text-center">
          暂无节点。AI Agent 将仅按 system_prompt 自由对话，不使用流程导航。
        </p>
      )}

      {/* 节点列表 */}
      <div className="space-y-1">
        {nodes.map((node, idx) => (
          <div
            key={node.id}
            className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer text-sm ${
              editingId === node.id ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 border border-gray-100'
            }`}
            onClick={() => setEditingId(editingId === node.id ? null : node.id)}
          >
            <span className="text-xs text-gray-400 w-6">{idx + 1}.</span>
            <span className="flex-1 font-medium text-gray-800">{node.name || node.id}</span>
            {node.transitions && Object.keys(node.transitions).length > 0 && (
              <span className="text-xs text-gray-400">
                → {Object.values(node.transitions).filter(Boolean).length} 条转跳
              </span>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}
              className="text-xs text-red-400 hover:text-red-600"
            >
              删除
            </button>
          </div>
        ))}
      </div>

      {/* 节点编辑表单 */}
      {editing && (
        <div className="border border-blue-200 bg-blue-50/50 rounded-lg p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">节点 ID</label>
            <input
              value={editing.id}
              readOnly
              className="w-full border border-gray-200 rounded px-2 py-1 text-xs bg-gray-50 text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">节点名称</label>
            <input
              value={editing.name}
              onChange={(e) => updateNode(editing.id, { name: e.target.value })}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">节点提示词（AI 在此节点的行为指令）</label>
            <textarea
              value={editing.prompt || ''}
              onChange={(e) => updateNode(editing.id, { prompt: e.target.value })}
              rows={3}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
              placeholder="例如：确认客户是否有意向预约，如果有则调用 transfer_human 转人工"
            />
          </div>

          {/* 转跳规则 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-600">转跳规则</label>
              <button
                type="button"
                onClick={() => addTransition(editing.id)}
                className="text-xs text-blue-500 hover:text-blue-700"
              >
                + 添加转跳
              </button>
            </div>
            {editing.transitions && Object.entries(editing.transitions).length > 0 ? (
              <div className="space-y-1">
                {Object.entries(editing.transitions).map(([key, target]) => (
                  <div key={key} className="flex items-center gap-1">
                    <input
                      value={key}
                      onChange={(e) => updateTransition(editing.id, key, e.target.value, target)}
                      className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                      placeholder="触发条件（如 intent_high / dtmf_1）"
                    />
                    <span className="text-xs text-gray-400">→</span>
                    <select
                      value={target}
                      onChange={(e) => updateTransition(editing.id, key, key, e.target.value)}
                      className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                    >
                      <option value="">（无）</option>
                      {nodes.filter((n) => n.id !== editing.id).map((n) => (
                        <option key={n.id} value={n.id}>{n.name || n.id}</option>
                      ))}
                      <option value="terminal:transfer_human">转人工</option>
                      <option value="terminal:end_call">结束通话</option>
                      <option value="terminal:schedule_callback">预约回电</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => deleteTransition(editing.id, key)}
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">无转跳规则。AI 将在此节点停留直到通话结束。</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
