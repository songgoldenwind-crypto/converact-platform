import type { IvrFlowGraph } from './types';

export interface SimulateResult {
  steps: Array<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    action: {
      kind: string;
      text?: string;
      prompt?: string;
      targetType?: string;
      targetValue?: string;
      variable?: string;
      value?: string;
    };
    nextNodeId: string | null;
    variables: Record<string, string>;
  }>;
  finalNodeId: string | null;
  terminated: boolean;
  error?: string;
  /** Present when API discloses that live transfer/recording side effects were not run */
  simulationNote?: string;
}

export async function runSimulation(
  graph: IvrFlowGraph,
  dtmfSequence: string[] = ['1'],
  variables: Record<string, string> = {}
): Promise<SimulateResult> {
  const res = await fetch('/api/ivr/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ graph, input: { dtmfSequence, variables } }),
  });
  const json = await res.json();
  if (!res.ok) {
    const errMsg =
      (typeof json.error === 'object' && json.error?.message) ||
      json.data?.error ||
      json.error ||
      res.statusText;
    throw new Error(String(errMsg));
  }
  return (json.data ?? json) as SimulateResult;
}
