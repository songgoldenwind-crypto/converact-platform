export interface CustomerMediaJoinInput {
  roomName: string;
  identity: string;
  tenantId: string;
  invite?: string;
  expiresAt?: string;
  media?: 'voice' | 'video';
}

export interface CustomerLiveKitToken {
  token: string;
  livekit_url?: string;
  url?: string;
}

export interface CustomerMediaJoinPlan {
  mode?: string;
  channel?: string;
  token: CustomerLiveKitToken;
  joinPath?: string;
}

export interface CustomerMediaJoinHttpResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface CustomerMediaJoinFetchResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type CustomerMediaJoinFetcher = (
  path: string
) => Promise<CustomerMediaJoinFetchResult>;

export type CustomerMediaJoinFailureCode =
  | 'invite_invalid_or_expired'
  | 'room_closed'
  | 'room_not_found'
  | 'token_missing'
  | 'livekit_url_missing'
  | 'invalid_response'
  | 'request_failed';

export class CustomerMediaJoinError extends Error {
  constructor(
    message: string,
    readonly code: CustomerMediaJoinFailureCode,
    readonly status?: number
  ) {
    super(message);
    this.name = 'CustomerMediaJoinError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessageFromBody(body: unknown, status: number): string {
  if (isRecord(body)) {
    const error = body.error;
    if (typeof error === 'string' && error) return error;
    if (isRecord(error) && typeof error.message === 'string' && error.message) {
      return error.message;
    }
  }
  return `Media join failed: ${status}`;
}

function failureCodeForHttpError(message: string, status: number): CustomerMediaJoinFailureCode {
  if (status === 401 && /invite/i.test(message)) return 'invite_invalid_or_expired';
  if (status === 409 && /closed/i.test(message)) return 'room_closed';
  if (status === 404) return 'room_not_found';
  return 'request_failed';
}

export function customerMediaJoinErrorMessage(error: unknown): string {
  if (!(error instanceof CustomerMediaJoinError)) {
    return error instanceof Error ? error.message : '音视频连接失败，请稍后重试';
  }
  switch (error.code) {
    case 'invite_invalid_or_expired':
      return '邀请已失效或签名无效，请重新获取邀请链接';
    case 'room_closed':
      return '通话已结束';
    case 'room_not_found':
      return '通话房间不存在';
    case 'token_missing':
    case 'livekit_url_missing':
    case 'invalid_response':
      return '音视频服务配置不完整，请联系支持人员';
    case 'request_failed':
      return '暂时无法加入通话，请稍后重试';
  }
}

function unwrapDataEnvelope(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return body.data;
  return body;
}

export function buildCustomerMediaJoinPath(input: CustomerMediaJoinInput): string {
  const params = new URLSearchParams({
    channel: 'webrtc',
    room_name: input.roomName,
    identity: input.identity,
    role: 'customer',
    tenant_id: input.tenantId,
    media: input.media || 'video'
  });
  if (input.invite) params.set('invite', input.invite);
  if (input.expiresAt) params.set('expires_at', input.expiresAt);
  return `/api/media/livekit/join?${params.toString()}`;
}

export function readCustomerMediaJoinPlan(
  result: CustomerMediaJoinHttpResult
): CustomerMediaJoinPlan {
  if (!result.ok) {
    const message = errorMessageFromBody(result.body, result.status);
    throw new CustomerMediaJoinError(
      message,
      failureCodeForHttpError(message, result.status),
      result.status
    );
  }

  const plan = unwrapDataEnvelope(result.body);
  if (!isRecord(plan)) {
    throw new CustomerMediaJoinError('invalid media join response', 'invalid_response', result.status);
  }
  if (!isRecord(plan.token)) {
    throw new CustomerMediaJoinError('invalid media join response: token missing', 'token_missing', result.status);
  }
  const token = plan.token;
  const tokenValue = token.token;
  if (typeof tokenValue !== 'string' || !tokenValue.trim()) {
    throw new CustomerMediaJoinError('invalid media join response: token missing', 'token_missing', result.status);
  }
  const liveKitUrl = token.livekit_url || token.url;
  if (
    !tokenValue.startsWith('dev-token:') &&
    (typeof liveKitUrl !== 'string' || !liveKitUrl.trim())
  ) {
    throw new CustomerMediaJoinError(
      'livekit url is required for media join response',
      'livekit_url_missing',
      result.status
    );
  }
  return plan as unknown as CustomerMediaJoinPlan;
}

export async function fetchCustomerMediaJoinPlan(
  fetcher: CustomerMediaJoinFetcher,
  input: CustomerMediaJoinInput
): Promise<CustomerMediaJoinPlan> {
  const response = await fetcher(buildCustomerMediaJoinPath(input));
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return readCustomerMediaJoinPlan({
    ok: response.ok,
    status: response.status,
    body
  });
}
