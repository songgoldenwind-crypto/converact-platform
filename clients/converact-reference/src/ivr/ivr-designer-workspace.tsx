import type {
  ConveractFabricHttpSdk,
  ConveractFabricIvrCompilationReport,
  ConveractFabricIvrFlow,
  ConveractFabricIvrFlowGraph,
  ConveractFabricIvrFlowVersion,
  ConveractFabricIvrSimulationResult
} from '@converact/sdk';
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type EdgeChange
} from '@xyflow/react';
import {
  Braces,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FilePlus2,
  FlaskConical,
  GitBranch,
  History,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  UploadCloud,
  Workflow,
  X
} from 'lucide-react';
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import {
  IVR_NODE_DEFINITIONS,
  createDefaultIvrGraph,
  createIvrNode,
  parseImportedIvrGraph,
  toCanvasGraph,
  toIvrFlowGraph,
  type ConveractFabricIvrCanvasNode,
  type ConveractFabricIvrNodeCategory,
  type ConveractFabricIvrNodeType
} from './ivr-designer-model.js';
import { IvrNodeCard, type IvrFlowCanvasNode } from './ivr-node-card.js';

type IvrClient = Pick<ConveractFabricHttpSdk, 'ivr'>;
type DesignerEdge = Edge;
type ValidationIssue = Record<string, unknown>;

const nodeTypes = { ivr: IvrNodeCard };
const categoryLabels: Record<ConveractFabricIvrNodeCategory, string> = {
  call: 'Call control', logic: 'Routing and data', intelligence: 'AI and compliance', media: 'Visual media'
};

export function IvrDesignerWorkspace(props: {
  client: IvrClient | null;
  flowId: string;
  onFlowIdChange(flowId: string): void;
  refreshVersion?: number;
}) {
  return <ReactFlowProvider><IvrDesignerWorkspaceInner {...props} /></ReactFlowProvider>;
}

function IvrDesignerWorkspaceInner(props: {
  client: IvrClient | null;
  flowId: string;
  onFlowIdChange(flowId: string): void;
  refreshVersion?: number;
}) {
  const initialGraph = useRef(createDefaultIvrGraph()).current;
  const initialCanvas = useRef(toCanvasGraph(initialGraph)).current;
  const [nodes, setNodes, applyNodeChanges] = useNodesState<IvrFlowCanvasNode>(
    initialCanvas.nodes as IvrFlowCanvasNode[]
  );
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<DesignerEdge>(initialCanvas.edges);
  const [graphBase, setGraphBase] = useState<ConveractFabricIvrFlowGraph>(initialGraph);
  const [flows, setFlows] = useState<ConveractFabricIvrFlow[]>([]);
  const [flow, setFlow] = useState<ConveractFabricIvrFlow | null>(null);
  const [flowName, setFlowName] = useState('New IVR flow');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [dirty, setDirty] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Unsaved draft');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<ConveractFabricIvrCompilationReport | null>(null);
  const [versions, setVersions] = useState<ConveractFabricIvrFlowVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [simulationScript, setSimulationScript] = useState('[]');
  const [simulationVariables, setSimulationVariables] = useState('{}');
  const [simulation, setSimulation] = useState<ConveractFabricIvrSimulationResult | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const loadGeneration = useRef(0);
  const loadedFlowId = useRef('');
  const hasLoaded = useRef(false);
  const dirtyRef = useRef(dirty);
  const refreshVersionRef = useRef(props.refreshVersion ?? 0);
  const importRef = useRef<HTMLInputElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow<IvrFlowCanvasNode, DesignerEdge>();
  dirtyRef.current = dirty;

  const selectedNode = nodes.find((nodeValue) => nodeValue.id === selectedNodeId) || null;
  const currentGraph = useCallback(() => toIvrFlowGraph({
    nodes: nodes as unknown as ConveractFabricIvrCanvasNode[],
    edges: edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {})
    }))
  }, graphBase), [edges, graphBase, nodes]);

  const loadGraph = useCallback((graph: ConveractFabricIvrFlowGraph) => {
    const canvas = toCanvasGraph(graph);
    setGraphBase(structuredClone(graph));
    setNodes(canvas.nodes as IvrFlowCanvasNode[]);
    setEdges(canvas.edges);
    setSelectedNodeId('');
    setValidation(null);
    setSimulation(null);
    queueMicrotask(() => void fitView({ padding: 0.18, duration: 0 }));
  }, [fitView, setEdges, setNodes]);

  useEffect(() => {
    if (!props.client) return;
    const nextRefreshVersion = props.refreshVersion ?? 0;
    const externalRefresh = hasLoaded.current
      && refreshVersionRef.current !== nextRefreshVersion
      && loadedFlowId.current === props.flowId;
    refreshVersionRef.current = nextRefreshVersion;
    if (externalRefresh && dirtyRef.current) {
      setError('Server update available. Save or reload before continuing.');
      return;
    }
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const [listed, selected] = await Promise.all([
          props.client!.ivr.listFlows(),
          props.flowId ? props.client!.ivr.getFlow(props.flowId) : Promise.resolve(null)
        ]);
        if (generation !== loadGeneration.current) return;
        setFlows(listed);
        if (selected) {
          setFlow(selected);
          setFlowName(selected.name);
          loadGraph(selected.draft_graph);
          setDirty(false);
          setStatus(selected.current_published_version
            ? `Published v${selected.current_published_version}` : `Draft r${selected.draft_revision}`);
        }
        loadedFlowId.current = selected?.id || '';
        hasLoaded.current = true;
      } catch (cause) {
        if (generation === loadGeneration.current) setError(errorMessage(cause));
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    })();
    return () => { if (generation === loadGeneration.current) loadGeneration.current += 1; };
  }, [loadGraph, props.client, props.flowId, props.refreshVersion, reloadVersion]);

  const onNodesChange = useCallback((changes: NodeChange<IvrFlowCanvasNode>[]) => {
    applyNodeChanges(changes);
    if (changes.some((change) => change.type !== 'select')) setDirty(true);
  }, [applyNodeChanges]);
  const onEdgesChange = useCallback((changes: EdgeChange<DesignerEdge>[]) => {
    applyEdgeChanges(changes);
    setDirty(true);
  }, [applyEdgeChanges]);
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    setEdges((current) => addEdge({
      ...connection,
      id: edgeId(connection.source!, connection.sourceHandle, connection.target!),
      animated: false
    }, current.filter((edge) => !(edge.source === connection.source
      && (edge.sourceHandle || 'out') === (connection.sourceHandle || 'out')))));
    setDirty(true);
  }, [setEdges]);

  const addNode = useCallback((type: ConveractFabricIvrNodeType, position?: { x: number; y: number }) => {
    const graphNode = createIvrNode(type, position ?? {
      x: 160 + (nodes.length % 4) * 210,
      y: 100 + Math.floor(nodes.length / 4) * 145
    });
    const canvas = toCanvasGraph({ ...createDefaultIvrGraph(), nodes: [graphNode], edges: [] });
    setNodes((current) => [...current, canvas.nodes[0] as IvrFlowCanvasNode]);
    setSelectedNodeId(graphNode.id);
    setDirty(true);
    window.requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 0 }));
  }, [fitView, nodes.length, setNodes]);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/converact-ivr-node') as ConveractFabricIvrNodeType;
    if (!IVR_NODE_DEFINITIONS.some((definition) => definition.type === type)) return;
    addNode(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [addNode, screenToFlowPosition]);

  const changeFlowName = (value: string) => { setFlowName(value); setDirty(true); };
  const changeGraphBase = (patch: Partial<ConveractFabricIvrFlowGraph>) => {
    setGraphBase((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const changeNode = (patch: Partial<ConveractFabricIvrCanvasNode['data']>) => {
    setNodes((current) => current.map((nodeValue) => nodeValue.id === selectedNodeId
      ? { ...nodeValue, data: { ...nodeValue.data, ...patch } }
      : nodeValue));
    setDirty(true);
  };
  const deleteSelectedNode = () => {
    if (!selectedNode || selectedNode.data.ivr_type === 'start') return;
    setNodes((current) => current.filter((nodeValue) => nodeValue.id !== selectedNode.id));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
    setSelectedNodeId('');
    setDirty(true);
  };

  const persistDraft = async (): Promise<ConveractFabricIvrFlow> => {
    if (!props.client) throw new Error('IVR client is unavailable');
    const name = flowName.trim();
    if (!name) throw new Error('flow name is required');
    const graph = currentGraph();
    const saved = flow
      ? await props.client.ivr.updateFlow(flow.id, {
        expected_revision: flow.draft_revision, name, graph
      })
      : await props.client.ivr.createFlow({ name, graph, metadata: {} });
    setFlow(saved);
    setFlowName(saved.name);
    setGraphBase(structuredClone(saved.draft_graph));
    setFlows((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setDirty(false);
    setStatus(`Draft r${saved.draft_revision}`);
    if (saved.id !== props.flowId) props.onFlowIdChange(saved.id);
    return saved;
  };

  const command = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await operation(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const save = () => command(async () => { await persistDraft(); });
  const reload = () => {
    if (!flow || busy) return;
    if (dirty && !window.confirm('Discard unsaved IVR changes and reload from the server?')) return;
    setDirty(false);
    setError('');
    setReloadVersion((value) => value + 1);
  };
  const validate = () => command(async () => {
    const saved = dirty || !flow ? await persistDraft() : flow;
    if (!props.client) throw new Error('IVR client is unavailable');
    const report = await props.client.ivr.validateFlow(saved.id);
    applyValidation(report);
    setStatus(report.errors.length ? `${report.errors.length} validation errors` : 'Validation passed');
  });
  const publish = () => command(async () => {
    const saved = dirty || !flow ? await persistDraft() : flow;
    if (!props.client) throw new Error('IVR client is unavailable');
    const report = await props.client.ivr.validateFlow(saved.id);
    applyValidation(report);
    if (report.errors.length) throw new Error('flow has blocking validation errors');
    const result = await props.client.ivr.publishFlow(saved.id, saved.draft_revision, {
      idempotencyKey: commandId('ivr-publish')
    });
    setFlow(result.flow);
    setFlows((current) => current.map((item) => item.id === result.flow.id ? result.flow : item));
    setStatus(`Published v${result.version.version}`);
  });
  const showHistory = () => command(async () => {
    if (!props.client || !flow) return;
    setVersions(await props.client.ivr.listVersions(flow.id));
    setHistoryOpen(true);
  });
  const rollback = (sourceVersion: number) => command(async () => {
    if (!props.client || !flow) return;
    const result = await props.client.ivr.rollbackFlow(flow.id, {
      expected_draft_revision: flow.draft_revision,
      source_version: sourceVersion
    }, { idempotencyKey: commandId('ivr-rollback') });
    setFlow(result.flow);
    setFlowName(result.flow.name);
    loadGraph(result.flow.draft_graph);
    setFlows((current) => current.map((item) => item.id === result.flow.id ? result.flow : item));
    setDirty(false);
    setHistoryOpen(false);
    setStatus(`Rolled back as v${result.version.version}`);
  });
  const simulate = () => command(async () => {
    if (!props.client || !flow) throw new Error('save the flow before simulation');
    const script = parseJsonArray(simulationScript, 'simulation script');
    const variables = parseJsonRecord(simulationVariables, 'simulation variables');
    const result = await props.client.ivr.simulate({
      flow_id: flow.id,
      ...(flow.current_published_version ? { flow_version: flow.current_published_version } : {}),
      script,
      variables
    });
    setSimulation(result);
  });

  const applyValidation = (report: ConveractFabricIvrCompilationReport) => {
    setValidation(report);
    const counts = new Map<string, number>();
    for (const issue of [...report.errors, ...report.warnings]) {
      const id = issueNodeId(issue);
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    setNodes((current) => current.map((nodeValue) => ({
      ...nodeValue,
      data: { ...nodeValue.data, issue_count: counts.get(nodeValue.id) || undefined }
    })));
  };

  const selectFlow = (next: ConveractFabricIvrFlow) => {
    if (dirty && !window.confirm('Discard unsaved IVR changes?')) return;
    props.onFlowIdChange(next.id);
  };
  const newFlow = () => {
    if (dirty && flow && !window.confirm('Discard unsaved IVR changes?')) return;
    const graph = createDefaultIvrGraph();
    setFlow(null);
    setFlowName('New IVR flow');
    loadGraph(graph);
    setDirty(true);
    setStatus('Unsaved draft');
    props.onFlowIdChange('');
  };
  const importGraph = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const graph = parseImportedIvrGraph(await file.text());
      loadGraph(graph);
      setDirty(true);
      setStatus(`Imported ${graph.nodes.length} nodes`);
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const exportGraph = () => {
    try {
      const blob = new Blob([JSON.stringify(currentGraph(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${safeFilename(flowName) || 'ivr-flow'}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) { setError(errorMessage(cause)); }
  };

  return <section className="ivr-designer" aria-label="IVR Designer">
    <aside className="ivr-library">
      <header><span><Workflow size={15} /><strong>IVR flows</strong></span><button title="Create new IVR flow" onClick={newFlow}><FilePlus2 size={15} /></button></header>
      <div className="ivr-flow-list">
        {flows.map((item) => <button key={item.id} className={item.id === flow?.id ? 'selected' : ''} onClick={() => selectFlow(item)}>
          <span><strong>{item.name}</strong><small>{item.status} · r{item.draft_revision}</small></span><ChevronRight size={14} />
        </button>)}
        {!loading && !flows.length && <p>No saved flows</p>}
      </div>
      <div className="ivr-palette">
        {Object.entries(categoryLabels).map(([category, label]) => <section key={category}>
          <h3>{label}</h3>
          <div>{IVR_NODE_DEFINITIONS.filter((item) => item.category === category).map((item) => <button
            aria-label={`Add ${item.label}`}
            draggable
            key={item.type}
            onClick={() => addNode(item.type)}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/converact-ivr-node', item.type);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            title={item.description}
          ><Plus size={12} /><span>{item.label}</span></button>)}</div>
        </section>)}
      </div>
    </aside>

    <div className="ivr-editor">
      <header className="ivr-toolbar">
        <input aria-label="Flow name" value={flowName} maxLength={160} onChange={(event) => changeFlowName(event.target.value)} />
        <output className={dirty ? 'dirty' : ''}>{dirty ? 'Unsaved changes' : status}</output>
        <div>
          <button title="Save flow draft" disabled={busy || !props.client} onClick={() => void save()}><Save size={15} /></button>
          <button title="Reload flow from server" disabled={busy || !flow} onClick={reload}><RefreshCw size={15} /></button>
          <button title="Validate current draft" disabled={busy || !props.client} onClick={() => void validate()}><CheckCircle2 size={15} /></button>
          <button title="Publish current draft" disabled={busy || !props.client} onClick={() => void publish()}><UploadCloud size={15} /></button>
          <button title="Show version history" disabled={busy || !flow} onClick={() => void showHistory()}><History size={15} /></button>
          <button title="Import IVR graph" disabled={busy} onClick={() => importRef.current?.click()}><Upload size={15} /></button>
          <button title="Export IVR graph" disabled={busy} onClick={exportGraph}><Download size={15} /></button>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importGraph(event)} />
        </div>
      </header>
      <div className="ivr-canvas" onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}>
        <ReactFlow<IvrFlowCanvasNode, DesignerEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, nodeValue) => setSelectedNodeId(nodeValue.id)}
          onPaneClick={() => setSelectedNodeId('')}
          fitView
          minZoom={0.25}
          maxZoom={1.8}
          deleteKeyCode={['Backspace', 'Delete']}
          defaultEdgeOptions={{ style: { stroke: '#76867c', strokeWidth: 1.5 } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#b9c3bc" />
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <SimulationPanel
        flow={flow}
        script={simulationScript}
        variables={simulationVariables}
        result={simulation}
        busy={busy}
        onScript={setSimulationScript}
        onVariables={setSimulationVariables}
        onRun={() => void simulate()}
      />
    </div>

    <aside className="ivr-inspector">
      {selectedNode
        ? <NodeInspector node={selectedNode} onChange={changeNode} onDelete={deleteSelectedNode} />
        : <FlowInspector graph={graphBase} onChange={changeGraphBase} />}
      <ValidationPanel report={validation} onSelectNode={setSelectedNodeId} />
    </aside>

    {historyOpen && <div className="ivr-history" role="dialog" aria-label="IVR version history">
      <header><span><History size={15} /><strong>Version history</strong></span><button title="Close version history" onClick={() => setHistoryOpen(false)}><X size={15} /></button></header>
      <div>{versions.map((item) => <article key={item.id}>
        <span><strong>v{item.version}</strong><small>{item.release_kind} · {formatDate(item.published_at)}</small></span>
        <button aria-label={`Rollback v${item.version}`} disabled={busy} onClick={() => void rollback(item.version)}><RefreshCw size={13} />Rollback</button>
      </article>)}</div>
    </div>}
    {error && <div className="ivr-error" role="alert"><span>{error}</span><button title="Dismiss IVR error" onClick={() => setError('')}><X size={14} /></button></div>}
    <span className="ivr-status-announcer" aria-live="polite">{status}</span>
  </section>;
}

function NodeInspector(props: {
  node: IvrFlowCanvasNode;
  onChange(patch: Partial<ConveractFabricIvrCanvasNode['data']>): void;
  onDelete(): void;
}) {
  const definition = IVR_NODE_DEFINITIONS.find((item) => item.type === props.node.data.ivr_type)!;
  const [advanced, setAdvanced] = useState(JSON.stringify(props.node.data.config, null, 2));
  const [jsonError, setJsonError] = useState('');
  useEffect(() => { setAdvanced(JSON.stringify(props.node.data.config, null, 2)); setJsonError(''); }, [props.node.id, props.node.data.config]);
  const changeConfig = (key: string, value: unknown) => props.onChange({
    config: { ...props.node.data.config, [key]: value }
  });
  return <>
    <header><span><GitBranch size={15} /><h2>{definition.label}</h2></span><button title="Delete selected node" disabled={props.node.data.ivr_type === 'start'} onClick={props.onDelete}><Trash2 size={14} /></button></header>
    <div className="ivr-inspector-body">
      <Field label="Node name"><input value={props.node.data.name} onChange={(event) => props.onChange({ name: event.target.value })} /></Field>
      <p className="ivr-node-description">{definition.description}</p>
      {Object.entries(props.node.data.config).map(([key, value]) => <ConfigField key={key} name={key} value={value} onChange={(next) => changeConfig(key, next)} />)}
      <Field label="Advanced configuration JSON">
        <textarea aria-label="Advanced configuration JSON" rows={9} value={advanced} onChange={(event) => {
          const next = event.target.value;
          setAdvanced(next);
          try {
            const parsed = parseJsonRecord(next, 'node configuration');
            setJsonError('');
            props.onChange({ config: parsed });
          } catch (cause) { setJsonError(errorMessage(cause)); }
        }} />
      </Field>
      {jsonError && <p className="ivr-field-error">{jsonError}</p>}
    </div>
  </>;
}

function FlowInspector(props: {
  graph: ConveractFabricIvrFlowGraph;
  onChange(patch: Partial<ConveractFabricIvrFlowGraph>): void;
}) {
  const variables = props.graph.variables;
  const shortcuts = Array.isArray(props.graph.globalShortcuts) ? props.graph.globalShortcuts : [];
  return <>
    <header><span><Braces size={15} /><strong>Flow settings</strong></span></header>
    <div className="ivr-inspector-body">
      <Field label="Entry node"><select value={props.graph.entryNodeId} onChange={(event) => props.onChange({ entryNodeId: event.target.value })}>
        {props.graph.nodes.map((nodeValue) => <option value={nodeValue.id} key={nodeValue.id}>{nodeValue.name}</option>)}
      </select></Field>
      <section className="ivr-variable-list"><div><strong>Variables</strong><button title="Add flow variable" onClick={() => props.onChange({ variables: [...variables, { name: `variable_${variables.length + 1}`, defaultValue: '' }] })}><Plus size={13} /></button></div>
        {variables.map((variable, index) => <div key={`${variable.name}-${index}`}>
          <input aria-label={`Variable ${index + 1} name`} value={variable.name} onChange={(event) => props.onChange({ variables: variables.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
          <input aria-label={`Variable ${index + 1} default`} value={String(variable.defaultValue ?? '')} onChange={(event) => props.onChange({ variables: variables.map((item, itemIndex) => itemIndex === index ? { ...item, defaultValue: event.target.value } : item) })} />
          <button title={`Remove variable ${variable.name}`} onClick={() => props.onChange({ variables: variables.filter((_, itemIndex) => itemIndex !== index) })}><X size={12} /></button>
        </div>)}
      </section>
      <JsonEditor label="Global shortcuts JSON" value={shortcuts} onChange={(value) => props.onChange({ globalShortcuts: value })} array />
    </div>
  </>;
}

function ConfigField(props: { name: string; value: unknown; onChange(value: unknown): void }) {
  const options = selectOptions(props.name);
  if (typeof props.value === 'boolean') return <label className="ivr-check-field"><input type="checkbox" checked={props.value} onChange={(event) => props.onChange(event.target.checked)} /><span>{humanize(props.name)}</span></label>;
  if (typeof props.value === 'number') return <Field label={humanize(props.name)}><input type="number" value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} /></Field>;
  if (typeof props.value === 'string' && options) return <Field label={humanize(props.name)}><select value={props.value} onChange={(event) => props.onChange(event.target.value)}>{options.map((option) => <option value={option} key={option}>{humanize(option)}</option>)}</select></Field>;
  if (typeof props.value === 'string') return <Field label={humanize(props.name)}><input value={props.value} onChange={(event) => props.onChange(event.target.value)} /></Field>;
  return <JsonEditor label={humanize(props.name)} value={props.value} onChange={props.onChange} array={Array.isArray(props.value)} />;
}

function JsonEditor(props: { label: string; value: unknown; onChange(value: never): void; array?: boolean }) {
  const [text, setText] = useState(JSON.stringify(props.value, null, 2));
  const [error, setError] = useState('');
  useEffect(() => setText(JSON.stringify(props.value, null, 2)), [props.value]);
  return <Field label={props.label}><textarea rows={5} value={text} onChange={(event) => {
    setText(event.target.value);
    try {
      const parsed = JSON.parse(event.target.value);
      if (props.array ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('wrong JSON shape');
      setError('');
      props.onChange(parsed as never);
    } catch { setError('Invalid JSON'); }
  }} />{error && <small className="ivr-field-error">{error}</small>}</Field>;
}

function ValidationPanel(props: { report: ConveractFabricIvrCompilationReport | null; onSelectNode(id: string): void }) {
  if (!props.report) return <section className="ivr-validation"><header><CheckCircle2 size={13} /><strong>Validation</strong></header><p>Run server validation before publishing.</p></section>;
  const issues = [
    ...props.report.errors.map((issue) => ({ issue, severity: 'error' })),
    ...props.report.warnings.map((issue) => ({ issue, severity: 'warning' }))
  ];
  return <section className="ivr-validation"><header><CheckCircle2 size={13} /><strong>Validation</strong><span>{props.report.errors.length}/{props.report.warnings.length}</span></header>
    {!issues.length ? <p className="passed">Validation passed</p> : <div>{issues.map(({ issue, severity }, index) => {
      const nodeId = issueNodeId(issue);
      return <button key={`${issueCode(issue)}-${index}`} className={severity} disabled={!nodeId} onClick={() => nodeId && props.onSelectNode(nodeId)}>
        <strong>{issueCode(issue)}</strong><span>{issueMessage(issue)}</span>
      </button>;
    })}</div>}
  </section>;
}

function SimulationPanel(props: {
  flow: ConveractFabricIvrFlow | null;
  script: string;
  variables: string;
  result: ConveractFabricIvrSimulationResult | null;
  busy: boolean;
  onScript(value: string): void;
  onVariables(value: string): void;
  onRun(): void;
}) {
  return <section className="ivr-simulator">
    <header><span><FlaskConical size={14} /><strong>Deterministic simulation</strong></span><button title="Run deterministic simulation" disabled={props.busy || !props.flow} onClick={props.onRun}><ChevronRight size={14} />Run</button></header>
    <div className="ivr-simulation-inputs">
      <Field label="Simulation script"><textarea aria-label="Simulation script" rows={3} value={props.script} onChange={(event) => props.onScript(event.target.value)} /></Field>
      <Field label="Initial variables"><textarea aria-label="Initial variables" rows={3} value={props.variables} onChange={(event) => props.onVariables(event.target.value)} /></Field>
    </div>
    <div className="ivr-simulation-result">
      {!props.result ? <p>Simulation runs the currently published version with explicit provider events.</p> : <>
        <header><strong>{props.result.status}</strong><span><Clock3 size={12} />{props.result.elapsed_ms} ms</span><span>{props.result.steps.length} steps</span></header>
        <div>{props.result.trace.map((entry, index) => <span key={index}>{traceAction(entry)}<small>{String(entry.event_at ?? '')}</small></span>)}</div>
      </>}
    </div>
  </section>;
}

function Field(props: { label: string; children: ReactNode }) {
  return <label className="ivr-field"><span>{props.label}</span>{props.children}</label>;
}

function selectOptions(key: string): string[] | null {
  const values: Record<string, string[]> = {
    action: ['start', 'pause', 'resume', 'stop'],
    complianceType: ['ai_disclosure', 'recording_consent', 'privacy_notice'],
    dimension: ['score', 'keyword', 'emotion'],
    direction: ['voice_to_video', 'video_to_voice'],
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    noAnswerAction: ['continue', 'transfer', 'voicemail'],
    source: ['agent', 'ai'],
    target_type: ['extension', 'queue', 'ring_group', 'phone'],
    value_type: ['string', 'expression']
  };
  return values[key] ?? null;
}

function parseJsonArray(value: string, label: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError(`invalid ${label} JSON`); }
  if (!Array.isArray(parsed)) throw new TypeError(`${label} must be an array`);
  return parsed;
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError(`invalid ${label} JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function issueNodeId(issue: ValidationIssue): string { return typeof issue.node_id === 'string' ? issue.node_id : ''; }
function issueCode(issue: ValidationIssue): string { return typeof issue.code === 'string' ? issue.code : 'validation_issue'; }
function issueMessage(issue: ValidationIssue): string { return typeof issue.message === 'string' ? issue.message : issueCode(issue); }
function traceAction(entry: Record<string, unknown>): string {
  const action = entry.action;
  return action && typeof action === 'object' && !Array.isArray(action)
    && typeof (action as Record<string, unknown>).kind === 'string'
    ? String((action as Record<string, unknown>).kind) : 'event';
}
function edgeId(source: string, handle: string | null, target: string): string {
  return `edge_${source}_${handle || 'out'}_${target}_${Math.random().toString(36).slice(2, 8)}`;
}
function commandId(prefix: string): string { return `${prefix}-${globalThis.crypto.randomUUID()}`; }
function humanize(value: string): string { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function safeFilename(value: string): string { return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80); }
function formatDate(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; }
function errorMessage(cause: unknown): string { return cause instanceof Error && cause.message ? cause.message : 'IVR operation failed'; }
