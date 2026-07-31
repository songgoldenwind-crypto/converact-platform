import { resolveBrandEnv } from '../../../config/converact-env.js';
import { run } from '../../../db.js';

export interface TranscribeResult {
  transcript: string;
  source: 'asr_api' | 'empty';
}

function getAsrConfig() {
  return {
    apiUrl: resolveBrandEnv(process.env, 'ASR_API_URL') || process.env.ASR_API_URL || '',
    apiKey: resolveBrandEnv(process.env, 'ASR_API_KEY') || process.env.ASR_API_KEY || '',
    model: resolveBrandEnv(process.env, 'ASR_MODEL') || 'whisper-1'
  };
}

export async function transcribeVoicemailRecording(recordingUrl: string): Promise<TranscribeResult> {
  const url = recordingUrl.trim();
  if (!url) return { transcript: '', source: 'empty' };

  const asr = getAsrConfig();
  if (asr.apiUrl) {
    try {
      const audioRes = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!audioRes.ok) throw new Error(`recording fetch ${audioRes.status}`);
      const audioBytes = await audioRes.arrayBuffer();

      const form = new FormData();
      form.append('file', new Blob([audioBytes]), 'voicemail.ogg');
      form.append('model', asr.model);

      const asrRes = await fetch(asr.apiUrl, {
        method: 'POST',
        headers: asr.apiKey ? { Authorization: `Bearer ${asr.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(60_000)
      });
      if (!asrRes.ok) throw new Error(`asr api ${asrRes.status}`);
      const data = (await asrRes.json()) as { text?: string; transcript?: string };
      const text = String(data.text || data.transcript || '').trim();
      if (text) return { transcript: text, source: 'asr_api' };
    } catch (error) {
      console.warn('[voicemail-asr] ASR API failed:', error);
    }
  }

  // LLM fallback removed: text LLMs cannot transcribe audio.
  // Previously this sent the recording URL string to DeepSeek and treated
  // the LLM's hallucinated text as a transcript — that was a fake implementation.
  // To enable transcription, configure CONVERACT_ASR_API_URL to a real ASR service
  // (Whisper API / FunASR / AmiVoice).
  return { transcript: '', source: 'empty' };
}

export async function transcribeAndUpdateVoicemail(
  db: unknown,
  voicemailId: string,
  recordingUrl: string
): Promise<TranscribeResult> {
  const result = await transcribeVoicemailRecording(recordingUrl);
  if (result.transcript) {
    run(db, 'UPDATE voicemails SET transcript = ? WHERE id = ?', [result.transcript, voicemailId]);
  }
  return result;
}
