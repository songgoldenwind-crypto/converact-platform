import type {
  IveKitChatAttachmentResult,
  IveKitChatAttachmentUploadDescriptor,
  IveKitChatBinding,
  IveKitChatCapabilities,
  IveKitChatClientPlan,
  IveKitChatClientPlanInput,
  IveKitChatDeleteInput,
  IveKitChatDeliveryResult,
  IveKitChatEditInput,
  IveKitChatMessage,
  IveKitChatMessageInput,
  IveKitChatMessagePageInput,
  IveKitChatMessageState,
  IveKitChatMutationListResult,
  IveKitChatMutationResult,
  IveKitChatParticipant,
  IveKitChatParticipantInput,
  IveKitChatPostMessageResult,
  IveKitChatPresenceInput,
  IveKitChatReceiptInput,
  IveKitChatReceiptListResult,
  IveKitChatReceiptResult,
  IveKitChatRealtimeResult,
  IveKitChatSession,
  IveKitChatSessionListInput,
  IveKitChatSnapshot,
  IveKitChatTypingInput,
  IveKitOpenChatSessionInput,
  IveKitCursorPage,
  IveKitPolicyFindingListResult,
  IveKitPolicyFindingResult,
  IveKitPolicyFindingReviewInput,
  IveKitQualityReviewResult,
  IveKitWorkerRunResult
} from './chat-types.js';

export type IveKitSdkFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type IveKitSdkRequestBody = Exclude<RequestInit['body'], null | undefined>;

export interface IveKitHttpSdkInput {
  baseUrl: string;
  tenantId: string;
  apiKey?: string;
  accessToken?: string;
  userId?: string;
  timeoutMs?: number;
  fetch?: IveKitSdkFetch;
}

export interface IveKitSdkBusinessRef {
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface IveKitSdkBinary {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface IveKitMediaHttpClient {
  getCapabilities(): Promise<Record<string, unknown>>;
  createRoom(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getRoom(roomName: string): Promise<Record<string, unknown>>;
  closeRoom(roomName: string): Promise<Record<string, unknown>>;
  createJoinPlan(roomName: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listParticipants(
    roomName: string,
    input?: { include_left?: boolean; limit?: number }
  ): Promise<Record<string, unknown>[]>;
  startRecording(roomName: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  stopRecording(egressId: string): Promise<Record<string, unknown>>;
  listRecordings(input?: { limit?: number }): Promise<Record<string, unknown>[]>;
  getRecording(recordingId: string): Promise<Record<string, unknown>>;
  inspectRecordingObject(recordingId: string): Promise<Record<string, unknown>>;
  exportRecordingObject(recordingId: string): Promise<IveKitSdkBinary>;
  cleanupRecordings(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface IveKitAttachmentUploadInput {
  kind: 'image' | 'video' | 'audio' | 'file' | 'screen_recording';
  filename: string;
  contentType: string;
  body: IveKitSdkRequestBody;
}

export interface IveKitChatHttpClient {
  getCapabilities(): Promise<IveKitChatCapabilities>;
  openSession(input: IveKitOpenChatSessionInput): Promise<IveKitChatSession>;
  listSessions(input?: IveKitChatSessionListInput): Promise<IveKitCursorPage<IveKitChatSession>>;
  listSessionsByBusinessRef(
    businessRef: IveKitSdkBusinessRef,
    input?: { limit?: number }
  ): Promise<IveKitChatSession[]>;
  bindSession(sessionId: string, input?: Record<string, unknown>): Promise<IveKitChatBinding>;
  createClientPlan(sessionId: string, input: IveKitChatClientPlanInput): Promise<IveKitChatClientPlan>;
  addParticipant(sessionId: string, input: IveKitChatParticipantInput): Promise<IveKitChatParticipant>;
  leaveParticipant(sessionId: string, input: { identity?: string }): Promise<IveKitChatParticipant | null>;
  listMessages(sessionId: string, input?: { limit?: number }): Promise<IveKitChatMessage[]>;
  listMessagesPage(
    sessionId: string,
    input?: IveKitChatMessagePageInput
  ): Promise<IveKitCursorPage<IveKitChatMessage>>;
  postMessage(
    sessionId: string,
    input: IveKitChatMessageInput,
    options?: { idempotencyKey?: string }
  ): Promise<IveKitChatPostMessageResult>;
  getSnapshot(sessionId: string, input?: { limit?: number }): Promise<IveKitChatSnapshot>;
  getDelivery(sessionId: string, messageId: string): Promise<IveKitChatDeliveryResult>;
  retryDelivery(sessionId: string, messageId: string): Promise<IveKitChatDeliveryResult>;
  listReceipts(sessionId: string, messageId: string): Promise<IveKitChatReceiptListResult>;
  markReceipt(
    sessionId: string,
    messageId: string,
    input: IveKitChatReceiptInput
  ): Promise<IveKitChatReceiptResult>;
  getMessageState(sessionId: string): Promise<IveKitChatMessageState>;
  setTyping(sessionId: string, input: IveKitChatTypingInput): Promise<IveKitChatRealtimeResult>;
  setPresence(sessionId: string, input: IveKitChatPresenceInput): Promise<IveKitChatRealtimeResult>;
  listRealtimeState(sessionId: string): Promise<IveKitChatRealtimeResult>;
  editMessage(
    sessionId: string,
    messageId: string,
    input: IveKitChatEditInput
  ): Promise<IveKitChatMutationResult>;
  deleteMessage(
    sessionId: string,
    messageId: string,
    input?: IveKitChatDeleteInput
  ): Promise<IveKitChatMutationResult>;
  listMutations(sessionId: string, messageId: string): Promise<IveKitChatMutationListResult>;
  uploadAttachment(sessionId: string, input: IveKitAttachmentUploadInput): Promise<IveKitChatAttachmentUploadDescriptor>;
  getAttachment(sessionId: string, attachmentId: string): Promise<IveKitChatAttachmentResult>;
  retryAttachment(sessionId: string, attachmentId: string): Promise<IveKitChatAttachmentResult>;
  listFindings(
    sessionId: string,
    input?: { message_id?: string; source?: string; review_status?: string; limit?: number }
  ): Promise<IveKitPolicyFindingListResult>;
  getFinding(sessionId: string, findingId: string): Promise<IveKitPolicyFindingResult>;
  reviewFinding(
    sessionId: string,
    findingId: string,
    input: IveKitPolicyFindingReviewInput
  ): Promise<IveKitPolicyFindingResult>;
  getQualityReview(sessionId: string, messageId: string): Promise<IveKitQualityReviewResult>;
  enqueueQualityReview(sessionId: string, messageId: string): Promise<IveKitQualityReviewResult>;
  runAttachmentProcessing(input?: { limit?: number }): Promise<IveKitWorkerRunResult>;
  runQualityReview(input?: { limit?: number }): Promise<IveKitWorkerRunResult>;
}

export interface IveKitHttpSdk {
  media: IveKitMediaHttpClient;
  chat: IveKitChatHttpClient;
}

export class IveKitHttpSdkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly payload: unknown
  ) {
    super(message);
    this.name = 'IveKitHttpSdkError';
  }
}

export function createIveKitHttpSdk(input: IveKitHttpSdkInput): IveKitHttpSdk {
  const transport = createTransport(input);
  return {
    media: createMediaClient(transport),
    chat: createChatClient(transport)
  };
}

interface IveKitTransport {
  json<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      rawBody?: IveKitSdkRequestBody;
      contentType?: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    }
  ): Promise<T>;
  binary(method: string, path: string): Promise<IveKitSdkBinary>;
}

function createTransport(input: IveKitHttpSdkInput): IveKitTransport {
  const baseUrl = validBaseUrl(input.baseUrl);
  const tenantId = requiredString(input.tenantId, 'tenantId is required');
  const apiKey = String(input.apiKey || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  if (Boolean(apiKey) === Boolean(accessToken)) {
    throw new Error('exactly one of apiKey or accessToken is required');
  }
  const userId = String(input.userId || '').trim();
  const timeoutMs = validTimeout(input.timeoutMs);
  const fetchImpl = input.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is required');

  const send = async (
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: IveKitSdkRequestBody;
      contentType?: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {}
  ): Promise<Response> => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      'x-tenant-id': tenantId,
      ...(apiKey ? { 'x-api-key': apiKey } : { authorization: `Bearer ${accessToken}` }),
      ...(apiKey && userId ? { 'x-user-id': userId } : {}),
      ...(options.headers || {})
    };
    const init: RequestInit = { method, headers };
    if (options.rawBody !== undefined) {
      init.body = options.rawBody;
      if (options.contentType) headers['content-type'] = options.contentType;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url.toString(), init);
    } catch (error) {
      const message = controller.signal.aborted
        ? `${method} ${path} timed out after ${timeoutMs}ms`
        : `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new IveKitHttpSdkError(message, 0, method, path, null);
    } finally {
      clearTimeout(timer);
    }
  };

  const requireOk = async (response: Response, method: string, path: string): Promise<void> => {
    if (response.ok) return;
    const payload = await readPayload(response);
    throw new IveKitHttpSdkError(
      `${method} ${path} failed with ${response.status}: ${errorDetail(payload)}`,
      response.status,
      method,
      path,
      payload
    );
  };

  return {
    async json<T>(method: string, path: string, options = {}) {
      const response = await send(method, path, options);
      await requireOk(response, method, path);
      return await readPayload(response) as T;
    },
    async binary(method, path) {
      const response = await send(method, path);
      await requireOk(response, method, path);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        filename: responseFilename(response.headers.get('content-disposition'))
      };
    }
  };
}

function createMediaClient(transport: IveKitTransport): IveKitMediaHttpClient {
  const roomPath = (roomName: string) => `/api/ivekit/media/rooms/${pathSegment(roomName, 'roomName')}`;
  const recordingPath = (recordingId: string) =>
    `/api/ivekit/media/recordings/${pathSegment(recordingId, 'recordingId')}`;
  return {
    getCapabilities: () => transport.json('GET', '/api/ivekit/media/capabilities'),
    createRoom: (input) => transport.json('POST', '/api/ivekit/media/rooms', { body: input }),
    getRoom: (roomName) => transport.json('GET', roomPath(roomName)),
    closeRoom: (roomName) => transport.json('POST', `${roomPath(roomName)}/close`, { body: {} }),
    createJoinPlan: (roomName, input) => transport.json('POST', `${roomPath(roomName)}/join`, { body: input }),
    listParticipants: (roomName, input = {}) => transport.json(
      'GET',
      `${roomPath(roomName)}/participants`,
      {
        query: {
          include_left: input.include_left ? '1' : '',
          limit: optionalNumber(input.limit)
        }
      }
    ),
    startRecording: (roomName, input) => transport.json(
      'POST',
      `${roomPath(roomName)}/recordings/start`,
      { body: input }
    ),
    stopRecording: (egressId) => transport.json(
      'POST',
      `/api/ivekit/media/recordings/${pathSegment(egressId, 'egressId')}/stop`,
      { body: {} }
    ),
    listRecordings: (input = {}) => transport.json('GET', '/api/ivekit/media/recordings', {
      query: { limit: optionalNumber(input.limit) }
    }),
    getRecording: (recordingId) => transport.json('GET', recordingPath(recordingId)),
    inspectRecordingObject: (recordingId) => transport.json('GET', `${recordingPath(recordingId)}/object`),
    exportRecordingObject: (recordingId) => transport.binary('GET', `${recordingPath(recordingId)}/export`),
    cleanupRecordings: (input = {}) => transport.json(
      'POST',
      '/api/ivekit/media/recordings/retention/cleanup',
      { body: input }
    )
  };
}

function createChatClient(transport: IveKitTransport): IveKitChatHttpClient {
  const sessionPath = (sessionId: string) =>
    `/api/ivekit/chat/sessions/${pathSegment(sessionId, 'sessionId')}`;
  const messagePath = (sessionId: string, messageId: string) =>
    `${sessionPath(sessionId)}/messages/${pathSegment(messageId, 'messageId')}`;
  const attachmentPath = (sessionId: string, attachmentId: string) =>
    `${sessionPath(sessionId)}/attachments/${pathSegment(attachmentId, 'attachmentId')}`;
  const findingPath = (sessionId: string, findingId: string) =>
    `${sessionPath(sessionId)}/findings/${pathSegment(findingId, 'findingId')}`;

  return {
    getCapabilities: () => transport.json('GET', '/api/ivekit/chat/capabilities'),
    openSession: (input) => transport.json('POST', '/api/ivekit/chat/sessions', { body: input }),
    listSessions: (input = {}) => transport.json('GET', '/api/ivekit/chat/sessions', {
      query: {
        status: input.status || '',
        business_ref_type: input.business_ref_type || '',
        business_ref_id: input.business_ref_id || '',
        query: input.query || '',
        cursor: input.cursor || '',
        limit: optionalNumber(input.limit)
      }
    }),
    listSessionsByBusinessRef: (businessRef, input = {}) => transport.json(
      'GET',
      '/api/ivekit/chat/sessions/by-ref',
      {
        query: {
          business_ref_type: requiredString(businessRef.type, 'businessRef.type is required'),
          business_ref_id: requiredString(businessRef.id, 'businessRef.id is required'),
          limit: optionalNumber(input.limit)
        }
      }
    ),
    bindSession: (sessionId, input = {}) => transport.json('POST', `${sessionPath(sessionId)}/bind`, { body: input }),
    createClientPlan: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/client-plan`,
      { body: input }
    ),
    addParticipant: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/participants`,
      { body: input }
    ),
    leaveParticipant: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/participants/leave`,
      { body: input }
    ),
    listMessages: (sessionId, input = {}) => transport.json(
      'GET',
      `${sessionPath(sessionId)}/messages`,
      { query: { limit: optionalNumber(input.limit) } }
    ),
    listMessagesPage: (sessionId, input = {}) => transport.json(
      'GET',
      `${sessionPath(sessionId)}/messages`,
      {
        query: {
          direction: input.direction || 'before',
          query: input.query || '',
          cursor: input.cursor || '',
          limit: optionalNumber(input.limit)
        }
      }
    ),
    postMessage: (sessionId, input, options = {}) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/messages`,
      {
        body: input,
        headers: options.idempotencyKey
          ? { 'idempotency-key': requiredString(options.idempotencyKey, 'idempotencyKey is required') }
          : undefined
      }
    ),
    getSnapshot: (sessionId, input = {}) => transport.json(
      'GET',
      `${sessionPath(sessionId)}/snapshot`,
      { query: { limit: optionalNumber(input.limit) } }
    ),
    getDelivery: (sessionId, messageId) => transport.json('GET', `${messagePath(sessionId, messageId)}/delivery`),
    retryDelivery: (sessionId, messageId) => transport.json(
      'POST',
      `${messagePath(sessionId, messageId)}/delivery/retry`,
      { body: {} }
    ),
    listReceipts: (sessionId, messageId) => transport.json('GET', `${messagePath(sessionId, messageId)}/receipts`),
    markReceipt: (sessionId, messageId, input) => transport.json(
      'POST',
      `${messagePath(sessionId, messageId)}/receipts`,
      { body: input }
    ),
    getMessageState: (sessionId) => transport.json('GET', `${sessionPath(sessionId)}/message-state`),
    setTyping: (sessionId, input) => transport.json('POST', `${sessionPath(sessionId)}/typing`, { body: input }),
    setPresence: (sessionId, input) => transport.json('POST', `${sessionPath(sessionId)}/presence`, { body: input }),
    listRealtimeState: (sessionId) => transport.json('GET', `${sessionPath(sessionId)}/realtime-state`),
    editMessage: (sessionId, messageId, input) => transport.json(
      'PATCH',
      messagePath(sessionId, messageId),
      { body: input }
    ),
    deleteMessage: (sessionId, messageId, input = {}) => transport.json(
      'DELETE',
      messagePath(sessionId, messageId),
      { body: input }
    ),
    listMutations: (sessionId, messageId) => transport.json('GET', `${messagePath(sessionId, messageId)}/mutations`),
    uploadAttachment: (sessionId, input) => transport.json(
      'POST',
      `${sessionPath(sessionId)}/attachments/upload`,
      {
        rawBody: input.body,
        contentType: requiredString(input.contentType, 'contentType is required'),
        query: {
          kind: requiredString(input.kind, 'kind is required'),
          filename: requiredString(input.filename, 'filename is required')
        }
      }
    ),
    getAttachment: (sessionId, attachmentId) => transport.json('GET', attachmentPath(sessionId, attachmentId)),
    retryAttachment: (sessionId, attachmentId) => transport.json(
      'POST',
      `${attachmentPath(sessionId, attachmentId)}/retry`,
      { body: {} }
    ),
    listFindings: (sessionId, input = {}) => transport.json('GET', `${sessionPath(sessionId)}/findings`, {
      query: {
        message_id: input.message_id || '',
        source: input.source || '',
        review_status: input.review_status || '',
        limit: optionalNumber(input.limit)
      }
    }),
    getFinding: (sessionId, findingId) => transport.json('GET', findingPath(sessionId, findingId)),
    reviewFinding: (sessionId, findingId, input) => transport.json(
      'POST',
      `${findingPath(sessionId, findingId)}/review`,
      { body: input }
    ),
    getQualityReview: (sessionId, messageId) => transport.json(
      'GET',
      `${messagePath(sessionId, messageId)}/quality-review`
    ),
    enqueueQualityReview: (sessionId, messageId) => transport.json(
      'POST',
      `${messagePath(sessionId, messageId)}/quality-review`,
      { body: {} }
    ),
    runAttachmentProcessing: (input = {}) => transport.json(
      'POST',
      '/api/ivekit/chat/attachment-processing/run',
      { body: input }
    ),
    runQualityReview: (input = {}) => transport.json(
      'POST',
      '/api/ivekit/chat/quality-review/run',
      { body: input }
    )
  };
}

function validBaseUrl(value: string): URL {
  const parsed = new URL(requiredString(value, 'baseUrl is required'));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http(s)');
  }
  return parsed;
}

function validTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error('timeoutMs must be an integer between 100 and 300000');
  }
  return value;
}

function requiredString(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function pathSegment(value: unknown, field: string): string {
  return encodeURIComponent(requiredString(value, `${field} is required`));
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseFilename(contentDisposition: string | null): string {
  if (!contentDisposition) return 'download.bin';
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return contentDisposition.match(/filename="([^"]+)"/i)?.[1] ||
    contentDisposition.match(/filename=([^;]+)/i)?.[1]?.trim() ||
    'download.bin';
}

function errorDetail(payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : null;
    return String(record.error && typeof record.error !== 'object'
      ? record.error
      : nested?.message || record.message || JSON.stringify(record));
  }
  return String(payload || 'empty response');
}
