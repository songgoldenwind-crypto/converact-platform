/**
 * Maps IVR executor actions to RustPBX RWI commands for the media layer.
 */

import type { IvrAction } from './ivr-executor.js';
import type { RWICommand, RWIGatherDigitsParams, RWIGatherSpeechParams, RWIFlushPlayQueueParams } from '../call-center/rwi-types.js';
import { isSpeechProductionEnabled } from './ivr-production-gates.js';
import { isVoicemailRecordAudioProductionEnabled } from './ivr-production-gates.js';

export interface RwiCommandEnvelope {
  command: RWICommand;
  params: Record<string, unknown>;
  /** Whether the media layer should wait for caller input before calling advance again */
  waitsForInput: boolean;
}

export function ivrActionToRwi(
  action: IvrAction,
  callId: string
): RwiCommandEnvelope | null {
  switch (action.kind) {
    case 'play':
      return {
        command: 'play_audio',
        params: {
          call_id: callId,
          prompt: action.text,
          prompt_type: action.promptType === 'audio' ? 'audio' : 'tts',
          ...(action.audioUrl ? { audio_url: action.audioUrl } : {}),
          ...(action.interruptible ? { interruptible: true } : {}),
        },
        waitsForInput: false,
      };
    case 'flush_play_queue':
      return {
        command: 'flush_play_queue',
        params: {
          call_id: callId,
          prompt_queue: action.promptQueue.map((item) => ({
            prompt: item.text,
            prompt_type: item.promptType === 'audio' ? 'audio' : 'tts',
            ...(item.audioUrl ? { audio_url: item.audioUrl } : {}),
            ...(item.interruptible ? { interruptible: true } : {}),
          })),
        } satisfies RWIFlushPlayQueueParams,
        waitsForInput: false,
      };
    case 'menu':
      if (action.speechEnabled && isSpeechProductionEnabled()) {
        return {
          command: 'gather_speech',
          params: {
            call_id: callId,
            prompt: action.prompt,
            prompt_type: action.promptType === 'audio' ? 'audio' : 'tts',
            ...(action.audioUrl ? { audio_url: action.audioUrl } : {}),
            language: action.speechLanguage ?? 'zh-CN',
            hints: action.speechHints,
            timeout_sec: action.timeoutSec ?? 10,
            max_retries: action.maxRetries ?? 3,
          } satisfies Partial<RWIGatherSpeechParams>,
          waitsForInput: true,
        };
      }
      return {
        command: 'gather_digits',
        params: {
          call_id: callId,
          prompt: action.prompt,
          prompt_type: action.promptType === 'audio' ? 'audio' : 'tts',
          ...(action.audioUrl ? { audio_url: action.audioUrl } : {}),
          ...(action.promptQueue?.length
            ? {
                prompt_queue: action.promptQueue.map((item) => ({
                  prompt: item.text,
                  prompt_type: item.promptType === 'audio' ? 'audio' : 'tts',
                  ...(item.audioUrl ? { audio_url: item.audioUrl } : {}),
                  ...(item.interruptible ? { interruptible: true } : {}),
                })),
              }
            : {}),
          min_digits: 1,
          max_digits: 1,
          end_mode: 'max_digits',
          inter_digit_timeout_sec: 5,
          timeout_sec: action.timeoutSec ?? 10,
          max_retries: action.maxRetries ?? 3,
        } satisfies Partial<RWIGatherDigitsParams>,
        waitsForInput: true,
      };
    case 'visual_menu':
      return {
        command: 'gather_digits',
        params: {
          call_id: callId,
          prompt: action.title,
          prompt_type: 'tts',
          min_digits: 1,
          max_digits: 1,
          end_mode: 'max_digits',
          inter_digit_timeout_sec: 5,
          timeout_sec: 15,
          max_retries: 3,
          metadata: {
            visual_items: action.items,
            visual_payload: {
              title: action.title,
              items: action.items,
            },
          },
        },
        waitsForInput: true,
      };
    case 'collect_digits':
      return {
        command: 'gather_digits',
        params: {
          call_id: callId,
          prompt: action.prompt,
          prompt_type: action.promptType === 'audio' ? 'audio' : 'tts',
          ...(action.audioUrl ? { audio_url: action.audioUrl } : {}),
          ...(action.promptQueue?.length
            ? {
                prompt_queue: action.promptQueue.map((item) => ({
                  prompt: item.text,
                  prompt_type: item.promptType === 'audio' ? 'audio' : 'tts',
                  ...(item.audioUrl ? { audio_url: item.audioUrl } : {}),
                  ...(item.interruptible ? { interruptible: true } : {}),
                })),
              }
            : {}),
          min_digits: action.minDigits,
          max_digits: action.maxDigits,
          end_mode: action.endMode ?? 'hash_key',
          inter_digit_timeout_sec: action.inputWaitSec ?? 5,
          timeout_sec: action.timeoutSec ?? 30,
          max_retries: action.maxRetries ?? 2,
          ...(action.retryPrompt ? { retry_prompt: action.retryPrompt } : {}),
        } satisfies Partial<RWIGatherDigitsParams>,
        waitsForInput: true,
      };
    case 'collect_verify':
      return {
        command: 'gather_digits',
        params: {
          call_id: callId,
          prompt: action.prompt,
          prompt_type: 'tts',
          min_digits: 1,
          max_digits: 1,
          end_mode: 'max_digits',
          inter_digit_timeout_sec: 5,
          timeout_sec: 10,
          max_retries: 1,
        } satisfies Partial<RWIGatherDigitsParams>,
        waitsForInput: true,
      };
    case 'transfer':
      return {
        command: 'transfer',
        params: {
          call_id: callId,
          target_type: action.targetType,
          target: action.targetValue,
          ...(action.memberSeatIds?.length ? { member_seat_ids: action.memberSeatIds } : {}),
        },
        waitsForInput: false,
      };
    case 'voicemail':
      if (isVoicemailRecordAudioProductionEnabled()) {
        return {
          command: 'record_audio',
          params: {
            call_id: callId,
            max_duration_sec: action.maxDurationSec,
            mailbox_id: action.mailboxId ?? 'default',
            play_beep: action.playBeep ?? true,
          },
          waitsForInput: true,
        };
      }
      return {
        command: 'transfer',
        params: { call_id: callId, target_type: 'voicemail', target: action.mailboxId ?? 'default' },
        waitsForInput: false,
      };
    case 'sip':
      return {
        command: 'transfer',
        params: {
          call_id: callId,
          target_type: 'sip',
          target: action.sipUri,
          ...(action.headers ? { metadata: { sip_headers: action.headers } } : {}),
        },
        waitsForInput: false,
      };
    case 'compliance':
      return {
        command: 'play_audio',
        params: {
          call_id: callId,
          prompt: action.prompt,
          prompt_type: 'tts',
          ...(action.interruptible ? { interruptible: true } : {}),
        },
        waitsForInput: false,
      };
    case 'queue':
      return {
        command: 'transfer',
        params: {
          call_id: callId,
          target_type: 'queue',
          target: action.queueName,
          strategy: action.strategy,
          timeout_sec: action.timeoutSec,
          ...(action.waitMusic ? { wait_music: action.waitMusic } : {}),
        },
        waitsForInput: false,
      };
    case 'disconnect':
      return {
        command: 'hangup',
        params: { call_id: callId },
        waitsForInput: false,
      };
    default:
      return null;
  }
}
