import { IVR_NODE_METADATA, type IvrNodeType } from './types';

const CATEGORIES: Array<{ title: string; category: 'traditional' | 'ai' | 'video' }> = [
  { title: '传统 IVR 节点', category: 'traditional' },
  { title: 'AI 节点', category: 'ai' },
  { title: '视频 / 增强', category: 'video' },
];

/**
 * Left-side palette: lists all 23 node types grouped by category.
 * Draggable items — onDrop in the parent creates a new node.
 */
export function NodePalette({ onDragStart }: { onDragStart: (type: IvrNodeType) => void }) {
  return (
    <div className="w-48 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto max-h-full">
      {CATEGORIES.map((group) => (
        <div key={group.category} className="p-3 border-b border-gray-100">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            {group.title}
          </p>
          <div className="space-y-1.5">
            {Object.values(IVR_NODE_METADATA)
              .filter((m) => m.category === group.category)
              .map((meta) => (
                <div
                  key={meta.type}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/ivr-node', meta.type);
                    onDragStart(meta.type);
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-white border border-gray-200 hover:border-blue-300 hover:shadow-sm cursor-grab active:cursor-grabbing transition-all"
                >
                  <span className={`w-6 h-6 rounded flex items-center justify-center text-xs text-white ${meta.color}`}>
                    {meta.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-800 truncate">{meta.label}</p>
                    <p className="text-[10px] text-gray-400 truncate">{meta.description}</p>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
