import type { VoiceAgentSpecLanguage } from './types.js';

export interface VoiceAgentDefaultMessages {
  transfer_message: string;
  end_message: string;
  ai_disclosure: string;
  recording_consent: string;
  recording_consent_keys: string;
  privacy_notice: string;
}

const DEFAULT_MESSAGES: Record<VoiceAgentSpecLanguage, VoiceAgentDefaultMessages> = {
  zh: {
    transfer_message: '好的，正在为您转接人工客服，请稍候。',
    end_message: '感谢您的时间，祝您生活愉快，再见。',
    ai_disclosure: '本次为 AI 智能外呼服务',
    recording_consent: '本次通话可能会被录音，用于服务质量监控。',
    recording_consent_keys: '请按 1 同意录音，按 2 拒绝。',
    privacy_notice: '我们重视您的隐私，详情请参阅官网隐私政策。',
  },
  en: {
    transfer_message: 'Connecting you to a human agent. Please hold.',
    end_message: 'Thank you for your time. Goodbye.',
    ai_disclosure: 'This is an AI outbound call',
    recording_consent: 'This call may be recorded for quality assurance.',
    recording_consent_keys: 'Press 1 to consent to recording, or 2 to decline.',
    privacy_notice: 'We value your privacy. See our privacy policy for details.',
  },
  ja: {
    transfer_message: '担当者におつなぎします。少々お待ちください。',
    end_message: 'お時間をいただきありがとうございました。失礼いたします。',
    ai_disclosure: 'こちらは AI による発信サービスです',
    recording_consent: 'この通話は品質向上のため録音される場合があります。',
    recording_consent_keys: '録音に同意する場合は 1、拒否する場合は 2 を押してください。',
    privacy_notice: 'お客様のプライバシーを尊重しています。',
  },
  vi: {
    transfer_message: 'Đang chuyển bạn đến nhân viên tư vấn. Vui lòng giữ máy.',
    end_message: 'Cảm ơn bạn đã liên hệ. Chúc một ngày tốt lành!',
    ai_disclosure: 'Đây là cuộc gọi tự động bởi AI',
    recording_consent: 'Cuộc gọi này có thể được ghi âm để đảm bảo chất lượng.',
    recording_consent_keys: 'Nhấn 1 để đồng ý ghi âm, hoặc 2 để từ chối.',
    privacy_notice: 'Chúng tôi tôn trọng quyền riêng tư của bạn.',
  },
};

export function voiceAgentDefaults(language: VoiceAgentSpecLanguage = 'zh'): VoiceAgentDefaultMessages {
  return DEFAULT_MESSAGES[language] || DEFAULT_MESSAGES.zh;
}
