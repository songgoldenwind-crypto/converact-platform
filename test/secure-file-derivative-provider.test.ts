import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import {
  FileDerivativeProviderError,
  createHttpFileDerivativeProvider,
  createLocalFfmpegDerivativeProvider,
  ffmpegDerivativeSpec
} from '../src/agent-runtime/collaboration/file-derivative-provider.js';

test('FFmpeg derivative specs use fixed bounded arguments for every capability', () => {
  const cases = [
    ['image_thumbnail', 'image/png', 'image/jpeg', '.jpg'],
    ['video_thumbnail', 'video/mp4', 'image/jpeg', '.jpg'],
    ['video_transcode', 'video/webm', 'video/mp4', '.mp4'],
    ['audio_transcode', 'audio/wav', 'audio/ogg', '.ogg']
  ] as const;

  for (const [kind, sourceMime, outputMime, extension] of cases) {
    const spec = ffmpegDerivativeSpec(kind, sourceMime, '/tmp/input.safe', '/tmp/output.safe');
    assert.equal(spec.mime, outputMime);
    assert.equal(spec.extension, extension);
    assert.equal(spec.args.at(-1), '/tmp/output.safe');
    assert.ok(spec.args.includes('/tmp/input.safe'));
    assert.doesNotMatch(spec.args.join(' '), /filename|;|\$\(|`/);
  }
  assert.throws(
    () => ffmpegDerivativeSpec('video_transcode', 'image/png', '/tmp/in', '/tmp/out'),
    /source MIME is not supported/
  );
});

test('local FFmpeg provider invokes an executable without a shell and removes temporary bytes', async () => {
  let captured: {
    executable: string;
    args: string[];
    options: { shell: false; timeoutMs: number; maxStderrBytes: number };
  } | null = null;
  let inputPath = '';
  let outputPath = '';
  const provider = createLocalFfmpegDerivativeProvider({
    executable: '/opt/ffmpeg/bin/ffmpeg',
    runner: async (executable, args, options) => {
      captured = { executable, args, options };
      inputPath = args[args.indexOf('-i') + 1] || '';
      outputPath = args.at(-1) || '';
      assert.equal(existsSync(inputPath), true);
      writeFileSync(outputPath, Buffer.from('derived-image'));
    }
  });

  const result = await provider.derive({
    tenant_id: 'tenant-derivative',
    secure_file_id: 'secure-file-derivative',
    derivative_kind: 'image_thumbnail',
    source_mime: 'image/png',
    content: Buffer.from('source-image')
  });

  assert.deepEqual(result, {
    content: Buffer.from('derived-image'),
    mime: 'image/jpeg',
    extension: '.jpg',
    metadata: { engine: 'ffmpeg' }
  });
  assert.equal(captured?.executable, '/opt/ffmpeg/bin/ffmpeg');
  assert.equal(captured?.options.shell, false);
  assert.equal(existsSync(inputPath), false);
  assert.equal(existsSync(outputPath), false);
});

test('local FFmpeg provider bounds errors and never returns process diagnostics', async () => {
  const provider = createLocalFfmpegDerivativeProvider({
    runner: async () => { throw new Error('secret path and command diagnostics'); }
  });
  await assert.rejects(
    () => provider.derive({
      tenant_id: 'tenant-derivative', secure_file_id: 'secure-file-derivative',
      derivative_kind: 'audio_transcode', source_mime: 'audio/wav',
      content: Buffer.from('source-audio')
    }),
    (error: unknown) => error instanceof FileDerivativeProviderError &&
      error.code === 'derivative_process_failed' && error.retryable === true &&
      !error.message.includes('secret path')
  );
});

test('HTTP derivative provider sends bounded multipart and normalizes binary output', async () => {
  let body: FormData | null = null;
  const provider = createHttpFileDerivativeProvider({
    mode: 'self_hosted',
    baseUrl: 'http://media.internal',
    token: 'private-media-token',
    fetch: async (_url, init) => {
      body = init?.body as FormData;
      return new Response(Buffer.from('derived-video'), {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'x-request-id': 'provider/request 1',
          'content-length': '13'
        }
      });
    }
  });
  const result = await provider.derive({
    tenant_id: 'tenant-derivative', secure_file_id: 'secure-file-derivative',
    derivative_kind: 'video_transcode', source_mime: 'video/webm',
    content: Buffer.from('source-video')
  });

  assert.equal(body?.get('derivative_kind'), 'video_transcode');
  assert.equal((body?.get('file') as Blob).size, 12);
  assert.deepEqual(result, {
    content: Buffer.from('derived-video'),
    mime: 'video/mp4',
    extension: '.mp4',
    provider_request_id: 'provider_request_1',
    metadata: { engine: 'http-media' }
  });
  assert.doesNotMatch(JSON.stringify(result), /private-media-token/i);
});

test('HTTP derivative provider classifies retryable and oversized responses', async () => {
  const unavailable = createHttpFileDerivativeProvider({
    mode: 'third_party', baseUrl: 'https://media.example.test',
    fetch: async () => new Response('unavailable', { status: 503 })
  });
  await assert.rejects(
    () => unavailable.derive({
      tenant_id: 'tenant-derivative', secure_file_id: 'secure-file-derivative',
      derivative_kind: 'image_thumbnail', source_mime: 'image/png',
      content: Buffer.from('source-image')
    }),
    (error: unknown) => error instanceof FileDerivativeProviderError &&
      error.code === 'derivative_http_503' && error.retryable === true
  );

  const oversized = createHttpFileDerivativeProvider({
    mode: 'third_party', baseUrl: 'https://media.example.test', maxOutputBytes: 4,
    fetch: async () => new Response(Buffer.from('too-large'), {
      status: 200, headers: { 'content-type': 'image/jpeg' }
    })
  });
  await assert.rejects(
    () => oversized.derive({
      tenant_id: 'tenant-derivative', secure_file_id: 'secure-file-derivative',
      derivative_kind: 'image_thumbnail', source_mime: 'image/png',
      content: Buffer.from('source-image')
    }),
    (error: unknown) => error instanceof FileDerivativeProviderError &&
      error.code === 'derivative_output_too_large' && error.retryable === false
  );
});
