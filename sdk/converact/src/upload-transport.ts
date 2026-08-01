export interface ConveractFabricUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export type ConveractFabricUploadFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConveractFabricUploadRequest {
  url: string;
  headers: Record<string, string>;
  body: Exclude<RequestInit['body'], null | undefined>;
  timeoutMs: number;
  fetch?: ConveractFabricUploadFetch;
  onProgress?: (progress: ConveractFabricUploadProgress) => void;
}

export interface ConveractFabricUploadOperation<T = unknown> {
  result: Promise<T>;
  abort(): void;
}

export interface ConveractFabricUploadTransport {
  upload(request: ConveractFabricUploadRequest): ConveractFabricUploadOperation<unknown>;
}

export class ConveractFabricUploadTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown
  ) {
    super(message);
    this.name = 'ConveractFabricUploadTransportError';
  }
}

export function createConveractFabricUploadTransport(): ConveractFabricUploadTransport {
  return {
    upload(request) {
      return xhrConstructor()
        ? xhrUpload(request)
        : fetchUpload(request);
    }
  };
}

function fetchUpload(request: ConveractFabricUploadRequest): ConveractFabricUploadOperation<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const result = (async () => {
    request.onProgress?.({ loaded: 0, total: bodySize(request.body), percent: 0 });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    try {
      const fetchImpl = request.fetch || globalThis.fetch;
      if (!fetchImpl) throw new ConveractFabricUploadTransportError('fetch is required', 0, null);
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        throw new ConveractFabricUploadTransportError(
          `attachment upload failed with ${response.status}: ${errorDetail(payload)}`,
          response.status,
          payload
        );
      }
      const total = bodySize(request.body);
      request.onProgress?.({ loaded: total, total, percent: 100 });
      return payload;
    } catch (error) {
      if (error instanceof ConveractFabricUploadTransportError) throw error;
      const message = timedOut
        ? `attachment upload timed out after ${request.timeoutMs}ms`
        : controller.signal.aborted
          ? 'attachment upload aborted'
          : `attachment upload failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new ConveractFabricUploadTransportError(message, 0, null);
    } finally {
      clearTimeout(timer);
    }
  })();
  return { result, abort: () => controller.abort() };
}

function xhrUpload(request: ConveractFabricUploadRequest): ConveractFabricUploadOperation<unknown> {
  const Xhr = xhrConstructor();
  if (!Xhr) return fetchUpload(request);
  const xhr = new Xhr();
  let timedOut = false;
  const result = new Promise<unknown>((resolve, reject) => {
    xhr.open('POST', request.url, true);
    xhr.timeout = request.timeoutMs;
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : bodySize(request.body);
      const percent = total > 0 ? Math.min(100, (event.loaded / total) * 100) : 0;
      request.onProgress?.({ loaded: event.loaded, total, percent });
    };
    xhr.onload = () => {
      const payload = parseTextPayload(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ConveractFabricUploadTransportError(
          `attachment upload failed with ${xhr.status}: ${errorDetail(payload)}`,
          xhr.status,
          payload
        ));
        return;
      }
      const total = bodySize(request.body);
      request.onProgress?.({ loaded: total, total, percent: 100 });
      resolve(payload);
    };
    xhr.onerror = () => reject(new ConveractFabricUploadTransportError('attachment upload failed', 0, null));
    xhr.onabort = () => reject(new ConveractFabricUploadTransportError(
      timedOut ? `attachment upload timed out after ${request.timeoutMs}ms` : 'attachment upload aborted',
      0,
      null
    ));
    xhr.ontimeout = () => {
      timedOut = true;
      reject(new ConveractFabricUploadTransportError(`attachment upload timed out after ${request.timeoutMs}ms`, 0, null));
    };
    xhr.send(request.body);
  });
  return { result, abort: () => xhr.abort() };
}

async function readResponsePayload(response: Response): Promise<unknown> {
  return parseTextPayload(await response.text());
}

function parseTextPayload(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorDetail(payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = payload as Record<string, unknown>;
    return String(value.error || value.message || JSON.stringify(value));
  }
  return String(payload || 'empty response');
}

function bodySize(body: Exclude<RequestInit['body'], null | undefined>): number {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

interface ConveractFabricXhrProgressEvent {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

interface ConveractFabricXhr {
  status: number;
  responseText: string;
  timeout: number;
  upload: { onprogress: ((event: ConveractFabricXhrProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Exclude<RequestInit['body'], null | undefined>): void;
  abort(): void;
}

type ConveractFabricXhrConstructor = new () => ConveractFabricXhr;

function xhrConstructor(): ConveractFabricXhrConstructor | null {
  const value = (globalThis as typeof globalThis & { XMLHttpRequest?: ConveractFabricXhrConstructor }).XMLHttpRequest;
  return typeof value === 'function' ? value : null;
}
