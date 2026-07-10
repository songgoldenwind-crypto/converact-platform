import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { NodePalette } from './NodePalette';
import { NodeConfigPanel } from './NodeConfigPanel';
import { TestPanel } from './TestPanel';
import { IvrNodeComponent } from './IvrNodeComponent';
import {
  IVR_NODE_METADATA,
  type IvrNode,
  type IvrNodeType,
  type IvrFlowGraph,
  type GlobalShortcut,
} from './types';
import { validateFlowGraphDetailed } from '@opc/shared/ivr/validate-flow-graph';
import { saveBlockingIssues } from '@opc/shared/ivr/validation-policy';
import { runSimulation } from './simulate-flow';

const nodeTypes = { ivr: IvrNodeComponent };

function createDefaultNode(type: IvrNodeType, x: number, y: number): Node {
  const meta = IVR_NODE_METADATA[type];
  const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const baseData = { type, name: meta.label } as Record<string, unknown>;

  // Minimal default config per type
  switch (type) {
    case 'start': baseData.pushParams = []; break;
    case 'play': baseData.contents = [{ playType: 'tts', ttsEngine: 'ali', text: '' }]; break;
    case 'flush_audio': break;
    case 'menu':
      baseData.prompt = [{ playType: 'tts', ttsEngine: 'ali', text: '请按键选择' }];
      baseData.options = [{ digit: '1', label: '', routeType: 'node', routeTarget: '' }];
      baseData.timeoutSec = 5; baseData.maxRetries = 3;
      break;
    case 'collect':
      baseData.prompt = [{ playType: 'tts', ttsEngine: 'ali', text: '请输入号码' }];
      baseData.minDigits = 1; baseData.maxDigits = 6; baseData.endMode = 'hash_key';
      baseData.inputWaitSec = 5; baseData.timeoutSec = 10; baseData.maxRetries = 1;
      baseData.storeVariable = 'collected';
      break;
    case 'set_var': baseData.variableName = ''; baseData.valueType = 'string'; baseData.value = ''; break;
    case 'condition': baseData.logic = 'and'; baseData.rules = [{ field: '', op: 'eq', value: '' }]; break;
    case 'time_condition': baseData.scheduleId = ''; break;
    case 'queue': baseData.queueName = ''; baseData.strategy = 'fifo'; baseData.timeoutSec = 300; baseData.timeoutAction = 'voicemail'; break;
    case 'http': baseData.method = 'GET'; baseData.url = ''; baseData.timeoutSec = 10; break;
    case 'transfer': baseData.targetType = 'seat_id'; baseData.targetValue = ''; break;
    case 'voicemail': baseData.maxDurationSec = 60; break;
    case 'sip': baseData.sipUri = ''; break;
    case 'disconnect': baseData.contents = []; baseData.endReason = 'completed'; break;
    case 'ai_dialogue': baseData.role = 'outbound'; baseData.maxTurns = 10; baseData.timeoutSec = 30; break;
    case 'intent': baseData.dimension = 'score'; baseData.threshold = 0.7; break;
    case 'knowledge_qa': baseData.knowledgeBaseId = ''; baseData.maxResults = 3; baseData.noAnswerAction = 'transfer'; break;
    case 'avatar_switch': baseData.direction = 'voice_to_video'; break;
    case 'compliance': baseData.complianceType = 'ai_disclosure'; baseData.language = 'zh'; break;
    case 'video_play': baseData.sourceType = 'prerecorded'; baseData.loop = false; baseData.skippable = true; break;
    case 'screen_share': baseData.source = 'agent'; baseData.allowRemoteControl = false; break;
    case 'visual_menu': baseData.title = ''; baseData.items = []; break;
    case 'subflow': baseData.flowId = ''; break;
    case 'recording': baseData.action = 'start'; baseData.format = 'wav'; break;
    case 'webhook': baseData.url = ''; baseData.eventType = ''; baseData.method = 'POST'; break;
  }

  return {
    id,
    type: 'ivr',
    position: { x, y },
    data: baseData as unknown as Record<string, unknown>,
  };
}

function flowToReact(graph: IvrFlowGraph): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'ivr',
    position: n.position,
    data: n as unknown as Record<string, unknown>,
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    label: e.label,
  }));
  return { nodes, edges };
}

function reactToFlow(nodes: Node[], edges: Edge[], entryNodeId: string, globalShortcuts: GlobalShortcut[]): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId,
    nodes: nodes.map((n) => ({ ...n.data, id: n.id, name: (n.data as Record<string, unknown>).name as string, position: n.position }) as unknown as IvrNode),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined, label: e.label ? String(e.label) : undefined })),
    variables: [],
    globalShortcuts: globalShortcuts.length > 0 ? globalShortcuts : undefined,
  };
}

interface ValidationIssue {
  nodeId?: string;
  handle?: string;
  message: string;
}

function formatValidationIssues(errors: ValidationIssue[], warnings: ValidationIssue[]): string {
  const lines = [
    ...errors.map((e) => `错误: ${e.nodeId || '—'}${e.handle ? `.${e.handle}` : ''} — ${e.message}`),
    ...warnings.map((w) => `警告: ${w.nodeId || '—'}${w.handle ? `.${w.handle}` : ''} — ${w.message}`),
  ];
  return lines.join('\n');
}

function readApiPayload<T>(json: { data?: T } & T): T {
  return (json.data ?? json) as T;
}

interface GenerateIvrResponse {
  graph?: IvrFlowGraph;
  llmTier?: 'primary' | 'fallback';
  model?: string;
  warnings?: string[];
  publishReady?: boolean;
  validation?: { errors?: ValidationIssue[]; warnings?: ValidationIssue[] };
  error?: string | { message?: string };
  errors?: ValidationIssue[];
}

function formatGenerateStatus(data: GenerateIvrResponse): string {
  const tierLabel =
    data.llmTier === 'fallback' ? `DeepSeek 备用 (${data.model})` : `27B (${data.model ?? '—'})`;
  const warnText = data.warnings?.join(' · ') || '';
  return `AI 生成完成 [${tierLabel}]${data.publishReady ? ' · 可发布' : ''}${warnText ? ` · ${warnText.slice(0, 100)}` : ''}`;
}

function readGenerateError(json: unknown, res: Response, data: GenerateIvrResponse): string {
  const envelope = json as { error?: { message?: string } | string };
  if (typeof data.error === 'object' && data.error?.message) return data.error.message;
  if (typeof data.error === 'string') return data.error;
  if (typeof envelope.error === 'object' && envelope.error?.message) return envelope.error.message;
  if (typeof envelope.error === 'string') return envelope.error;
  const errors = data.errors ?? data.validation?.errors ?? [];
  const warnings = data.validation?.warnings ?? [];
  if (errors.length || warnings.length) return formatValidationIssues(errors, warnings);
  return res.statusText;
}

function IvrDesignerInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [entryNodeId, setEntryNodeId] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/ivr-node') as IvrNodeType;
      if (!type || !IVR_NODE_METADATA[type]) return;
      const position = {
        x: event.clientX - (wrapperRef.current?.getBoundingClientRect().left ?? 0) - 80,
        y: event.clientY - (wrapperRef.current?.getBoundingClientRect().top ?? 0) - 20,
      };
      const newNode = createDefaultNode(type, position.x, position.y);
      setNodes((nds) => [...nds, newNode]);
      if (type === 'start' && !entryNodeId) setEntryNodeId(newNode.id);
    },
    [setNodes, entryNodeId]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;

  const [flowId, setFlowId] = useState('');
  const [flowName, setFlowName] = useState('');
  const [globalShortcuts, setGlobalShortcuts] = useState<GlobalShortcut[]>([]);
  const [saveStatus, setSaveStatus] = useState('');
  const [validationErrors, setValidationErrors] = useState<ValidationIssue[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<ValidationIssue[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Array<{ version: number; name: string; created_at: string }>>([]);
  const [searchParams] = useSearchParams();

  // Live graph snapshot for the test panel
  const currentGraph: IvrFlowGraph | null = nodes.length > 0
    ? reactToFlow(nodes, edges, entryNodeId || nodes[0]?.id || '', globalShortcuts)
    : null;

  const issueNodeIds = useMemo(
    () =>
      new Set(
        [...validationErrors, ...validationWarnings]
          .map((i) => i.nodeId)
          .filter((id): id is string => !!id)
      ),
    [validationErrors, validationWarnings]
  );

  const canvasNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: { ...n.data, hasValidationIssue: issueNodeIds.has(n.id) },
      })),
    [nodes, issueNodeIds]
  );

  // Load a flow from the URL ?flow=<id> on mount
  useEffect(() => {
    const flowParam = searchParams.get('flow');
    if (!flowParam) return;
    void (async () => {
      try {
        const res = await fetch(`/api/ivr/flows/${flowParam}`);
        const json = await res.json();
        const flow = json.data || json;
        if (flow?.graph) {
          const { nodes: rn, edges: re } = flowToReact(flow.graph);
          setNodes(rn);
          setEdges(re);
          setEntryNodeId(flow.graph.entryNodeId);
          setFlowId(flow.id);
          setFlowName(flow.name || '');
          setGlobalShortcuts(flow.graph.globalShortcuts ?? []);
        }
      } catch { /* ignore — empty canvas is fine */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleValidate = async (graphOverride?: IvrFlowGraph) => {
    const graph = graphOverride ?? reactToFlow(nodes, edges, entryNodeId || nodes[0]?.id || '', globalShortcuts);
    if (!graph.nodes.length) { alert('流程为空'); return; }
    try {
      const res = await fetch('/api/ivr/flows/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graph }),
      });
      const json = await res.json();
      if (!res.ok) {
        const payload = readApiPayload<{
          error?: string;
          errors?: ValidationIssue[];
          warnings?: ValidationIssue[];
        }>(json);
        setValidationErrors(payload.errors ?? []);
        setValidationWarnings(payload.warnings ?? []);
        alert(payload.error || formatValidationIssues(payload.errors ?? [], payload.warnings ?? []));
        return;
      }
      const payload = readApiPayload<{
        valid?: boolean;
        errors?: ValidationIssue[];
        warnings?: ValidationIssue[];
      }>(json);
      const errors = payload.errors ?? [];
      const warnings = payload.warnings ?? [];
      setValidationErrors(errors);
      setValidationWarnings(warnings);
      const valid = payload.valid ?? (errors.length === 0 && warnings.length === 0);
      if (!valid && errors[0]?.nodeId) setSelectedNodeId(errors[0].nodeId);
      setSaveStatus(valid ? '校验通过 ✓' : `校验: ${errors.length} 错误 / ${warnings.length} 警告`);
      setTimeout(() => setSaveStatus(''), 3000);
    } catch (e) {
      alert('校验失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleCompleteMissingEdges = async () => {
    const graph = reactToFlow(nodes, edges, entryNodeId || nodes[0]?.id || '', globalShortcuts);
    if (!graph.nodes.length) { alert('流程为空'); return; }
    try {
      const res = await fetch('/api/ivr/flows/complete-missing-edges', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graph }),
      });
      const json = await res.json();
      if (!res.ok) {
        const payload = readApiPayload<{ error?: string }>(json);
        alert('补全失败: ' + (payload.error || res.statusText));
        return;
      }
      const payload = readApiPayload<{
        graph: IvrFlowGraph;
        applied: Array<{ nodeId: string; handles: string[] }>;
        validation?: { errors?: ValidationIssue[]; warnings?: ValidationIssue[] };
      }>(json);
      if (!payload.applied.length) {
        setSaveStatus('无需补边');
        setTimeout(() => setSaveStatus(''), 2000);
        return;
      }
      const { nodes: rn, edges: re } = flowToReact(payload.graph);
      setNodes(rn);
      setEdges(re);
      setValidationErrors(payload.validation?.errors ?? []);
      setValidationWarnings(payload.validation?.warnings ?? []);
      setSaveStatus(`已补全 ${payload.applied.length} 个菜单节点缺边`);
      setTimeout(() => setSaveStatus(''), 3000);
    } catch (e) {
      alert('补全失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleSave = async () => {
    const graph = reactToFlow(nodes, edges, entryNodeId || nodes[0]?.id || '', globalShortcuts);
    if (!graph.nodes.length) { alert('流程为空'); return; }

    const localValidation = validateFlowGraphDetailed(graph as Parameters<typeof validateFlowGraphDetailed>[0]);
    setValidationErrors(localValidation.errors);
    setValidationWarnings(localValidation.warnings);
    const saveBlocked = saveBlockingIssues(localValidation, 'warn');
    if (saveBlocked.length > 0) {
      setSaveStatus('保存失败');
      const first = saveBlocked[0];
      if (first?.nodeId) setSelectedNodeId(first.nodeId);
      alert(formatValidationIssues(localValidation.errors, localValidation.warnings));
      return;
    }

    const id = flowId || `ivr_${Date.now().toString(36)}`;
    const name = flowName || '未命名 IVR 流程';
    setSaveStatus('保存中…');
    try {
      const res = await fetch('/api/ivr/flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name, graph }),
      });
      const json = await res.json();
      if (!res.ok) {
        const payload = readApiPayload<{
          error?: string;
          errors?: ValidationIssue[];
          warnings?: ValidationIssue[];
        }>(json);
        setValidationErrors(payload.errors ?? []);
        setValidationWarnings(payload.warnings ?? []);
        setSaveStatus('保存失败');
        alert(payload.error || formatValidationIssues(payload.errors ?? [], payload.warnings ?? []));
        return;
      }
      const saved = readApiPayload<{ id?: string; name?: string; validation?: { errors?: ValidationIssue[]; warnings?: ValidationIssue[] } }>(json);
      setValidationErrors(saved.validation?.errors ?? []);
      setValidationWarnings(saved.validation?.warnings ?? []);
      setFlowId(saved.id || id);
      setFlowName(saved.name || name);
      setSaveStatus('已保存 ✓');
      setTimeout(() => setSaveStatus(''), 2000);
    } catch (e) {
      setSaveStatus('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handlePublish = async () => {
    if (!flowId) { alert('请先保存'); return; }
    try {
      const res = await fetch(`/api/ivr/flows/${flowId}/publish`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        const payload = readApiPayload<{
          error?: string;
          errors?: ValidationIssue[];
          warnings?: ValidationIssue[];
        }>(json);
        setValidationErrors(payload.errors ?? []);
        setValidationWarnings(payload.warnings ?? []);
        alert(payload.error || formatValidationIssues(payload.errors ?? [], payload.warnings ?? []));
        return;
      }
      setSaveStatus('已发布 ✓');
      setTimeout(() => setSaveStatus(''), 2000);
    } catch (e) {
      alert('发布失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const loadHistory = async () => {
    if (!flowId) { alert('请先保存流程'); return; }
    try {
      const res = await fetch(`/api/ivr/flows/${flowId}/history`);
      const json = await res.json();
      setHistory(json.data || []);
      setShowHistory(true);
    } catch (e) {
      alert('加载版本历史失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const rollbackTo = async (version: number) => {
    if (!flowId || !confirm(`回滚到版本 v${version}？`)) return;
    try {
      const res = await fetch(`/api/ivr/flows/${flowId}/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const json = await res.json();
      const flow = json.data;
      if (flow?.graph) {
        const { nodes: rn, edges: re } = flowToReact(flow.graph);
        setNodes(rn);
        setEdges(re);
        setEntryNodeId(flow.graph.entryNodeId);
        setFlowName(flow.name || flowName);
        setGlobalShortcuts(flow.graph.globalShortcuts ?? []);
        setShowHistory(false);
        setSaveStatus(`已回滚到 v${version} ✓`);
        setTimeout(() => setSaveStatus(''), 2000);
      }
    } catch (e) {
      alert('回滚失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleLoad = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const graph = JSON.parse(e.target?.result as string) as IvrFlowGraph;
        const { nodes: rn, edges: re } = flowToReact(graph);
        setNodes(rn);
        setEdges(re);
        setEntryNodeId(graph.entryNodeId);
        setGlobalShortcuts(graph.globalShortcuts ?? []);
      } catch {
        alert('无法解析 IVR 流程文件');
      }
    };
    reader.readAsText(file);
  };

  const applyGeneratedFlow = async (data: GenerateIvrResponse) => {
    if (!data.graph) return;
    const { nodes: rn, edges: re } = flowToReact(data.graph);
    setNodes(rn);
    setEdges(re);
    setEntryNodeId(data.graph.entryNodeId);
    setGlobalShortcuts(data.graph.globalShortcuts ?? []);
    if (data.validation) {
      setValidationErrors(data.validation.errors ?? []);
      setValidationWarnings(data.validation.warnings ?? []);
    }
    setSaveStatus(formatGenerateStatus(data));
    setTimeout(() => setSaveStatus(''), 5000);
    await handleValidate(data.graph);
    if (data.publishReady && window.confirm('生成成功且可发布。是否用 DTMF「1」模拟？')) {
      try {
        const sim = await runSimulation(data.graph, ['1']);
        alert(sim.terminated ? `模拟结束于节点 ${sim.finalNodeId}` : `模拟未完成: ${sim.error || ''}`);
      } catch (simErr) {
        alert('模拟失败: ' + (simErr instanceof Error ? simErr.message : String(simErr)));
      }
    }
  };

  const generateWithAI = async (description: string) => {
    try {
      const res = await fetch('/api/ivr/generate-from-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description, language: 'zh' }),
      });
      const json = await res.json();
      const data = readApiPayload<GenerateIvrResponse>(json);
      if (!res.ok) {
        setValidationErrors(data.validation?.errors ?? data.errors ?? []);
        setValidationWarnings(data.validation?.warnings ?? []);
        alert(`生成失败 (${res.status}): ${readGenerateError(json, res, data)}`);
        return;
      }
      if (!data.graph) {
        alert('生成失败: 响应缺少 graph');
        return;
      }
      await applyGeneratedFlow(data);
    } catch (e) {
      alert('AI 生成失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const generateFromCsv = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = ''; // allow re-uploading same file
    const reader = new FileReader();
    reader.onload = async (e) => {
      const csv = e.target?.result as string;
      try {
        const res = await fetch('/api/ivr/generate-from-csv', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ csv, language: 'zh' }),
        });
        const json = await res.json();
        const data = readApiPayload<GenerateIvrResponse>(json);
        if (!res.ok) {
          setValidationErrors(data.validation?.errors ?? data.errors ?? []);
          setValidationWarnings(data.validation?.warnings ?? []);
          alert(`CSV 生成失败 (${res.status}): ${readGenerateError(json, res, data)}`);
          return;
        }
        if (!data.graph) {
          alert('CSV 生成失败: 响应缺少 graph');
          return;
        }
        await applyGeneratedFlow(data);
      } catch (err) {
        alert('CSV 生成失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
    reader.readAsText(file);
  };

  const handleUpdateNode = (id: string, data: Record<string, unknown>) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)));
  };

  const handleDeleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    if (entryNodeId === id) setEntryNodeId('');
    if (selectedNodeId === id) setSelectedNodeId(null);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      <NodePalette onDragStart={() => {}} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 bg-white">
          <h2 className="text-sm font-semibold text-gray-800">IVR 流程设计器</h2>
          <input
            className="text-sm border border-gray-300 rounded-md px-2 py-1 w-36"
            placeholder="流程名称"
            value={flowName}
            onChange={(e) => setFlowName(e.target.value)}
          />
          <span className="text-xs text-gray-400">
            {nodes.length} 节点 · {edges.length} 连线
          </span>
          {saveStatus && <span className="text-xs text-green-600">{saveStatus}</span>}
          {(validationErrors.length > 0 || validationWarnings.length > 0) && (
            <span className="text-xs text-amber-600">
              {validationErrors.length} 错误 · {validationWarnings.length} 警告
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void handleValidate()}
            disabled={nodes.length === 0}
            className="text-xs border border-gray-300 text-gray-700 px-3 py-1.5 rounded-md hover:bg-gray-50 disabled:opacity-40"
          >
            校验
          </button>
          <button
            type="button"
            onClick={() => void handleCompleteMissingEdges()}
            disabled={nodes.length === 0}
            className="text-xs border border-amber-300 text-amber-800 px-3 py-1.5 rounded-md hover:bg-amber-50 disabled:opacity-40"
            title="为菜单节点自动补齐 timeout / invalid / max_retries 出边"
          >
            补全缺边
          </button>
          <button
            type="button"
            onClick={() => {
              const desc = prompt('描述你的 IVR 需求，AI 自动生成流程：\n例如：售后IVR，工作日转人工，非工作日留言');
              if (desc) void generateWithAI(desc);
            }}
            className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-md hover:bg-emerald-700"
          >
            AI 生成
          </button>
          <label className="text-xs border border-emerald-300 text-emerald-700 rounded-md px-3 py-1.5 cursor-pointer hover:bg-emerald-50">
            CSV 导入
            <input type="file" accept=".csv,.txt" className="hidden" onChange={generateFromCsv} />
          </label>
          <label className="text-xs border border-gray-300 rounded-md px-3 py-1.5 cursor-pointer hover:bg-gray-50">
            导入
            <input type="file" accept=".json" className="hidden" onChange={handleLoad} />
          </label>
          <button
            type="button"
            onClick={() => void loadHistory()}
            disabled={!flowId}
            className="text-xs border border-gray-300 text-gray-700 px-3 py-1.5 rounded-md hover:bg-gray-50 disabled:opacity-40"
          >
            版本历史
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => void handlePublish()}
            disabled={!flowId}
            className="text-xs border border-green-300 text-green-700 px-3 py-1.5 rounded-md hover:bg-green-50 disabled:opacity-40"
          >
            发布
          </button>
        </div>

        {/* Canvas */}
        <div ref={wrapperRef} className="flex-1 min-h-0" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={canvasNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
            defaultEdgeOptions={{ animated: true, style: { stroke: '#94a3b8', strokeWidth: 2 } }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {/* Test panel (bottom) */}
        <TestPanel graph={currentGraph} activeNodeId={selectedNodeId} />
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-lg shadow-xl w-96 max-h-[70vh] flex flex-col">
            <div className="px-4 py-3 border-b flex justify-between items-center">
              <h3 className="text-sm font-semibold">版本历史</h3>
              <button type="button" onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="overflow-y-auto p-4 space-y-2">
              {history.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">暂无历史版本</p>
              ) : (
                history.map((h) => (
                  <div key={h.version} className="flex items-center justify-between border border-gray-100 rounded-md px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">v{h.version} · {h.name}</p>
                      <p className="text-xs text-gray-400">{h.created_at}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void rollbackTo(h.version)}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      回滚
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Config panel */}
      <NodeConfigPanel
        node={selectedNode}
        nodes={nodes}
        globalShortcuts={globalShortcuts}
        onUpdateShortcuts={setGlobalShortcuts}
        onUpdate={handleUpdateNode}
        onDelete={handleDeleteNode}
      />
    </div>
  );
}

export default function IvrDesignerPage() {
  return (
    <ReactFlowProvider>
      <IvrDesignerInner />
    </ReactFlowProvider>
  );
}
