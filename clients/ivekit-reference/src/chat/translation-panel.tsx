import type { IveKitClient, IveKitTranslationListResult } from '@opc/ivekit-sdk';
import { Languages, RotateCcw } from 'lucide-react';
import React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { projectTranslations } from './translation-view-model.js';

const TARGET_LANGUAGES = [
  ['en-US', 'English'],
  ['zh-CN', '简体中文'],
  ['ja-JP', '日本語'],
  ['ko-KR', '한국어'],
  ['fr-FR', 'Français'],
  ['de-DE', 'Deutsch'],
  ['es-ES', 'Español']
] as const;

export function TranslationPanel(props: {
  client: IveKitClient;
  sessionId: string;
  sourceType: 'message' | 'attachment';
  sourceRefId: string;
  refreshVersion?: number;
}) {
  const [open, setOpen] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState('en-US');
  const [snapshot, setSnapshot] = useState<IveKitTranslationListResult>({ items: [], jobs: [] });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const translations = useMemo(() => projectTranslations(snapshot), [snapshot]);

  const refresh = useCallback(async () => {
    const next = props.sourceType === 'message'
      ? await props.client.chat.listMessageTranslations(props.sessionId, props.sourceRefId)
      : await props.client.chat.listAttachmentTranslations(props.sessionId, props.sourceRefId);
    setSnapshot(next);
    setError('');
  }, [props.client, props.sessionId, props.sourceRefId, props.sourceType]);

  useEffect(() => {
    if (!open) return;
    void refresh().catch(() => setError('Translation status unavailable'));
  }, [open, props.refreshVersion, refresh]);

  useEffect(() => {
    if (!open || !translations.some((item) => ['pending', 'processing', 'retry_wait'].includes(item.status))) return;
    const timer = window.setTimeout(() => {
      void refresh().catch(() => setError('Translation status unavailable'));
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [open, refresh, translations]);

  async function requestTranslation() {
    setPending(true);
    setError('');
    try {
      const input = { target_language: targetLanguage };
      const options = { idempotencyKey: randomId() };
      const requested = props.sourceType === 'message'
        ? await props.client.chat.requestMessageTranslation(props.sessionId, props.sourceRefId, input, options)
        : await props.client.chat.requestAttachmentTranslation(props.sessionId, props.sourceRefId, input, options);
      setSnapshot((current) => ({ ...current, jobs: [requested.job, ...current.jobs.filter((job) => job.id !== requested.job.id)] }));
      await refresh();
    } catch {
      setError('Translation request failed');
    } finally {
      setPending(false);
    }
  }

  async function retry(jobId: string) {
    setPending(true);
    setError('');
    try {
      const retried = await props.client.chat.retryTranslation(props.sessionId, jobId);
      setSnapshot((current) => ({ ...current, jobs: [retried.job, ...current.jobs.filter((job) => job.id !== retried.job.id)] }));
      await refresh();
    } catch {
      setError('Translation retry failed');
    } finally {
      setPending(false);
    }
  }

  const sourceLabel = props.sourceType === 'message' ? 'message' : 'attachment';
  return <div className="translation-inline">
    <button
      className="translation-toggle"
      title={`Translate ${sourceLabel}`}
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    ><Languages size={14} /></button>
    {open && <div className="translation-workspace">
      <div className="translation-controls">
        <label>Target language<select aria-label="Target language" value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
          {TARGET_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button disabled={pending} onClick={() => void requestTranslation()}>Translate</button>
      </div>
      {translations.map((translation) => <div className={`translation-result ${translation.status}`} key={translation.targetLanguage}>
        <div><strong>{translation.targetLanguage}</strong><small>{translation.statusLabel}</small>
          {translation.retryable && <button
            aria-label="Retry translation"
            title="Retry translation"
            disabled={pending}
            onClick={() => void retry(translation.jobId)}
          ><RotateCcw size={13} /></button>}
        </div>
        {translation.translatedText && <p lang={translation.targetLanguage}>{translation.translatedText}</p>}
      </div>)}
      {error && <p className="translation-error" role="alert">{error}</p>}
    </div>}
  </div>;
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('Web Crypto is required for translation idempotency');
}
