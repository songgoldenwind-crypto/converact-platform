/**
 * Audio Library Store — manages shared voice prompt assets.
 *
 * Two scopes:
 * - 'public':  system-wide audio files available to all tenants
 * - 'enterprise': tenant-specific audio files
 *
 * Each entry stores metadata (name, description, TTS text or audio URL)
 * so the Play node can reference it by ID instead of hardcoding text.
 */

import { run, one, all, json, parseJson } from '../../db.js';
import { migrateIvrRuntimeTables } from '../../db-migrations/ivr-runtime-schema.js';

export type AudioLibraryScope = 'public' | 'enterprise';
export type AudioEntryType = 'tts' | 'audio_file' | 'audio_var';

export interface AudioLibraryEntry {
  id: string;
  scope: AudioLibraryScope;
  tenant_id: string;       // '' for public scope
  name: string;
  description?: string;
  entry_type: AudioEntryType;
  tts_text?: string;       // for 'tts' type (supports SSML)
  tts_engine?: string;     // 'ali' | 'cosyvoice' | 'cartesia' | ...
  audio_url?: string;      // for 'audio_file' type
  variable_name?: string;  // for 'audio_var' type
  language?: string;       // 'zh' | 'en' | 'ja' | ...
  duration_sec?: number;
  created_at: string;
  updated_at: string;
}

export class AudioLibraryStore {
  constructor(private db: unknown) {}

  ensureTable(): void {
    migrateIvrRuntimeTables(this.db);
  }

  upsert(entry: Omit<AudioLibraryEntry, 'created_at' | 'updated_at'>): AudioLibraryEntry {
    const existing = one(this.db, 'SELECT * FROM audio_library WHERE id = ?', [entry.id]);
    if (existing) {
      run(this.db, `
        UPDATE audio_library SET scope=?, tenant_id=?, name=?, description=?, entry_type=?,
        tts_text=?, tts_engine=?, audio_url=?, variable_name=?, language=?, duration_sec=?,
        updated_at=datetime('now') WHERE id=?
      `, [
        entry.scope, entry.tenant_id, entry.name, entry.description || null,
        entry.entry_type, entry.tts_text || null, entry.tts_engine || null,
        entry.audio_url || null, entry.variable_name || null, entry.language || 'zh',
        entry.duration_sec ?? null, entry.id
      ]);
    } else {
      run(this.db, `
        INSERT INTO audio_library (id, scope, tenant_id, name, description, entry_type, tts_text, tts_engine, audio_url, variable_name, language, duration_sec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        entry.id, entry.scope, entry.tenant_id, entry.name, entry.description || null,
        entry.entry_type, entry.tts_text || null, entry.tts_engine || null,
        entry.audio_url || null, entry.variable_name || null, entry.language || 'zh',
        entry.duration_sec ?? null
      ]);
    }
    return this.get(entry.id)!;
  }

  get(id: string): AudioLibraryEntry | null {
    const row = one(this.db, 'SELECT * FROM audio_library WHERE id = ?', [id]);
    return row ? this.decode(row) : null;
  }

  /**
   * List entries visible to a tenant: public scope + their own enterprise scope.
   */
  listForTenant(tenantId: string): AudioLibraryEntry[] {
    const rows = all(this.db, `
      SELECT * FROM audio_library
      WHERE scope = 'public' OR (scope = 'enterprise' AND tenant_id = ?)
      ORDER BY scope ASC, name ASC
    `, [tenantId]);
    return rows.map((r) => this.decode(r));
  }

  listPublic(): AudioLibraryEntry[] {
    const rows = all(this.db, `SELECT * FROM audio_library WHERE scope = 'public' ORDER BY name ASC`);
    return rows.map((r) => this.decode(r));
  }

  listEnterprise(tenantId: string): AudioLibraryEntry[] {
    const rows = all(this.db, `SELECT * FROM audio_library WHERE scope = 'enterprise' AND tenant_id = ? ORDER BY name ASC`, [tenantId]);
    return rows.map((r) => this.decode(r));
  }

  delete(id: string): boolean {
    const result = run(this.db, 'DELETE FROM audio_library WHERE id = ?', [id]);
    return result.changes > 0;
  }

  private decode(row: Record<string, unknown>): AudioLibraryEntry {
    return {
      id: row.id as string,
      scope: row.scope as AudioLibraryScope,
      tenant_id: (row.tenant_id as string) || '',
      name: row.name as string,
      description: (row.description as string) || undefined,
      entry_type: row.entry_type as AudioEntryType,
      tts_text: (row.tts_text as string) || undefined,
      tts_engine: (row.tts_engine as string) || undefined,
      audio_url: (row.audio_url as string) || undefined,
      variable_name: (row.variable_name as string) || undefined,
      language: (row.language as string) || 'zh',
      duration_sec: (row.duration_sec as number) ?? undefined,
      created_at: (row.created_at as string) || '',
      updated_at: (row.updated_at as string) || '',
    };
  }
}