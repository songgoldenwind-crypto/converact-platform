import type { IveKitTranslationJob, IveKitTranslationListResult, IveKitTranslationStatus } from '@converact/sdk';

export interface TranslationProjection {
  targetLanguage: string;
  status: IveKitTranslationStatus;
  statusLabel: string;
  translatedText: string;
  jobId: string;
  retryable: boolean;
  errorCode: string;
}

export function projectTranslations(input: IveKitTranslationListResult): TranslationProjection[] {
  const latestJobs = latestByTarget(input.jobs);
  const latestResults = latestByTarget(input.items);
  const targets = new Set([...latestJobs.keys(), ...latestResults.keys()]);

  return [...targets].sort().map((targetLanguage) => {
    const job = latestJobs.get(targetLanguage);
    const candidate = latestResults.get(targetLanguage);
    const result = candidate && (!job || candidate.source_hash === job.source_hash) ? candidate : undefined;
    const status = result ? 'succeeded' : job?.status || 'cancelled';
    return {
      targetLanguage,
      status,
      statusLabel: translationStatusLabel(status),
      translatedText: result?.translated_text || '',
      jobId: job?.id || '',
      retryable: status === 'failed' && retryableTranslationError(job?.error_code || ''),
      errorCode: job?.error_code || ''
    };
  });
}

export function retryableTranslationError(code: string): boolean {
  if (['provider_timeout', 'provider_unavailable', 'claim_lease_expired',
    'translation_result_missing', 'translation_job_claim_lost'].includes(code)) return true;
  const status = Number(code.match(/^provider_http_(\d{3})$/)?.[1]);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function latestByTarget<T extends { target_language: string; created_at: string; id: string }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const current = result.get(item.target_language);
    if (!current || `${item.created_at}:${item.id}` > `${current.created_at}:${current.id}`) {
      result.set(item.target_language, item);
    }
  }
  return result;
}

function translationStatusLabel(status: IveKitTranslationStatus): string {
  switch (status) {
    case 'pending': return 'Queued';
    case 'processing': return 'Translating';
    case 'retry_wait': return 'Retry scheduled';
    case 'succeeded': return 'Translated';
    case 'failed': return 'Translation failed';
    case 'cancelled': return 'Cancelled';
  }
}
