import type { PgQueryable } from './db-pg.js';
import { ConsentTracker } from './agent-runtime/call-center/compliance/consent-tracker.js';

/**
 * Decide whether to start egress recording for a call session.
 * Denies only when recording consent is explicitly denied in Postgres.
 */
export async function shouldRecordCall(
  pg: PgQueryable | null,
  callSessionId: string,
  sessionMetadata?: Record<string, unknown>
): Promise<boolean> {
  if (sessionMetadata?.recording_consent === 'denied') return false;
  if (!pg) return true;
  const tenantId = String(sessionMetadata?.tenant_id || '');
  if (!tenantId) return true;
  try {
    const tracker = new ConsentTracker(pg);
    return await tracker.shouldRecord(callSessionId, tenantId);
  } catch (error) {
    console.warn('[recording-policy] consent lookup failed, defaulting to record:', error);
    return true;
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
