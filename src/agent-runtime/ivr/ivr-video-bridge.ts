/**
 * Maps IVR video actions to LiveKit / media-layer commands (Phase C).
 */
import type { IvrAction } from './ivr-executor.js';

export type VideoBridgeCommand = 'switch_avatar' | 'play_video' | 'screen_share_request';

export interface VideoCommandEnvelope {
  command: VideoBridgeCommand;
  params: Record<string, unknown>;
  /** Whether caller must send a follow-up advance when media completes */
  waitsForInput: boolean;
}

export function ivrActionToVideoCommand(
  action: IvrAction,
  callId: string
): VideoCommandEnvelope | null {
  switch (action.kind) {
    case 'avatar_switch':
      return {
        command: 'switch_avatar',
        params: {
          call_id: callId,
          direction: action.direction,
          avatar_id: action.avatarId,
        },
        waitsForInput: false,
      };
    case 'video_play':
      return {
        command: 'play_video',
        params: {
          call_id: callId,
          source_type: action.sourceType,
          video_url: action.videoUrl,
          loop: action.loop,
          skippable: action.skippable,
        },
        waitsForInput: true,
      };
    case 'screen_share':
      return {
        command: 'screen_share_request',
        params: {
          call_id: callId,
          source: action.source,
          allow_remote_control: action.allowRemoteControl,
        },
        waitsForInput: true,
      };
    default:
      return null;
  }
}
