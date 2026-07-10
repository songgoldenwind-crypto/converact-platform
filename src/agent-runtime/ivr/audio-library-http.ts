/**
 * Audio Library HTTP API — CRUD for shared voice prompt assets.
 *
 * GET    /api/ivr/audio-library              — list entries (public + tenant enterprise)
 * POST   /api/ivr/audio-library              — create/update entry
 * GET    /api/ivr/audio-library/:id          — get entry
 * DELETE /api/ivr/audio-library/:id          — delete entry
 */

import { resolveAuthContext } from '../../middleware/auth.js';
import { AudioLibraryStore, type AudioLibraryScope, type AudioEntryType } from './audio-library-store.js';

function pgId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function routeAudioLibraryApi(
  db: unknown,
  method: string,
  path: string,
  _url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): unknown {
  if (!path.startsWith('/api/ivr/audio-library')) return undefined;

  const store = new AudioLibraryStore(db);
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  const tenantId = ctx.tenantId;
  const input = (body || {}) as Record<string, unknown>;

  // GET /api/ivr/audio-library — list
  if (path === '/api/ivr/audio-library' && method === 'GET') {
    return { data: store.listForTenant(tenantId) };
  }

  // POST /api/ivr/audio-library — create or update
  if (path === '/api/ivr/audio-library' && method === 'POST') {
    const scope = (input.scope as AudioLibraryScope) || 'enterprise';
    // Only admins can create public-scope entries
    if (scope === 'public' && ctx.role !== 'owner' && ctx.role !== 'admin') {
      return { status: 403, data: { error: 'only admins can manage public audio library' } };
    }
    const id = (input.id as string) || pgId('audio');
    const entry = store.upsert({
      id,
      scope,
      tenant_id: scope === 'public' ? '' : tenantId,
      name: (input.name as string) || '未命名语音',
      description: input.description as string | undefined,
      entry_type: (input.entry_type as AudioEntryType) || 'tts',
      tts_text: input.tts_text as string | undefined,
      tts_engine: input.tts_engine as string | undefined,
      audio_url: input.audio_url as string | undefined,
      variable_name: input.variable_name as string | undefined,
      language: (input.language as string) || 'zh',
      duration_sec: input.duration_sec as number | undefined,
    });
    return { data: entry };
  }

  // GET /api/ivr/audio-library/:id
  const getMatch = path.match(/^\/api\/ivr\/audio-library\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    const entry = store.get(getMatch[1]);
    if (!entry) return { status: 404, data: { error: 'audio entry not found' } };
    // Enforce tenant isolation for enterprise entries
    if (entry.scope === 'enterprise' && entry.tenant_id !== tenantId) {
      return { status: 403, data: { error: 'not accessible' } };
    }
    return { data: entry };
  }

  // DELETE /api/ivr/audio-library/:id
  const deleteMatch = path.match(/^\/api\/ivr\/audio-library\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const entry = store.get(deleteMatch[1]);
    if (!entry) return { status: 404, data: { error: 'audio entry not found' } };
    if (entry.scope === 'enterprise' && entry.tenant_id !== tenantId) {
      return { status: 403, data: { error: 'not accessible' } };
    }
    store.delete(deleteMatch[1]);
    return { data: { ok: true } };
  }

  return undefined;
}