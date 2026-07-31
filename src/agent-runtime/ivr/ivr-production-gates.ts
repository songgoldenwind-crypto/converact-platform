/** Optional provider capabilities that remain deployment-gated. */

export function isSpeechProductionEnabled(): boolean {
  return process.env.IVR_SPEECH_PRODUCTION === '1';
}

export function isVoicemailRecordAudioProductionEnabled(): boolean {
  return process.env.IVR_VOICEMAIL_RECORD_AUDIO === '1';
}
