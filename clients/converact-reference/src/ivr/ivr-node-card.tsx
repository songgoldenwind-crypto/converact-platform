import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';

import {
  IVR_NODE_DEFINITIONS,
  ivrNodeOutputHandles,
  type IveKitIvrCanvasNode
} from './ivr-designer-model.js';

export type IvrFlowCanvasNode = Node<IveKitIvrCanvasNode['data'], 'ivr'>;

const definitions = new Map(IVR_NODE_DEFINITIONS.map((definition) => [definition.type, definition]));

function IvrNodeCardComponent({ data, selected }: NodeProps<IvrFlowCanvasNode>) {
  const definition = definitions.get(data.ivr_type);
  const handles = ivrNodeOutputHandles({ type: data.ivr_type, data: data.config });
  if (!definition) return null;
  return <article
    className={`ivr-node-card node-${definition.category}${selected ? ' selected' : ''}${data.issue_count ? ' invalid' : ''}`}
    style={{ minHeight: handles.length > 3 ? 60 + handles.length * 21 : undefined }}
  >
    {data.ivr_type !== 'start' && <Handle type="target" position={Position.Left} />}
    <header><strong>{data.name || definition.label}</strong><span>{definition.label}</span></header>
    <p>{nodeSummary(data.config) || definition.description}</p>
    {data.issue_count ? <output>{data.issue_count}</output> : null}
    {handles.length === 1 && <Handle id={handles[0]} type="source" position={Position.Right} />}
    {handles.length > 1 && handles.map((handle, index) => <div
      className="ivr-node-handle"
      key={handle}
      style={{ top: 47 + index * 21 }}
    >
      <span>{handle}</span><Handle id={handle} type="source" position={Position.Right} />
    </div>)}
  </article>;
}

export const IvrNodeCard = memo(IvrNodeCardComponent);

function nodeSummary(config: Record<string, unknown>): string {
  for (const key of [
    'text', 'prompt', 'queue_id', 'target_ref', 'webhook_ref', 'flow_id',
    'ai_profile_id', 'knowledge_profile_id', 'action', 'reason'
  ]) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 72);
  }
  return '';
}
