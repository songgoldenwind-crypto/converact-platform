import type { JsonRecord } from '../integrations/provider-runtime-types.js';

interface ProviderRegistryForModel {
  executeProviderOperation: (input: JsonRecord) => Promise<JsonRecord>;
}

export class ProviderModelAdapter {
  providerRegistryStore: ProviderRegistryForModel;
  integrationId: string;

  constructor(providerRegistryStore: ProviderRegistryForModel, integrationId: string) {
    this.providerRegistryStore = providerRegistryStore;
    this.integrationId = integrationId;
  }

  async complete(request: JsonRecord): Promise<JsonRecord> {
    if (!request.tenant_id && !request.tenantId) throw new Error('tenant_id is required for live model provider calls');
    const tenantId = request.tenant_id || request.tenantId;
    const workspaceId = request.workspace_id || request.workspaceId || 'default';
    const result = await this.providerRegistryStore.executeProviderOperation({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      integration_id: request.integration_id || this.integrationId,
      operation: 'model.complete',
      required_secret_keys: request.required_secret_keys || ['api_key'],
      payload: {
        model: request.model,
        messages: request.messages,
        prompt: request.prompt,
        input: request.input,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        max_output_tokens: request.max_output_tokens,
        response_format: request.response_format
      },
      actor_id: request.user_id || request.userId || 'system'
    });
    return {
      ...result,
      provider: request.provider || this.integrationId,
      model: result.model || request.model
    };
  }
}
