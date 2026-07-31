export type ContactSignalKind = 'direct' | 'obfuscated' | 'intent';

export interface ContactSignal {
  policy_type: string;
  canonical_value: string;
  kind: ContactSignalKind;
  confidence: number;
}

const CHINESE_DIGITS: Readonly<Record<string, string>> = {
  '零': '0', '〇': '0', '一': '1', '二': '2', '两': '2', '三': '3',
  '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9'
};

const POSITIVE_CONTACT = /(?:联系|电话|手机|号码|手机号|加我|同号|call|phone|mobile|contact|whats\s*app|telegram|微信|微\s*信|v\s*信|wx|vx)/iu;
const NEGATIVE_NUMBER = /(?:订单|单号|批次|金额|价格|元|服务器|地址|ip|日期|时间|版本)/iu;

const INTENT_SIGNALS: ReadonlyArray<{
  policy_type: string;
  pattern: RegExp;
  confidence: number;
}> = [
  { policy_type: 'wechat', pattern: /(?:微信|微\s*信|v\s*信|加\s*v|\b(?:wx|vx|wechat|weixin)\b)/giu, confidence: 0.85 },
  { policy_type: 'whatsapp', pattern: /\bwhats\s*app\b/giu, confidence: 0.85 },
  { policy_type: 'telegram', pattern: /\btelegram\b/giu, confidence: 0.85 },
  { policy_type: 'qq', pattern: /(?:\bqq\b|企鹅号)/giu, confidence: 0.8 },
  { policy_type: 'pay_directly', pattern: /(?:\bpay\s+me\s+directly\b|私下.{0,8}(?:支付|转账)|直接.{0,8}转账|绕过.{0,8}平台|线下.{0,8}交易)/giu, confidence: 0.9 },
  { policy_type: 'outside_app', pattern: /(?:\boutside\s+(?:the\s+)?app\b|平台外|脱离平台)/giu, confidence: 0.9 }
];

export function detectContactSignals(input: string): ContactSignal[] {
  const text = String(input || '').normalize('NFKC');
  const digitText = [...text].map((character) => CHINESE_DIGITS[character] || character).join('');
  const signals: ContactSignal[] = [];

  for (const match of digitText.matchAll(/\+?[\d\s()._\-—.·]{8,48}/gu)) {
    const candidate = String(match[0] || '').trim();
    const digits = candidate.replace(/\D/g, '');
    if (!likelyPhone(digitText, candidate, digits, match.index || 0)) continue;
    signals.push({
      policy_type: 'phone_number',
      canonical_value: candidate.startsWith('+') ? `+${digits}` : digits,
      kind: /[零〇一二两三四五六七八九]/u.test(text.slice(match.index, (match.index || 0) + candidate.length)) ||
        /[\s()._\-—.·]/u.test(candidate)
        ? 'obfuscated'
        : 'direct',
      confidence: 0.95
    });
  }

  for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)) {
    signals.push({
      policy_type: 'email',
      canonical_value: String(match[0]).toLowerCase(),
      kind: 'direct',
      confidence: 0.98
    });
  }

  for (const rule of INTENT_SIGNALS) {
    for (const match of text.matchAll(rule.pattern)) {
      signals.push({
        policy_type: rule.policy_type,
        canonical_value: `${rule.policy_type}:${String(match[0]).replace(/\s+/g, '').toLowerCase()}`,
        kind: 'intent',
        confidence: rule.confidence
      });
    }
  }

  return dedupeSignals(signals);
}

function likelyPhone(text: string, candidate: string, digits: string, start: number): boolean {
  if (digits.length < 8 || digits.length > 15) return false;
  if (looksLikeIpv4(candidate)) return false;
  const context = text.slice(Math.max(0, start - 20), Math.min(text.length, start + candidate.length + 20));
  const positive = POSITIVE_CONTACT.test(context);
  if (!positive && NEGATIVE_NUMBER.test(context)) return false;
  if (candidate.startsWith('+')) return digits.length >= 8;
  if (digits.length === 11 && digits.startsWith('1')) return true;
  return positive;
}

function looksLikeIpv4(value: string): boolean {
  const compact = value.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(compact)) return false;
  return compact.split('.').every((part) => Number(part) <= 255);
}

function dedupeSignals(signals: ContactSignal[]): ContactSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.policy_type}:${signal.canonical_value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
