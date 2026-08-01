import type { PgQueryable } from './db-pg.js';
import { ConsentTracker } from './agent-runtime/call-center/compliance/consent-tracker.js';

/**
 * Decide whether to start egress recording for a call session.
 * Only an explicit tenant-scoped durable grant authorizes new capture.
 */
export async function shouldRecordCall(
  pg: PgQueryable | null,
  callSessionId: string,
  sessionMetadata?: Record<string, unknown>
): Promise<boolean> {
  if (sessionMetadata?.recording_consent === 'denied') return false;
  if (!pg || !callSessionId) return false;
  const tenantId = String(sessionMetadata?.tenant_id || '');
  if (!tenantId) return false;
  try {
    const tracker = new ConsentTracker(pg);
    return await tracker.getRecordingConsent(callSessionId, tenantId) === 'granted';
  } catch {
    console.warn('[recording-policy] consent lookup failed; new recording denied');
    return false;
  }
}

export function readEgressConfigFromEnv() {
  const requestTimeoutSeconds = Number(process.env.LIVEKIT_EGRESS_REQUEST_TIMEOUT_SECONDS || 3);
  return {
    livekitUrl: process.env.LIVEKIT_URL || 'ws://localhost:7880',
    livekitApiKey: process.env.LIVEKIT_API_KEY || '',
    livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
    minioEndpoint: process.env.MINIO_ENDPOINT,
    minioBucket: process.env.MINIO_BUCKET || 'recordings',
    requestTimeoutSeconds: Number.isFinite(requestTimeoutSeconds)
      ? Math.min(30, Math.max(1, Math.floor(requestTimeoutSeconds)))
      : 3
  };
}
