import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type {
  IveKitIvrCompilationReport,
  IveKitIvrFlow,
  IveKitIvrFlowGraph,
  IveKitIvrFlowVersion,
  IveKitIvrHttpClient,
  IveKitIvrSimulationResult
} from '@opc/ivekit-sdk';

import { installTestDom } from '../test-dom.js';

const closeDom = installTestDom();
installCanvasObservers();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { IvrDesignerWorkspace } = await import('./ivr-designer-workspace.js');

after(() => { cleanup(); closeDom(); });
afterEach(() => cleanup());

test('IVR Designer loads, edits, saves, validates, and publishes through the typed SDK', async () => {
  const requests: string[] = [];
  const client = fakeIvrClient(requests);
  const selected: string[] = [];
  const view = render(<IvrDesignerWorkspace
    client={{ ivr: client }}
    flowId="flow-a"
    onFlowIdChange={(value) => selected.push(value)}
  />);

  await waitFor(() => assert.equal((view.getByLabelText('Flow name') as HTMLInputElement).value, 'Support flow'));
  assert.equal(view.container.querySelectorAll('.ivr-palette button').length, 25);
  fireEvent.change(view.getByLabelText('Flow name'), { target: { value: 'Support flow v2' } });
  fireEvent.click(view.getByRole('button', { name: 'Add Play audio' }));
  assert.ok(view.getByRole('heading', { name: 'Play audio' }));

  await act(async () => { fireEvent.click(view.getByTitle('Save flow draft')); });
  await waitFor(() => assert.ok(requests.includes('update:flow-a:1:3')));
  await act(async () => { fireEvent.click(view.getByTitle('Validate current draft')); });
  await waitFor(() => assert.ok(requests.includes('validate:flow-a')));
  assert.ok(view.getAllByText('Validation passed').length >= 1);

  await act(async () => { fireEvent.click(view.getByTitle('Publish current draft')); });
  await waitFor(() => assert.ok(requests.includes('publish:flow-a:2')));
  assert.ok(view.getAllByText('Published v2').length >= 1);
  assert.deepEqual(selected, []);
});

test('IVR Designer rolls back immutable history and displays deterministic simulation output', async () => {
  const requests: string[] = [];
  const view = render(<IvrDesignerWorkspace
    client={{ ivr: fakeIvrClient(requests) }}
    flowId="flow-a"
    onFlowIdChange={() => undefined}
  />);
  await waitFor(() => assert.ok(view.getByText('Support flow')));

  await act(async () => { fireEvent.click(view.getByTitle('Show version history')); });
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Rollback v1' })));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Rollback v1' })); });
  await waitFor(() => assert.ok(requests.includes('rollback:flow-a:1:1')));
  assert.ok(view.getAllByText('Rolled back as v2').length >= 1);

  fireEvent.change(view.getByLabelText('Simulation script'), {
    target: { value: '[{"event":{"type":"action_succeeded","result":{}}}]' }
  });
  await act(async () => { fireEvent.click(view.getByTitle('Run deterministic simulation')); });
  await waitFor(() => assert.ok(requests.includes('simulate:flow-a:1')));
  assert.ok(view.getByText('completed'));
  assert.ok(view.getByText('hangup'));
});

test('IVR Designer preserves dirty work when a server event arrives and reloads only on command', async () => {
  const requests: string[] = [];
  const client = { ivr: fakeIvrClient(requests) };
  const view = render(<IvrDesignerWorkspace
    client={client}
    flowId="flow-a"
    refreshVersion={0}
    onFlowIdChange={() => undefined}
  />);
  await waitFor(() => assert.equal((view.getByLabelText('Flow name') as HTMLInputElement).value, 'Support flow'));
  fireEvent.change(view.getByLabelText('Flow name'), { target: { value: 'Unsaved local name' } });

  view.rerender(<IvrDesignerWorkspace
    client={client}
    flowId="flow-a"
    refreshVersion={1}
    onFlowIdChange={() => undefined}
  />);

  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Server update available')));
  assert.equal((view.getByLabelText('Flow name') as HTMLInputElement).value, 'Unsaved local name');
  assert.equal(requests.filter((request) => request === 'get:flow-a').length, 1);

  const confirm = window.confirm;
  window.confirm = () => true;
  try {
    fireEvent.click(view.getByTitle('Reload flow from server'));
    await waitFor(() => assert.equal(requests.filter((request) => request === 'get:flow-a').length, 2));
    await waitFor(() => assert.equal((view.getByLabelText('Flow name') as HTMLInputElement).value, 'Support flow'));
  } finally {
    window.confirm = confirm;
  }
});

function fakeIvrClient(requests: string[]): IveKitIvrHttpClient {
  let current = flow();
  return {
    async listFlows() { requests.push('list'); return [current]; },
    async createFlow(input) { requests.push(`create:${input.name}`); current = { ...current, name: input.name, draft_graph: input.graph }; return current; },
    async getFlow(id) { requests.push(`get:${id}`); return current; },
    async updateFlow(id, input) {
      requests.push(`update:${id}:${input.expected_revision}:${input.graph?.nodes.length ?? 0}`);
      current = {
        ...current,
        name: input.name ?? current.name,
        draft_graph: input.graph ?? current.draft_graph,
        draft_revision: current.draft_revision + 1
      };
      return current;
    },
    async listVersions(id) { requests.push(`versions:${id}`); return [version(1)]; },
    async validateFlow(id) { requests.push(`validate:${id}`); return compilation(current.draft_graph); },
    async publishFlow(id, expected) {
      requests.push(`publish:${id}:${expected}`);
      current = { ...current, status: 'published', current_published_version: 2 };
      return { flow: current, version: version(2), replayed: false };
    },
    async rollbackFlow(id, input) {
      requests.push(`rollback:${id}:${input.expected_draft_revision}:${input.source_version}`);
      current = { ...current, status: 'published', current_published_version: 2 };
      return { flow: current, version: version(2), replayed: false };
    },
    async simulate(input) {
      const script = input.script as unknown[];
      requests.push(`simulate:${input.flow_id}:${script.length}`);
      return simulation();
    },
    async listSessions() { return []; }, async startSession() { throw new Error('unused'); },
    async getSession() { throw new Error('unused'); }, async advanceSession() { throw new Error('unused'); },
    async listAudioAssets() { return []; }, async createAudioAsset() { throw new Error('unused'); },
    async getAudioAsset() { throw new Error('unused'); }, async updateAudioAsset() { throw new Error('unused'); },
    async listTimeGroups() { return []; }, async createTimeGroup() { throw new Error('unused'); },
    async getTimeGroup() { throw new Error('unused'); }, async updateTimeGroup() { throw new Error('unused'); },
    async listRegionGroups() { return []; }, async createRegionGroup() { throw new Error('unused'); },
    async getRegionGroup() { throw new Error('unused'); }, async updateRegionGroup() { throw new Error('unused'); },
    async listRingGroups() { return []; }, async createRingGroup() { throw new Error('unused'); },
    async getRingGroup() { throw new Error('unused'); }, async updateRingGroup() { throw new Error('unused'); },
    async getSettings() { throw new Error('unused'); }, async updateSettings() { throw new Error('unused'); }
  };
}

function graph(): IveKitIvrFlowGraph {
  return {
    version: 1, entryNodeId: 'start', variables: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 40, y: 80 }, data: {} },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 340, y: 80 }, data: {} }
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end', sourceHandle: 'out' }]
  };
}

function flow(): IveKitIvrFlow {
  return {
    id: 'flow-a', tenant_id: 'tenant-a', name: 'Support flow', status: 'draft',
    draft_graph: graph(), draft_revision: 1, current_published_version: 1, metadata: {},
    created_by: 'admin-a', updated_by: 'admin-a',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z'
  };
}

function version(number: number): IveKitIvrFlowVersion {
  return {
    id: `version-${number}`, tenant_id: 'tenant-a', flow_id: 'flow-a', version: number,
    graph: graph(), graph_hash: 'a'.repeat(64), release_kind: number === 1 ? 'publish' : 'rollback',
    source_version: number === 1 ? null : 1, published_by: 'admin-a',
    published_at: '2026-07-13T00:00:00.000Z'
  };
}

function compilation(value: IveKitIvrFlowGraph): IveKitIvrCompilationReport {
  return { normalized_graph: value, graph_hash: 'a'.repeat(64), errors: [], warnings: [], dependencies: {} };
}

function simulation(): IveKitIvrSimulationResult {
  return {
    status: 'completed',
    session: {
      id: 'simulation-a', tenant_id: 'tenant-a', call_id: 'simulation', flow_id: 'flow-a',
      flow_version: 1, state: 'completed', current_node_id: 'end', context: {}, step_count: 2, revision: 2
    },
    action: null, steps: [{ node_id: 'start' }, { node_id: 'end' }],
    trace: [{ action: { kind: 'hangup' }, event_at: '2026-07-13T00:00:00.010Z' }],
    elapsed_ms: 10, remaining_script_entries: 0
  };
}

function installCanvasObservers(): void {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: Observer });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  const request = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
  const cancel = (handle: number) => window.clearTimeout(handle);
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: request });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cancel });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: request });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: cancel });
}
