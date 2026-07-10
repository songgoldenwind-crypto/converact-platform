/**
 * 原则二/三 Phase B 生产闸门 — 须 ADR 确认 + 显式环境变量开启。
 */

export function isBargeInProductionEnabled(): boolean {
  return process.env.IVR_BARGE_IN_PRODUCTION === '1';
}

export function isSpeechProductionEnabled(): boolean {
  return process.env.IVR_SPEECH_PRODUCTION === '1';
}

export function isVoicemailRecordAudioProductionEnabled(): boolean {
  return process.env.IVR_VOICEMAIL_RECORD_AUDIO === '1';
}
