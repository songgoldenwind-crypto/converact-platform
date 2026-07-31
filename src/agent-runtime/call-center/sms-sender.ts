export interface SMSSendResult {
  success: boolean;
  message_sid?: string;
  error?: string;
}

export interface SMSSender {
  send(params: { to: string; body: string; tenant_id: string }): Promise<SMSSendResult>;
}

const SMS_TEMPLATES: Record<string, Record<string, string>> = {
  video_call_invite: {
    ja: '【{company}】ご案内のビデオ通話をご用意しました。下記リンクからご参加ください。\n{url}\n有効期限: 5分',
    zh: '【{company}】为您准备了视频通话，请点击链接加入：\n{url}\n有效期5分钟',
    en: '[{company}] Your video call is ready. Join here:\n{url}\nValid for 5 minutes'
  }
};

export function buildVideoInviteSms(params: {
  company?: string;
  url: string;
  language?: string;
}): string {
  const lang = params.language || 'ja';
  const template =
    SMS_TEMPLATES.video_call_invite[lang] || SMS_TEMPLATES.video_call_invite.ja;
  return template.replace('{company}', params.company || 'OPC').replace('{url}', params.url);
}

export class LogSMSSender implements SMSSender {
  readonly sent: Array<{ to: string; body: string; tenant_id: string }> = [];

  async send(params: { to: string; body: string; tenant_id: string }): Promise<SMSSendResult> {
    this.sent.push(params);
    console.log(`[sms] tenant=${params.tenant_id} to=${params.to} body=${params.body.slice(0, 80)}...`);
    return { success: true, message_sid: `dev-sms-${Date.now()}` };
  }
}

export function createSMSSender(): SMSSender {
  const provider = process.env.SMS_PROVIDER || 'log';
  if (provider === 'log') return new LogSMSSender();
  return new LogSMSSender();
}
