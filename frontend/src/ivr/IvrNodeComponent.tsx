import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { IVR_NODE_METADATA, getNodeOutputHandles, getNodeSummary, nodeAcceptsInboundEdge, type IvrNode } from './types';

/**
 * A single IVR node rendered on the React Flow canvas.
 * Shows icon, label, and a summary of the node's configuration.
 * Has source/target handles positioned for left-to-right flow.
 */
function IvrNodeComponentInner({ data, selected }: NodeProps) {
  const node = data as unknown as IvrNode & { hasValidationIssue?: boolean };
  const meta = IVR_NODE_METADATA[node.type];
  if (!meta) return null;
  const summary = getNodeSummary(node);
  const outputHandles = getNodeOutputHandles(node);
  const issue = node.hasValidationIssue === true;

  return (
    <div
      className={`relative rounded-lg border-2 bg-white shadow-sm min-w-[160px] max-w-[220px] transition-all ${
        issue
          ? 'border-red-500 ring-2 ring-red-200'
          : selected
            ? 'border-blue-500 shadow-md ring-2 ring-blue-200'
            : 'border-gray-200'
      }`}
      style={{ minHeight: outputHandles.length > 3 ? `${56 + outputHandles.length * 22}px` : undefined }}
    >
      {nodeAcceptsInboundEdge(node) && (
        <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-gray-400" />
      )}

      <div className={`${meta.color} text-white px-3 py-1.5 rounded-t-md flex items-center gap-2`}>
        <span className="text-sm">{meta.icon}</span>
        <span className="text-xs font-medium truncate">{node.name || meta.label}</span>
      </div>

      <div className="px-3 py-2">
        <p className="text-[10px] text-gray-500 mb-1">{meta.label}</p>
        {summary && (
          <p className="text-xs text-gray-700 font-mono truncate" title={summary}>
            {summary}
          </p>
        )}
      </div>

      {outputHandles.length === 1 && (
        <Handle id={outputHandles[0]} type="source" position={Position.Right} className="!w-3 !h-3 !bg-gray-400" />
      )}
      {outputHandles.length > 1 &&
        outputHandles.map((handle, idx) => (
          <div
            key={handle}
            className="absolute right-0"
            style={{ top: `${30 + idx * 22}px` }}
          >
            <Handle
              id={handle}
              type="source"
              position={Position.Right}
              className="!w-2.5 !h-2.5 !bg-gray-400"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[9px] text-gray-500 whitespace-nowrap max-w-[72px] truncate">
              {handle}
            </span>
          </div>
        ))}
    </div>
  );
}

export const IvrNodeComponent = memo(IvrNodeComponentInner);
