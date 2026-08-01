export type RWICommand = 'originate' | 'transfer' | 'hold' | 'unhold' | 'hangup' | 'bridge' | 'play_audio' | 'gather_digits' | 'gather_speech' | 'record_audio' | 'flush_play_queue';

export interface RWICallState {
  call_id: string;
  state: 'ringing' | 'answered' | 'hangup';
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface RWIEvent {
  event: 'call_state_change' | 'digits_collected' | 'speech_result';
  call_id: string;
  state?: RWICallState['state'];
  timestamp?: string;
  /** For 'digits_collected' events: the DTMF digits the caller entered. */
  digits?: string;
  /** For 'speech_result' events: STT transcript. */
  transcript?: string;
  data?: Record<string, unknown>;
}

export interface RWIRequestMessage {
  request_id: string;
  command: RWICommand;
  params: Record<string, unknown>;
}

export interface RWIResponseMessage {
  request_id: string;
  success: boolean;
  call_id?: string;
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface RWIOriginateParams {
  to: string;
  from?: string;
  trunk?: string;
  timeout_sec?: number;
  metadata?: Record<string, string>;
}

/**
 * DTMF digit collection parameters for the `gather_digits` command.
 * The media layer (RustPBX/Asterisk) plays an optional prompt, then
 * collects DTMF digits from the caller until a stop condition is met.
 */
export interface RWIGatherDigitsParams {
  call_id: string;
  /** Optional TTS text or audio file to play before collecting. */
  prompt?: string;
  /** Prompt type: 'tts' or 'audio'. */
  prompt_type?: 'tts' | 'audio';
  /** Minimum number of digits to accept. */
  min_digits: number;
  /** Maximum number of digits to collect. */
  max_digits: number;
  /** How to end collection: 'max_digits' (stop at max) or 'hash_key' (# ends). */
  end_mode?: 'max_digits' | 'hash_key';
  /** Inter-digit timeout in seconds (stop if no digit for this long). */
  inter_digit_timeout_sec?: number;
  /** Overall collection timeout in seconds. */
  timeout_sec?: number;
  /** Number of retries on invalid/insufficient input. */
  max_retries?: number;
  /** Retry prompt to play before each retry. */
  retry_prompt?: string;
  audio_url?: string;
  /** Genesys-style ordered prompts before gather (ADR-4). */
  prompt_queue?: Array<{
    prompt?: string;
    prompt_type?: 'tts' | 'audio';
    audio_url?: string;
    interruptible?: boolean;
  }>;
}

export interface RWIPlayAudioParams {
  call_id: string;
  prompt?: string;
  prompt_type?: 'tts' | 'audio';
  audio_url?: string;
  interruptible?: boolean;
}

export interface RWIFlushPlayQueueParams {
  call_id: string;
  prompt_queue: Array<{
    prompt?: string;
    prompt_type?: 'tts' | 'audio';
    audio_url?: string;
    interruptible?: boolean;
  }>;
}

/** Speech gather — Phase B (3-G0); requires IVR_SPEECH_PRODUCTION=1 in Converact. */
export interface RWIGatherSpeechParams {
  call_id: string;
  prompt?: string;
  prompt_type?: 'tts' | 'audio';
  audio_url?: string;
  language?: string;
  hints?: string[];
  timeout_sec?: number;
  max_retries?: number;
}

/** Voicemail beep + record — VM-1; requires IVR_VOICEMAIL_RECORD_AUDIO=1 in Converact. */
export interface RWIRecordAudioParams {
  call_id: string;
  max_duration_sec: number;
  mailbox_id?: string;
  play_beep?: boolean;
  format?: string;
}
