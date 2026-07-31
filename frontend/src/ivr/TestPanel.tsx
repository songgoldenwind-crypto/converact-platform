import { useState } from 'react';
import type { IvrFlowGraph } from './types';
import { runSimulation, type SimulateResult } from './simulate-flow';

interface Props {
  graph: IvrFlowGraph | null;
  activeNodeId: string | null;
}

/**
 * Test panel: input DTMF sequence, run simulation, show trace + assertions.
 */
export function TestPanel({ graph, activeNodeId }: Props) {
  const [dtmfInput, setDtmfInput] = useState('');
  const [varsInput, setVarsInput] = useState('');
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runTest() {
    if (!graph) { setError('请先创建或加载流程'); return; }
    setLoading(true);
    setError('');
    try {
      const dtmf = dtmfInput.split(/[,\s]+/).filter(Boolean);
      const variables: Record<string, string> = {};
      if (varsInput.trim()) {
        varsInput.split(/[,\n]/).forEach((pair) => {
          const [k, v] = pair.split('=').map((s) => s.trim());
          if (k) variables[k] = v || '';
        });
      }
      setResult(await runSimulation(graph, dtmf, variables));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border-t border-gray-200 bg-slate-50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-700">自动测试</h3>
        {graph && <span className="text-xs text-gray-400">{graph.nodes.length} 节点</span>}
      </div>
      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
        模拟不执行真实转接/录音；有出边的转接会在轨迹中自动完成，结果不等于生产桥接。
      </p>

      {/* Input */}
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-xs text-gray-500">
          DTMF 序列
          <input
            className="ml-1 text-sm border border-gray-300 rounded px-2 py-1 w-32"
            placeholder="1,2,0"
            value={dtmfInput}
            onChange={(e) => setDtmfInput(e.target.value)}
          />
        </label>
        <label className="text-xs text-gray-500">
          变量 (key=val,key2=val2)
          <input
            className="ml-1 text-sm border border-gray-300 rounded px-2 py-1 w-48"
            placeholder="vip=yes,公司名=OPC"
            value={varsInput}
            onChange={(e) => setVarsInput(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => void runTest()}
          disabled={loading || !graph}
          className="bg-indigo-600 text-white text-sm px-4 py-1.5 rounded-md hover:bg-indigo-700 disabled:opacity-40"
        >
          {loading ? '运行中…' : '运行测试'}
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* Result: step trace */}
      {result && (
        <div className="space-y-2">
          <div className="flex gap-3 text-xs">
            <span className={result.terminated ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
              {result.terminated ? '✓ 到达终端' : '✗ 未到达终端'}
            </span>
            {result.finalNodeId && (
              <span className="text-gray-600">终节点: {result.steps.find((s) => s.nodeId === result.finalNodeId)?.nodeName || result.finalNodeId}</span>
            )}
            {result.error && <span className="text-red-500">{result.error}</span>}
          </div>
          {result.simulationNote ? (
            <p className="text-xs text-amber-700">{result.simulationNote}</p>
          ) : null}

          {/* Step list */}
          <div className="bg-white border border-gray-200 rounded-md p-2 max-h-48 overflow-y-auto">
            <div className="space-y-1">
              {result.steps.map((step, idx) => {
                const isActive = step.nodeId === activeNodeId;
                return (
                  <div
                    key={idx}
                    className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                      isActive ? 'bg-blue-100 ring-1 ring-blue-300' : 'bg-gray-50'
                    }`}
                  >
                    <span className="text-gray-400 w-4 text-right">{idx + 1}</span>
                    <span className="font-medium text-gray-700 w-20 truncate">{step.nodeName}</span>
                    <span className="text-gray-500">{step.nodeType}</span>
                    <span className="text-gray-600 flex-1 truncate">
                      {step.action.text || step.action.prompt || step.action.targetValue || step.action.variable || step.action.kind}
                    </span>
                    {step.nextNodeId && (
                      <span className="text-gray-400">→ {result.steps.find((s) => s.nodeId === step.nextNodeId)?.nodeName || step.nextNodeId}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Final variables */}
          {Object.keys(result.steps[result.steps.length - 1]?.variables || {}).length > 0 && (
            <div className="text-xs text-gray-500">
              变量: {Object.entries(result.steps[result.steps.length - 1].variables).map(([k, v]) => `${k}=${v}`).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
