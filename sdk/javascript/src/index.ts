export interface OPCClientConfig {
  baseUrl: string;
  apiKey?: string;
  token?: string;
}

export class OPCClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: OPCClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) this.headers['X-API-Key'] = config.apiKey;
    if (config.token) this.headers['Authorization'] = `Bearer ${config.token}`;
  }

  async getDashboard(tenantId: string) {
    return this.get(`/api/call-center/dashboard?tenant_id=${tenantId}`);
  }

  async createOutboundTask(input: { tenant_id: string; phone_number: string; channel: string; scheduled_at?: string }) {
    return this.post('/api/call-center/outbound-tasks', input);
  }

  async listOutboundTasks(tenantId: string, status?: string) {
    const qs = status ? `&status=${status}` : '';
    return this.get(`/api/call-center/outbound-tasks?tenant_id=${tenantId}${qs}`);
  }

  async listAgentSeats(tenantId: string) {
    return this.get(`/api/call-center/seats?tenant_id=${tenantId}`);
  }

  async triggerQmEvaluation(tenantId: string, callSessionId: string) {
    return this.post('/api/qm/evaluate', { tenant_id: tenantId, call_session_id: callSessionId });
  }

  async listQmEvaluations(tenantId: string, opts?: { minScore?: number; maxScore?: number }) {
    let qs = `?tenant_id=${tenantId}`;
    if (opts?.minScore !== undefined) qs += `&min_score=${opts.minScore}`;
    if (opts?.maxScore !== undefined) qs += `&max_score=${opts.maxScore}`;
    return this.get(`/api/qm/evaluations${qs}`);
  }

  async askKnowledgeBase(tenantId: string, question: string, knowledgeBaseId?: string) {
    return this.post('/api/knowledge/ask', { tenant_id: tenantId, question, knowledge_base_id: knowledgeBaseId });
  }

  async createWebhookSubscription(input: { tenant_id: string; url: string; events: string[] }) {
    return this.post('/api/webhooks/subscriptions', input);
  }

  async listWebhookSubscriptions(tenantId: string) {
    return this.get(`/api/webhooks/subscriptions?tenant_id=${tenantId}`);
  }

  async getSubscription(tenantId: string) {
    return this.get(`/api/billing/subscription?tenant_id=${tenantId}`);
  }

  async createCheckout(tenantId: string, planCode: string) {
    return this.post('/api/billing/checkout', { tenant_id: tenantId, plan_code: planCode });
  }

  async getWhiteLabelConfig(tenantId: string) {
    return this.get(`/api/white-label?tenant_id=${tenantId}`);
  }

  async updateWhiteLabelConfig(input: { tenant_id: string; brand_name?: string; logo_url?: string; primary_color?: string; custom_domain?: string }) {
    return this.put('/api/white-label', input);
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers });
    if (!res.ok) throw new Error(`OPC API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`OPC API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  private async put(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`OPC API error: ${res.status} ${res.statusText}`);
    return res.json();
  }
}
