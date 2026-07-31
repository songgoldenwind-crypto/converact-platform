import { validateToolDefinition } from '../contracts.js';
import type { AgentLikeForToolFiltering, ToolDefinition, ToolHandler, ToolRegistryEntry } from '../runtime-domain-types.js';

export class ToolRegistry {
  tools: Map<string, ToolRegistryEntry>;

  constructor() {
    this.tools = new Map<string, ToolRegistryEntry>();
  }

  register(definition: ToolDefinition, handler: ToolHandler): ToolDefinition {
    if (typeof handler !== 'function') throw new Error(`handler is required for ${definition?.tool_id || 'tool'}`);
    const normalized = validateToolDefinition(definition) as ToolDefinition;
    if (this.tools.has(normalized.tool_id)) throw new Error(`duplicate tool_id: ${normalized.tool_id}`);
    this.tools.set(normalized.tool_id, { definition: normalized, handler });
    return normalized;
  }

  get(toolId: string): ToolRegistryEntry {
    const entry = this.tools.get(toolId);
    if (!entry) throw new Error(`tool not registered: ${toolId}`);
    return entry;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((entry) => entry.definition);
  }

  listForManifest(manifest: AgentLikeForToolFiltering): ToolDefinition[] {
    const allowedToolsets = new Set(manifest.allowed_toolsets || []);
    const forbiddenTools = new Set(manifest.forbidden_tools || []);
    return this.list().filter((tool) => allowedToolsets.has(tool.toolset) && !forbiddenTools.has(tool.tool_id));
  }
}
