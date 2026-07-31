/**
 * VM-2 — async notification after voicemail saved.
 */

export interface VoicemailNotifyPayload {
  voicemailId: string;
  recordingUrl: string;
  mailbox: string;
  fromNumber: string;
  durationSec?: number;
  notifyEmail?: string;
}

function substituteVars(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => variables[key.trim()] ?? `{{${key.trim()}}}`);
}

export const VOICEMAIL_NOTIFY_TIMEOUT_MS = Number(process.env.VOICEMAIL_NOTIFY_TIMEOUT_MS || 10_000);

export async function fireVoicemailNotify(
  notifyWebhook: string | undefined,
  payload: VoicemailNotifyPayload,
  variables: Record<string, string> = {}
): Promise<void> {
  if (!notifyWebhook?.trim()) return;
  const url = substituteVars(notifyWebhook, variables);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICEMAIL_NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        voicemail_id: payload.voicemailId,
        recording_url: payload.recordingUrl,
        mailbox: payload.mailbox,
        from_number: payload.fromNumber,
        duration_sec: payload.durationSec,
        notify_email: payload.notifyEmail,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`voicemail notify webhook failed: ${url} status=${res.status}`);
    }
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    console.warn(
      `voicemail notify webhook error: ${isTimeout ? 'timeout' : err instanceof Error ? err.message : String(err)}`
    );
  }
}
