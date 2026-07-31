import { createHash } from 'node:crypto';
import type { JsonRecord, ProviderSelection } from '../integrations/provider-runtime-types.js';

interface ModelGatewayOptions {
  runStore: ModelRunStore;
  hookManager?: HookManagerLike | null;
  providerRegistryStore?: ProviderRegistryLike | null;
  defaultProvider?: string;
  defaultModel?: string;
}

interface ModelContext {
  tenantId: string;
  workspaceId?: string;
  userId?: string;
  workflowRunId?: string | null;
  agentRunId?: string | null;
  sessionKey?: string;
  channel?: string;
}

interface ModelAdapter {
  complete: (request: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface ModelRunStore {
  recordModelCall: (input: JsonRecord) => JsonRecord;
  updateModelCall: (tenantId: string, modelCallId: string, patch: JsonRecord) => JsonRecord;
  audit: (
    tenantId: string,
    action: string,
    objectType: string,
    objectId: string,
    payload?: JsonRecord,
    actorId?: string
  ) => JsonRecord | void;
}

interface HookManagerLike {
  run?: (hookName: string, payload: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface ProviderRegistryLike {
  integrationConfigStore?: {
    getConfig?: (tenantId: string, workspaceId: string, integrationId: string) => JsonRecord | null;
  };
  previewSelection: (input: JsonRecord) => ProviderSelection;
}

interface RoutingResult {
  provider: string;
  model: string;
  selection: ProviderSelection | null;
}

export class ModelGateway {
  runStore: ModelRunStore;
  hookManager: HookManagerLike | null;
  providerRegistryStore: ProviderRegistryLike | null;
  defaultProvider: string;
  defaultModel: string;
  adapters: Map<string, ModelAdapter>;

  constructor({
    runStore,
    hookManager = null,
    providerRegistryStore = null,
    defaultProvider = 'dry_run',
    defaultModel = 'dry-run-v1'
  }: ModelGatewayOptions) {
    this.runStore = runStore;
    this.hookManager = hookManager;
    this.providerRegistryStore = providerRegistryStore;
    this.defaultProvider = defaultProvider;
    this.defaultModel = defaultModel;
    this.adapters = new Map();
  }

  registerAdapter(provider: string, adapter: ModelAdapter): void {
    if (!provider) throw new Error('model provider is required');
    if (!adapter || typeof adapter.complete !== 'function') throw new Error(`model adapter must implement complete(): ${provider}`);
    this.adapters.set(provider, adapter);
  }

  async complete(context: ModelContext, request: JsonRecord = {}): Promise<JsonRecord> {
    if (!context?.tenantId) throw new Error('tenantId is required for model calls');
    const routing = this.resolveRouting(context, request);
    const provider = routing.provider;
    const model = routing.model;
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`model adapter not registered: ${provider}`);
    const resolvedRequest: JsonRecord = { ...request, provider, model, provider_selection: summarizeSelection(routing.selection) };

    const modelCall = this.runStore.recordModelCall({
      tenant_id: context.tenantId,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      provider,
      model,
      purpose: resolvedRequest.purpose || 'default',
      status: 'created',
      prompt_hash: hashPrompt(resolvedRequest),
      input: redactRequest(resolvedRequest)
    });

    await this.hookManager?.run?.('before_model_call', {
      context,
      request: resolvedRequest,
      modelCall
    });

    try {
      this.runStore.updateModelCall(context.tenantId, modelCall.id, {
        status: 'running',
        started_at: new Date().toISOString()
      });
      const output = await adapter.complete({
        ...resolvedRequest,
        provider,
        model,
        tenant_id: context.tenantId,
        workspace_id: context.workspaceId || 'default',
        user_id: context.userId || 'system',
        workflow_run_id: context.workflowRunId || null,
        agent_run_id: context.agentRunId || null
      });
      const finished = this.runStore.updateModelCall(context.tenantId, modelCall.id, {
        status: 'success',
        output,
        usage: output.usage || {},
        cost: output.cost || {},
        finished_at: new Date().toISOString()
      });
      this.runStore.audit(context.tenantId, 'model.call_completed', 'model_call', modelCall.id, {
        provider,
        model,
        purpose: resolvedRequest.purpose || 'default',
        selection_basis: routing.selection?.selection_basis || 'explicit',
        policy_id: routing.selection?.policy_overlay?.policy_id || null
      });
      const result = { status: 'success', output, model_call: finished };
      await this.hookManager?.run?.('after_model_call', {
        context,
        request: resolvedRequest,
        modelCall: finished,
        result
      });
      return result;
    } catch (error: any) {
      const failed = this.runStore.updateModelCall(context.tenantId, modelCall.id, {
        status: 'failed',
        error: { name: error.name, message: error.message },
        finished_at: new Date().toISOString()
      });
      await this.hookManager?.run?.('on_model_call_failed', {
        context,
        request: resolvedRequest,
        modelCall: failed,
        error
      });
      if (!request.__fallbackAttempt && (request.fallback_provider || request.fallback_model)) {
        this.runStore.audit(context.tenantId, 'model.call_fallback_started', 'model_call', modelCall.id, {
          provider,
          model,
          fallback_provider: request.fallback_provider || provider,
          fallback_model: request.fallback_model || model,
          reason: error.message
        }, context.userId || 'system');
        return this.complete(context, {
          ...request,
          provider: request.fallback_provider || provider,
          model: request.fallback_model || model,
          __fallbackAttempt: true
        });
      }
      throw error;
    }
  }

  resolveRouting(context: ModelContext, request: JsonRecord = {}): RoutingResult {
    const explicitProvider = request.provider && !['auto', 'tenant_default'].includes(request.provider);
    if (explicitProvider || !['auto', 'tenant_default'].includes(request.provider) || !this.providerRegistryStore) {
      const provider = String(request.provider || this.defaultProvider);
      return {
        provider,
        model: this.resolveModelName(context, provider, request),
        selection: null
      };
    }

    const selection = this.providerRegistryStore.previewSelection({
      tenant_id: context.tenantId,
      workspace_id: context.workspaceId || 'default',
      category: 'model_provider',
      capability: request.capability || 'chat_completion',
      use_case: request.use_case || request.purpose || '',
      preferred_ids: request.preferred_provider_ids || request.preferred_ids || [],
      blocked_ids: request.blocked_provider_ids || request.blocked_ids || [],
      allow_fallback: request.allow_provider_fallback ?? true
    });
    const provider = selection.selected?.integration_id || this.defaultProvider;
    return {
      provider,
      model: this.resolveModelName(context, provider, request),
      selection
    };
  }

  resolveModelName(context: ModelContext, provider: string, request: JsonRecord = {}): string {
    if (request.model) return String(request.model);
    if (provider === this.defaultProvider) return this.defaultModel;
    const config = this.providerRegistryStore?.integrationConfigStore?.getConfig?.(
      context.tenantId,
      context.workspaceId || 'default',
      provider
    );
    return config?.config?.default_model || config?.config?.model || 'unresolved_model';
  }
}

function hashPrompt(request: JsonRecord): string {
  return createHash('sha256').update(JSON.stringify(redactRequest(request))).digest('hex');
}

function redactRequest(request: JsonRecord = {}): JsonRecord {
  const { api_key, apiKey, secret, ...safe } = request || {};
  return safe;
}

function summarizeSelection(selection: ProviderSelection | null): JsonRecord | null {
  if (!selection) return null;
  return {
    selected_integration_id: selection.selected?.integration_id || null,
    selection_basis: selection.selection_basis,
    policy_id: selection.policy_overlay?.policy_id || null
  };
}
