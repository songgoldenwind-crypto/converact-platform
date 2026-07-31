/**
 * Build channelVariables for start.pushParams (SU-1.2).
 */
import type { CallRouterRequest } from '../call-center/types.js';

function extractPhone(uri: string): string {
  const match = String(uri).match(/\+?\d{8,15}/);
  return match ? match[0] : '';
}

/** Map inbound call metadata + SIP headers → start.pushParams channel.* / custom.* sources. */
export function buildChannelVariablesFromInbound(
  request: CallRouterRequest,
  metadata: Record<string, string> = {}
): Record<string, string> {
  const vars: Record<string, string> = { ...metadata };

  const phone = extractPhone(request.from_uri || request.from || '');
  if (phone) vars.caller_phone = phone;

  if (request.headers) {
    for (const [key, value] of Object.entries(request.headers)) {
      vars[`custom.${key}`] = value;
    }
  }

  return vars;
}
