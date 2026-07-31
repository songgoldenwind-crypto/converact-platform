export interface ChatwootConfig {
  baseUrl: string;
  apiAccessToken: string;
  accountId: number;
}

export class ChatwootClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly accountId: number;

  constructor(config: ChatwootConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.accountId = config.accountId;
    this.headers = {
      'Content-Type': 'application/json',
      'api_access_token': config.apiAccessToken
    };
  }

  private accountUrl(): string {
    return `${this.baseUrl}/api/v1/accounts/${this.accountId}`;
  }

  async sendMessage(
    conversationId: number,
    content: string,
    messageType: 'outgoing' | 'incoming' = 'outgoing'
  ): Promise<unknown> {
    const url = `${this.accountUrl()}/conversations/${conversationId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ content, message_type: messageType })
    });
    if (!res.ok) throw new Error(`Chatwoot API error: ${res.status}`);
    return res.json();
  }

  async getConversation(conversationId: number): Promise<unknown> {
    const url = `${this.accountUrl()}/conversations/${conversationId}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Chatwoot API error: ${res.status}`);
    return res.json();
  }

  async assignConversation(conversationId: number, agentId: number): Promise<unknown> {
    const url = `${this.accountUrl()}/conversations/${conversationId}/assignments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ assignee_id: agentId })
    });
    if (!res.ok) throw new Error(`Chatwoot API error: ${res.status}`);
    return res.json();
  }

  async addLabel(conversationId: number, labels: string[]): Promise<unknown> {
    const url = `${this.accountUrl()}/conversations/${conversationId}/labels`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ labels })
    });
    if (!res.ok) throw new Error(`Chatwoot API error: ${res.status}`);
    return res.json();
  }

  async searchContacts(query: string): Promise<unknown> {
    const url = `${this.accountUrl()}/contacts/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Chatwoot API error: ${res.status}`);
    return res.json();
  }
}
