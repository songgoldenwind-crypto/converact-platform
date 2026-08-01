import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePlayContents } from '../src/agent-runtime/ivr/ivr-play-resolver.js';
import type { AudioLibraryEntry } from '../src/agent-runtime/ivr/audio-library-store.js';

const lookup = (id: string): AudioLibraryEntry | null => {
  if (id === 'audio_welcome') {
    return {
      id: 'audio_welcome',
      scope: 'enterprise',
      tenant_id: 't1',
      name: '欢迎音',
      entry_type: 'audio_file',
      audio_url: 'https://cdn.example.com/welcome.wav',
      created_at: '',
      updated_at: '',
    };
  }
  if (id === 'tts_welcome') {
    return {
      id: 'tts_welcome',
      scope: 'enterprise',
      tenant_id: 't1',
      name: '欢迎TTS',
      entry_type: 'tts',
      tts_text: '欢迎致电{{公司名}}',
      tts_engine: 'ali',
      created_at: '',
      updated_at: '',
    };
  }
  return null;
};

test('resolvePlayContents: TTS with variable substitution', () => {
  const resolved = resolvePlayContents(
    [{ playType: 'tts', text: '您好，{{公司名}}' }],
    { 公司名: 'Converact' },
  );
  assert.equal(resolved.promptType, 'tts');
  assert.ok(resolved.text.includes('Converact'));
});

test('resolvePlayContents: audio library file resolves to audio URL', () => {
  const resolved = resolvePlayContents(
    [{ playType: 'audio', audioFile: 'audio_welcome' }],
    {},
    lookup,
  );
  assert.equal(resolved.promptType, 'audio');
  assert.equal(resolved.audioUrl, 'https://cdn.example.com/welcome.wav');
});

test('resolvePlayContents: audio library TTS entry falls back to tts', () => {
  const resolved = resolvePlayContents(
    [{ playType: 'audio', audioFile: 'tts_welcome' }],
    { 公司名: '测试' },
    lookup,
  );
  assert.equal(resolved.promptType, 'tts');
  assert.ok(resolved.text.includes('测试'));
});

test('resolvePlayContents: audio_var uses variable value as URL', () => {
  const resolved = resolvePlayContents(
    [{ playType: 'audio_var', variable: 'prompt_url' }],
    { prompt_url: 'https://cdn.example.com/dynamic.mp3' },
  );
  assert.equal(resolved.promptType, 'audio');
  assert.equal(resolved.audioUrl, 'https://cdn.example.com/dynamic.mp3');
});
