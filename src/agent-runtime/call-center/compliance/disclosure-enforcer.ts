export interface DisclosureConfig {
  audioUrl: string;
  durationMs: number;
  text: string;
  language: string;
}

const DEFAULT_DISCLOSURE_ZH: DisclosureConfig = {
  audioUrl: process.env.COMPLIANCE_DISCLOSURE_AUDIO_URL || '',
  durationMs: Number(process.env.COMPLIANCE_DISCLOSURE_DURATION_MS || 3000),
  text:
    '您好，本次通话由人工智能语音助手为您服务，通话可能会被录音用于服务质量监控。如您不同意，请挂断电话。',
  language: 'zh'
};

const DEFAULT_DISCLOSURE_EN: DisclosureConfig = {
  audioUrl: process.env.COMPLIANCE_DISCLOSURE_AUDIO_URL_EN || '',
  durationMs: Number(process.env.COMPLIANCE_DISCLOSURE_DURATION_MS || 3000),
  text:
    'Hello, this call is handled by an AI voice assistant. The call may be recorded for quality assurance. Hang up if you do not consent.',
  language: 'en'
};

/**
 * Returns mandatory AI disclosure content for a call.
 * The AI Agent must play this before starting the conversation.
 */
export function getDisclosureConfig(language: string = 'zh'): DisclosureConfig {
  const lang = String(language || 'zh').toLowerCase();
  if (lang.startsWith('en')) return { ...DEFAULT_DISCLOSURE_EN };
  return { ...DEFAULT_DISCLOSURE_ZH };
}

export interface DisclosureState {
  callSessionId: string;
  tenantId: string;
  language: string;
  required: boolean;
  playedAt: string | null;
  completedAt: string | null;
}

const pendingDisclosures = new Map<string, DisclosureState>();

export function beginDisclosure(callSessionId: string, tenantId: string, language: string): DisclosureConfig {
  const config = getDisclosureConfig(language);
  pendingDisclosures.set(callSessionId, {
    callSessionId,
    tenantId,
    language: config.language,
    required: true,
    playedAt: new Date().toISOString(),
    completedAt: null
  });
  return config;
}

/**
 * Called by AI Agent via disclosure_complete tool after audio finishes.
 */
export function completeDisclosure(callSessionId: string): DisclosureState {
  const state = pendingDisclosures.get(callSessionId);
  if (!state) {
    throw Object.assign(new Error('disclosure not started for this call session'), { status: 400 });
  }
  state.completedAt = new Date().toISOString();
  state.required = false;
  pendingDisclosures.set(callSessionId, state);
  return state;
}

export function isDisclosureComplete(callSessionId: string): boolean {
  const state = pendingDisclosures.get(callSessionId);
  return Boolean(state?.completedAt);
}

export function clearDisclosure(callSessionId: string): void {
  pendingDisclosures.delete(callSessionId);
}

/** For tests */
export function _resetDisclosureState(): void {
  pendingDisclosures.clear();
}
