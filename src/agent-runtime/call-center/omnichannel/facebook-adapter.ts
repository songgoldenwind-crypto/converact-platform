/**
 * Normalize Facebook Messenger webhook payloads (Graph API).
 */
export function normalizeFacebookMessengerInbound(raw: Record<string, unknown>): {
  tenant_id: string;
  sender_id: string;
  text: string;
  message_id: string;
} | null {
  const entry = Array.isArray(raw.entry) ? raw.entry[0] : null;
  const messaging = entry && Array.isArray((entry as { messaging?: unknown[] }).messaging)
    ? (entry as { messaging: unknown[] }).messaging[0]
    : null;
  if (!messaging || typeof messaging !== 'object') return null;
  const msg = (messaging as { message?: { text?: string; mid?: string }; sender?: { id?: string } }).message;
  const sender = (messaging as { sender?: { id?: string } }).sender;
  const text = String(msg?.text || '');
  const messageId = String(msg?.mid || `fb:${Date.now()}`);
  const senderId = String(sender?.id || '');
  const tenantId = String(raw.tenant_id || raw.tenantId || '');
  if (!tenantId || !senderId || !text) return null;
  return { tenant_id: tenantId, sender_id: senderId, text, message_id: messageId };
}

export async function sendFacebookMessengerReply(input: {
  pageAccessToken: string;
  recipientId: string;
  text: string;
}): Promise<{ success: boolean; message_id?: string; error?: string }> {
  const token = input.pageAccessToken || process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '';
  if (!token) return { success: false, error: 'FACEBOOK_PAGE_ACCESS_TOKEN not configured' };
  // Use Authorization header instead of URL query param to prevent token
  // leakage in access logs, proxy logs, and fetch error messages.
  const response = await fetch(
    'https://graph.facebook.com/v19.0/me/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        recipient: { id: input.recipientId },
        message: { text: input.text }
      }),
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { success: false, error: `Facebook API ${response.status}: ${text}` };
  }
  const data = (await response.json()) as { message_id?: string };
  return { success: true, message_id: data.message_id };
}
