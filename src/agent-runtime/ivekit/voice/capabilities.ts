import type { VoiceCapability } from './types.js';

export const VOICE_CAPABILITIES: readonly VoiceCapability[] = [
  'management_http',
  'json_rpc_routing',
  'step_ivr',
  'rwi',
  'webrtc_extension',
  'recording',
  'sipflow',
  'queue',
  'postgres_backend'
];
