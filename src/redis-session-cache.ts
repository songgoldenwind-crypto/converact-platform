import { getRedisClient } from './agent-runtime/call-center/redis-client.js';

const SESSION_TTL_SEC = 86_400;

export interface CallSessionCacheSnapshot {
  call_session_id: string;
  tenant_id: string;
  state: string;
  current_node: string;
  variables: Record<string, unknown>;
  turn_count: number;
  updated_at: string;
}

function sessionKey(callSessionId: string): string {
  return `session:${callSessionId}`;
}

export async function initCallSessionCache(
  callSessionId: string,
  tenantId: string,
  patch: Partial<CallSessionCacheSnapshot> = {}
): Promise<void> {
  const redis = await getRedisClient();
  const now = new Date().toISOString();
  await redis.hset(sessionKey(callSessionId), {
    call_session_id: callSessionId,
    tenant_id: tenantId,
    state: patch.state || 'queued',
    current_node: patch.current_node || '',
    variables: JSON.stringify(patch.variables || {}),
    turn_count: String(patch.turn_count ?? 0),
    updated_at: patch.updated_at || now
  });
  await redis.expire(sessionKey(callSessionId), SESSION_TTL_SEC);
}

export async function getCallSessionCache(
  callSessionId: string
): Promise<CallSessionCacheSnapshot | null> {
  const redis = await getRedisClient();
  const raw = await redis.get(sessionKey(callSessionId));
  if (!raw) return null;

  const fields = JSON.parse(raw) as Record<string, string>;
  let variables: Record<string, unknown> = {};
  try {
    variables = JSON.parse(fields.variables || '{}') as Record<string, unknown>;
  } catch {
    variables = {};
  }

  return {
    call_session_id: fields.call_session_id || callSessionId,
    tenant_id: fields.tenant_id || '',
    state: fields.state || 'unknown',
    current_node: fields.current_node || '',
    variables,
    turn_count: Number(fields.turn_count || 0),
    updated_at: fields.updated_at || ''
  };
}

export async function patchCallSessionCache(
  callSessionId: string,
  fields: Record<string, string>
): Promise<CallSessionCacheSnapshot | null> {
  const redis = await getRedisClient();
  const key = sessionKey(callSessionId);
  const existing = await redis.get(key);
  if (!existing) return null;

  await redis.hset(key, { ...fields, updated_at: new Date().toISOString() });
  await redis.expire(key, SESSION_TTL_SEC);
  return getCallSessionCache(callSessionId);
}

export async function incrementCallSessionTurnCount(callSessionId: string): Promise<void> {
  const snapshot = await getCallSessionCache(callSessionId);
  if (!snapshot) return;
  await patchCallSessionCache(callSessionId, {
    turn_count: String(snapshot.turn_count + 1)
  });
}

export async function deleteCallSessionCache(callSessionId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(sessionKey(callSessionId));
}
