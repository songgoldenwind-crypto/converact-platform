/**
 * Resolves Play node contents (TTS / audio file / variables) into media-layer prompts.
 */

import type { AudioLibraryEntry } from './audio-library-store.js';

export type PromptMediaType = 'tts' | 'audio';

export interface PlayContentLike {
  playType: 'audio' | 'audio_var' | 'tts' | 'tts_var';
  text?: string;
  variable?: string;
  audioFile?: string;
  audioLibrary?: 'public' | 'enterprise';
  ttsEngine?: string;
}

export interface ResolvedPrompt {
  text: string;
  promptType: PromptMediaType;
  audioUrl?: string;
  ttsEngine?: string;
}

export type PlayResolveResult =
  | { ok: true; prompt: ResolvedPrompt }
  | { ok: false; reason: string; fallback: ResolvedPrompt };

export type AudioEntryLookup = (id: string) => AudioLibraryEntry | null | undefined;

function substituteVars(text: string, variables: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => variables[key.trim()] ?? `{{${key.trim()}}}`);
}

function resolveSingleContentResult(
  content: PlayContentLike,
  variables: Record<string, string>,
  lookup?: AudioEntryLookup
): PlayResolveResult {
  const playType = content.playType || 'tts';

  if (playType === 'audio') {
    const fileId = content.audioFile || '';
    if (!fileId.trim()) {
      return {
        ok: false,
        reason: 'audio_missing',
        fallback: { text: '(audio missing)', promptType: 'tts' },
      };
    }
    const entry = lookup ? lookup(fileId) : null;
    if (!entry && !fileId.startsWith('http')) {
      return {
        ok: false,
        reason: 'audio_not_found',
        fallback: { text: '(audio not found)', promptType: 'tts' },
      };
    }
  }

  if (playType === 'tts_var') {
    const varName = content.variable || '';
    if (!varName.trim()) {
      return {
        ok: false,
        reason: 'tts_var_empty',
        fallback: { text: '(TTS variable missing)', promptType: 'tts' },
      };
    }
    const resolved = (variables[varName] ?? '').trim();
    if (!resolved) {
      return {
        ok: false,
        reason: 'tts_var_empty',
        fallback: { text: '(TTS variable empty)', promptType: 'tts' },
      };
    }
  }

  if (playType === 'audio_var') {
    const varName = content.variable || '';
    if (!varName.trim()) {
      return {
        ok: false,
        reason: 'audio_var_empty',
        fallback: { text: '(audio variable missing)', promptType: 'tts' },
      };
    }
    const resolved = (variables[varName] ?? content.audioFile ?? '').trim();
    if (!resolved) {
      return {
        ok: false,
        reason: 'audio_var_empty',
        fallback: { text: '(audio variable empty)', promptType: 'tts' },
      };
    }
  }

  return { ok: true, prompt: resolveSingleContent(content, variables, lookup) };
}

function resolveSingleContent(
  content: PlayContentLike,
  variables: Record<string, string>,
  lookup?: AudioEntryLookup
): ResolvedPrompt {
  const playType = content.playType || 'tts';

  if (playType === 'tts_var') {
    const varName = content.variable || '';
    const text = substituteVars(variables[varName] || content.text || '', variables);
    return { text: text || '(TTS)', promptType: 'tts', ttsEngine: content.ttsEngine };
  }

  if (playType === 'audio_var') {
    const varName = content.variable || '';
    const url = substituteVars(variables[varName] || content.audioFile || '', variables);
    return { text: url || '(audio)', promptType: 'audio', audioUrl: url };
  }

  if (playType === 'audio') {
    const fileId = content.audioFile || '';
    const entry = fileId && lookup ? lookup(fileId) : null;
    if (entry?.audio_url) {
      return { text: entry.name, promptType: 'audio', audioUrl: entry.audio_url, ttsEngine: entry.tts_engine };
    }
    if (entry?.tts_text) {
      return {
        text: substituteVars(entry.tts_text, variables),
        promptType: 'tts',
        ttsEngine: entry.tts_engine || content.ttsEngine,
      };
    }
    const url = fileId.startsWith('http') ? fileId : fileId;
    if (url.startsWith('http')) {
      return { text: url, promptType: 'audio', audioUrl: url };
    }
    return { text: fileId || '(audio)', promptType: 'audio', audioUrl: fileId || undefined };
  }

  const text = substituteVars(content.text || '(播放)', variables);
  return { text, promptType: 'tts', ttsEngine: content.ttsEngine };
}

/** Merge multiple play items into one prompt (concat TTS text; first audio wins). */
export function resolvePlayContentsResult(
  contents: PlayContentLike[],
  variables: Record<string, string>,
  lookup?: AudioEntryLookup
): PlayResolveResult {
  if (!contents.length) {
    return { ok: true, prompt: { text: '(播放)', promptType: 'tts' } };
  }

  for (const content of contents) {
    const single = resolveSingleContentResult(content, variables, lookup);
    if (!single.ok) return single;
  }

  const parts = contents.map((c) => resolveSingleContent(c, variables, lookup));
  const audioPart = parts.find((p) => p.promptType === 'audio' && p.audioUrl);
  if (audioPart) return { ok: true, prompt: audioPart };

  return {
    ok: true,
    prompt: {
      text: parts.map((p) => p.text).filter(Boolean).join(' '),
      promptType: 'tts',
      ttsEngine: parts.find((p) => p.ttsEngine)?.ttsEngine,
    },
  };
}

/** Merge multiple play items into one prompt (concat TTS text; first audio wins). */
export function resolvePlayContents(
  contents: PlayContentLike[],
  variables: Record<string, string>,
  lookup?: AudioEntryLookup
): ResolvedPrompt {
  const result = resolvePlayContentsResult(contents, variables, lookup);
  if (result.ok === false) return result.fallback;
  return result.prompt;
}
