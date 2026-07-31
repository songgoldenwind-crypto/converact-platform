import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sanitizeProviderRequestId } from './provider-safety.js';
import type { SecureFileDerivativeKind } from './secure-file-types.js';

const DEFAULT_MAX_INPUT_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface FileDerivativeInput {
  tenant_id: string;
  secure_file_id: string;
  derivative_kind: SecureFileDerivativeKind;
  source_mime: string;
  content: Buffer;
}

export interface FileDerivativeOutput {
  content: Buffer;
  mime: string;
  extension: string;
  provider_request_id?: string;
  metadata: Record<string, unknown>;
}

export interface FileDerivativeProvider {
  readonly name: string;
  readonly mode: 'local' | 'self_hosted' | 'third_party';
  derive(input: FileDerivativeInput): Promise<FileDerivativeOutput>;
}

export class FileDerivativeProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'FileDerivativeProviderError';
  }
}

export interface FfmpegDerivativeSpec {
  args: string[];
  mime: string;
  extension: string;
}

export function ffmpegDerivativeSpec(
  kind: SecureFileDerivativeKind,
  sourceMimeInput: string,
  inputPath: string,
  outputPath: string
): FfmpegDerivativeSpec {
  const sourceMime = mimeValue(sourceMimeInput, 'source MIME');
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (kind === 'image_thumbnail') {
    assertMimeFamily(sourceMime, 'image/');
    return {
      args: [
        ...common, '-i', inputPath,
        '-vf', 'scale=480:480:force_original_aspect_ratio=decrease',
        '-frames:v', '1', '-q:v', '3', outputPath
      ],
      mime: 'image/jpeg', extension: '.jpg'
    };
  }
  if (kind === 'video_thumbnail') {
    assertMimeFamily(sourceMime, 'video/');
    return {
      args: [
        ...common, '-ss', '1', '-i', inputPath,
        '-vf', 'scale=480:480:force_original_aspect_ratio=decrease',
        '-frames:v', '1', '-q:v', '3', outputPath
      ],
      mime: 'image/jpeg', extension: '.jpg'
    };
  }
  if (kind === 'video_transcode') {
    assertMimeFamily(sourceMime, 'video/');
    return {
      args: [
        ...common, '-i', inputPath,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale='min(1920,iw)':-2",
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', outputPath
      ],
      mime: 'video/mp4', extension: '.mp4'
    };
  }
  if (kind === 'audio_transcode') {
    assertMimeFamily(sourceMime, 'audio/');
    return {
      args: [
        ...common, '-i', inputPath, '-vn', '-c:a', 'libopus',
        '-b:a', '64k', outputPath
      ],
      mime: 'audio/ogg', extension: '.ogg'
    };
  }
  throw derivativeError('derivative kind is invalid', 'derivative_kind_invalid', false, 400);
}

export type FfmpegProcessRunner = (
  executable: string,
  args: string[],
  options: { shell: false; timeoutMs: number; maxStderrBytes: number }
) => Promise<void>;

export interface LocalFfmpegDerivativeProviderConfig {
  executable?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxStderrBytes?: number;
  runner?: FfmpegProcessRunner;
  name?: string;
}

export function createLocalFfmpegDerivativeProvider(
  config: LocalFfmpegDerivativeProviderConfig = {}
): FileDerivativeProvider {
  const executable = boundedSingleLine(config.executable || 'ffmpeg', 'FFmpeg executable', 1_024);
  const timeoutMs = boundedInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 30 * 60_000, 'FFmpeg timeout');
  const maxInputBytes = boundedInteger(
    config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, 1, 10 * 1024 * 1024 * 1024, 'FFmpeg input limit'
  );
  const maxOutputBytes = boundedInteger(
    config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1, 10 * 1024 * 1024 * 1024, 'FFmpeg output limit'
  );
  const maxStderrBytes = boundedInteger(config.maxStderrBytes ?? 64 * 1024, 1_024, 1024 * 1024, 'FFmpeg stderr limit');
  const runner = config.runner || runFfmpeg;
  return {
    name: boundedSingleLine(config.name || 'ffmpeg', 'provider name', 100),
    mode: 'local',
    async derive(input) {
      assertDerivativeInput(input, maxInputBytes);
      const sourceExtension = sourceExtensionForMime(input.source_mime);
      const directory = mkdtempSync(join(tmpdir(), 'ivekit-derivative-'));
      const inputPath = join(directory, `input${sourceExtension}`);
      let outputPath = '';
      try {
        const preliminary = ffmpegDerivativeSpec(
          input.derivative_kind, input.source_mime, inputPath, join(directory, 'output')
        );
        outputPath = join(directory, `output${preliminary.extension}`);
        const spec = ffmpegDerivativeSpec(
          input.derivative_kind, input.source_mime, inputPath, outputPath
        );
        writeFileSync(inputPath, input.content, { flag: 'wx', mode: 0o600 });
        chmodSync(directory, 0o700);
        await runner(executable, spec.args, { shell: false, timeoutMs, maxStderrBytes });
        const size = outputFileSize(outputPath, maxOutputBytes);
        if (size === 0) {
          throw derivativeError('file derivative output is empty', 'derivative_output_empty', false);
        }
        return {
          content: readFileSync(outputPath),
          mime: spec.mime,
          extension: spec.extension,
          metadata: { engine: 'ffmpeg' }
        };
      } catch (error) {
        if (error instanceof FileDerivativeProviderError) throw error;
        throw derivativeError('file derivative process failed', 'derivative_process_failed', true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  };
}

export interface HttpFileDerivativeProviderConfig {
  mode: 'self_hosted' | 'third_party';
  baseUrl: string;
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  fetch?: typeof fetch;
  name?: string;
}

export function createHttpFileDerivativeProvider(
  config: HttpFileDerivativeProviderConfig
): FileDerivativeProvider {
  const baseUrl = boundedSingleLine(config.baseUrl, 'derivative baseUrl', 2_048);
  const endpoint = new URL(
    String(config.endpoint || '/v1/derive').replace(/^\//, ''),
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  ).toString();
  const timeoutMs = boundedInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 30 * 60_000, 'derivative timeout');
  const maxInputBytes = boundedInteger(
    config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, 1, 10 * 1024 * 1024 * 1024, 'derivative input limit'
  );
  const maxOutputBytes = boundedInteger(
    config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1, 10 * 1024 * 1024 * 1024, 'derivative output limit'
  );
  const token = String(config.token || '');
  const fetchImpl = config.fetch || fetch;
  return {
    name: boundedSingleLine(
      config.name || `${config.mode}-file-derivative`, 'provider name', 100
    ),
    mode: config.mode,
    async derive(input) {
      assertDerivativeInput(input, maxInputBytes);
      const expected = ffmpegDerivativeSpec(input.derivative_kind, input.source_mime, 'input', 'output');
      const form = new FormData();
      form.set(
        'file',
        new Blob([new Uint8Array(input.content)], { type: input.source_mime }),
        `source${sourceExtensionForMime(input.source_mime)}`
      );
      form.set('tenant_id', input.tenant_id);
      form.set('secure_file_id', input.secure_file_id);
      form.set('derivative_kind', input.derivative_kind);
      form.set('source_mime', input.source_mime);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          body: form
        });
      } catch {
        throw derivativeError(
          controller.signal.aborted ? 'file derivative provider timed out' : 'file derivative provider is unavailable',
          controller.signal.aborted ? 'derivative_timeout' : 'derivative_unavailable',
          true
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw derivativeError(
          `file derivative provider returned HTTP ${response.status}`,
          `derivative_http_${response.status}`,
          response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
          response.status
        );
      }
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > maxOutputBytes) {
        throw derivativeError('file derivative output is too large', 'derivative_output_too_large', false, 413);
      }
      const content = Buffer.from(await response.arrayBuffer());
      if (content.length === 0) {
        throw derivativeError('file derivative output is empty', 'derivative_output_empty', false);
      }
      if (content.length > maxOutputBytes) {
        throw derivativeError('file derivative output is too large', 'derivative_output_too_large', false, 413);
      }
      const mime = normalizedResponseMime(response.headers.get('content-type'));
      if (mime !== expected.mime) {
        throw derivativeError('file derivative output MIME is invalid', 'derivative_output_mime_invalid', false);
      }
      const requestId = sanitizeProviderRequestId(response.headers.get('x-request-id'));
      return {
        content,
        mime,
        extension: expected.extension,
        ...(requestId ? { provider_request_id: requestId } : {}),
        metadata: { engine: 'http-media' }
      };
    }
  };
}

async function runFfmpeg(
  executable: string,
  args: string[],
  options: { shell: false; timeoutMs: number; maxStderrBytes: number }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(derivativeError('file derivative process timed out', 'derivative_timeout', true));
    }, options.timeoutMs);
    timeout.unref?.();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxStderrBytes) {
        child.kill('SIGKILL');
        finish(derivativeError('file derivative diagnostics are too large', 'derivative_process_failed', true));
      }
    });
    child.once('error', () => finish(derivativeError(
      'file derivative executable is unavailable', 'derivative_unavailable', true
    )));
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else if (signal === 'SIGKILL' && settled) return;
      else finish(derivativeError('file derivative process failed', 'derivative_process_failed', true));
    });
  });
}

function assertDerivativeInput(input: FileDerivativeInput, maxInputBytes: number): void {
  boundedSingleLine(input.tenant_id, 'tenant_id', 255);
  boundedSingleLine(input.secure_file_id, 'secure_file_id', 255);
  mimeValue(input.source_mime, 'source MIME');
  if (!Buffer.isBuffer(input.content) || input.content.length === 0) {
    throw derivativeError('file derivative content is required', 'derivative_input_invalid', false, 400);
  }
  if (input.content.length > maxInputBytes) {
    throw derivativeError('file derivative input is too large', 'derivative_input_too_large', false, 413);
  }
}

function assertMimeFamily(mime: string, family: string): void {
  if (!mime.startsWith(family)) {
    throw derivativeError('source MIME is not supported for derivative kind', 'derivative_source_mime_invalid', false, 400);
  }
}

function sourceExtensionForMime(mimeInput: string): string {
  const mime = mimeValue(mimeInput, 'source MIME');
  const known: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'audio/mp4': '.m4a', 'audio/webm': '.webm'
  };
  return known[mime] || '.bin';
}

function outputFileSize(path: string, maxBytes: number): number {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw derivativeError('file derivative output is missing', 'derivative_output_missing', true);
  }
  if (size > maxBytes) {
    throw derivativeError('file derivative output is too large', 'derivative_output_too_large', false, 413);
  }
  return size;
}

function normalizedResponseMime(value: string | null): string {
  const mime = String(value || '').split(';', 1)[0]?.trim().toLowerCase() || '';
  return mimeValue(mime, 'output MIME');
}

function mimeValue(value: unknown, field: string): string {
  const mime = boundedSingleLine(String(value || '').toLowerCase(), field, 255);
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)) {
    throw derivativeError(`${field} is invalid`, 'derivative_mime_invalid', false, 400);
  }
  return mime;
}

function boundedSingleLine(value: string, field: string, maxLength: number): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw derivativeError(`${field} is invalid`, 'derivative_input_invalid', false, 400);
  }
  return normalized;
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw derivativeError(`${field} must be between ${min} and ${max}`, 'derivative_config_invalid', false);
  }
  return value;
}

function derivativeError(
  message: string,
  code: string,
  retryable: boolean,
  status?: number
): FileDerivativeProviderError {
  return new FileDerivativeProviderError(message, code, retryable, status);
}
