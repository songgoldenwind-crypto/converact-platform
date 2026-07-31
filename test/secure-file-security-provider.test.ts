import assert from 'node:assert/strict';
import test from 'node:test';

import { detectSecureFileMime } from '../src/agent-runtime/collaboration/secure-file-mime.js';
import {
  ControlledFileThreatScanner,
  FileThreatScannerError,
  createClamdFileThreatScanner,
  createHttpFileThreatScanner,
  encodeClamdInstream
} from '../src/agent-runtime/collaboration/file-threat-scanner.js';
import {
  configuredFileThreatScanner,
  secureFileScanWorkerConfig
} from '../src/agent-runtime/collaboration/secure-file-scan-worker.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

test('magic-byte MIME detector recognizes required media and document formats', async () => {
  const fixtures: Array<{ name: string; content: Buffer; mime: string }> = [
    { name: 'png', content: hex('89504e470d0a1a0a0000000d49484452'), mime: 'image/png' },
    { name: 'jpeg', content: hex('ffd8ffe000104a4649460001010000010001'), mime: 'image/jpeg' },
    { name: 'pdf', content: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF'), mime: 'application/pdf' },
    { name: 'zip', content: zipFixture(), mime: 'application/zip' },
    { name: 'mp4', content: hex('000000186674797069736f6d0000020069736f6d69736f32'), mime: 'video/mp4' },
    { name: 'webm', content: hex('1a45dfa39f4286810142f7810142f2810442f381084282847765626d'), mime: 'video/webm' },
    { name: 'mp3', content: hex('49443304000000000000fffb9064'), mime: 'audio/mpeg' },
    { name: 'wav', content: wavFixture(), mime: 'audio/wav' }
  ];

  for (const fixture of fixtures) {
    const detected = await detectSecureFileMime(fixture.content);
    assert.equal(detected.mime, fixture.mime, fixture.name);
    assert.equal(detected.detected, true, fixture.name);
  }
});

test('unknown content becomes application/octet-stream and never falls back to declared MIME', async () => {
  const detected = await detectSecureFileMime(
    Buffer.from('plain text pretending to be an image'),
    { declaredMime: 'image/png' }
  );
  assert.deepEqual(detected, {
    mime: 'application/octet-stream',
    extension: '',
    detected: false,
    mime_conflict: true
  });
});

test('MIME detector reads only a bounded probe', async () => {
  const content = Buffer.concat([
    hex('89504e470d0a1a0a0000000d49484452'),
    Buffer.alloc(2 * 1024 * 1024, 0x61)
  ]);
  const detected = await detectSecureFileMime(content, { maxProbeBytes: 4_100 });
  assert.equal(detected.mime, 'image/png');
  assert.equal(detected.probe_bytes, 4_100);
});

test('controlled threat scanner detects EICAR without returning file content', async () => {
  const scanner = new ControlledFileThreatScanner();
  const clean = await scanner.scan(scanInput(Buffer.from('safe content')));
  const infected = await scanner.scan(scanInput(Buffer.from(EICAR)));

  assert.equal(clean.status, 'clean');
  assert.equal(infected.status, 'infected');
  assert.equal(infected.threat_code, 'eicar_test_signature');
  assert.doesNotMatch(JSON.stringify(infected), /STANDARD-ANTIVIRUS|X5O!/i);
});

test('ClamAV INSTREAM encoder emits bounded network-order chunks', () => {
  const encoded = encodeClamdInstream(Buffer.from('abcdef'), 4);
  const command = Buffer.from('zINSTREAM\0');
  assert.deepEqual(encoded.subarray(0, command.length), command);
  let offset = command.length;
  assert.equal(encoded.readUInt32BE(offset), 4);
  offset += 4;
  assert.equal(encoded.subarray(offset, offset + 4).toString(), 'abcd');
  offset += 4;
  assert.equal(encoded.readUInt32BE(offset), 2);
  offset += 4;
  assert.equal(encoded.subarray(offset, offset + 2).toString(), 'ef');
  offset += 2;
  assert.equal(encoded.readUInt32BE(offset), 0);
});

test('ClamAV scanner normalizes clean, infected, timeout, and size-limit outcomes', async () => {
  const responses = ['stream: OK\0', 'stream: Win.Test.EICAR_HDB-1 FOUND\0'];
  const scanner = createClamdFileThreatScanner({
    transport: async () => responses.shift() || 'stream: OK\0'
  });
  assert.equal((await scanner.scan(scanInput(Buffer.from('safe')))).status, 'clean');
  const infected = await scanner.scan(scanInput(Buffer.from(EICAR)));
  assert.deepEqual(infected, {
    status: 'infected',
    engine: 'clamav',
    threat_code: 'win.test.eicar_hdb-1',
    metadata: {}
  });

  const timeout = createClamdFileThreatScanner({
    transport: async () => { throw Object.assign(new Error('secret socket details'), { code: 'ETIMEDOUT' }); }
  });
  await assert.rejects(
    () => timeout.scan(scanInput(Buffer.from('safe'))),
    (error: unknown) => error instanceof FileThreatScannerError &&
      error.code === 'scanner_timeout' && error.retryable === true &&
      !error.message.includes('secret socket details')
  );

  const limited = createClamdFileThreatScanner({
    transport: async () => 'INSTREAM size limit exceeded. ERROR\0'
  });
  await assert.rejects(
    () => limited.scan(scanInput(Buffer.from('safe'))),
    (error: unknown) => error instanceof FileThreatScannerError &&
      error.code === 'scanner_size_limit' && error.retryable === false
  );
});

test('HTTP threat scanner sends multipart and sanitizes secrets from provider output', async () => {
  const token = 'scanner-private-token';
  let sentBody: FormData | null = null;
  let sentAuthorization = '';
  const scanner = createHttpFileThreatScanner({
    mode: 'self_hosted',
    baseUrl: 'http://scanner.internal',
    token,
    fetch: async (_url, init) => {
      sentBody = init?.body as FormData;
      sentAuthorization = new Headers(init?.headers).get('authorization') || '';
      return new Response(JSON.stringify({
        status: 'clean',
        engine: 'clamav-http',
        request_id: 'scanner/request 1',
        metadata: {
          model: 'controlled-v1',
          authorization: `Bearer ${token}`,
          nested: { api_key: token, region: 'local' },
          echoed: `prefix-${token}-suffix`
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await scanner.scan(scanInput(Buffer.from('safe')));

  assert.equal(sentAuthorization, `Bearer ${token}`);
  assert.equal((sentBody?.get('file') as Blob).size, 4);
  assert.equal(sentBody?.get('secure_file_id'), 'sfile-provider-test');
  assert.deepEqual(result, {
    status: 'clean',
    engine: 'clamav-http',
    provider_request_id: 'scanner_request_1',
    metadata: { model: 'controlled-v1', nested: { region: 'local' } }
  });
  assert.doesNotMatch(JSON.stringify(result), /scanner-private-token|authorization|api_key/i);
});

test('HTTP threat scanner classifies retryable status and bounded invalid responses', async () => {
  const unavailable = createHttpFileThreatScanner({
    mode: 'third_party', baseUrl: 'https://scanner.example.test',
    fetch: async () => new Response('unavailable', { status: 503 })
  });
  await assert.rejects(
    () => unavailable.scan(scanInput(Buffer.from('safe'))),
    (error: unknown) => error instanceof FileThreatScannerError &&
      error.code === 'scanner_http_503' && error.retryable === true
  );

  const oversized = createHttpFileThreatScanner({
    mode: 'third_party', baseUrl: 'https://scanner.example.test',
    fetch: async () => new Response(JSON.stringify({ status: 'clean', padding: 'x'.repeat(70_000) }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(
    () => oversized.scan(scanInput(Buffer.from('safe'))),
    (error: unknown) => error instanceof FileThreatScannerError &&
      error.code === 'scanner_response_too_large' && error.retryable === false
  );
});

test('file security worker configuration is disabled by default and bounded when enabled', () => {
  const disabled = secureFileScanWorkerConfig({});
  assert.equal(disabled.enabled, false);

  const configured = secureFileScanWorkerConfig({
    NODE_ENV: 'test',
    OPC_FILE_SECURITY_SCANNER_MODE: 'controlled',
    OPC_FILE_SECURITY_SCAN_INTERVAL_MS: '2500',
    OPC_FILE_SECURITY_SCAN_BATCH_SIZE: '40',
    OPC_FILE_SECURITY_SCAN_RETRY_DELAYS_MS: '0,3000',
    OPC_FILE_SECURITY_MIME_CONFLICT_ACTION: 'reject',
    OPC_FILE_SECURITY_SCAN_WORKER_ID: 'scan worker / one'
  });
  assert.deepEqual({
    enabled: configured.enabled,
    intervalMs: configured.intervalMs,
    batchSize: configured.batchSize,
    retryDelaysMs: configured.retryDelaysMs,
    mimeConflictAction: configured.mimeConflictAction,
    workerId: configured.workerId
  }, {
    enabled: true,
    intervalMs: 2500,
    batchSize: 40,
    retryDelaysMs: [0, 3000],
    mimeConflictAction: 'reject',
    workerId: 'scan_worker_one'
  });
});

test('file security scanner mode enforces production and provider configuration', () => {
  assert.throws(
    () => secureFileScanWorkerConfig({
      NODE_ENV: 'production',
      OPC_FILE_SECURITY_SCANNER_MODE: 'controlled'
    }),
    /controlled file scanner is forbidden in production/
  );
  assert.throws(
    () => configuredFileThreatScanner({ OPC_FILE_SECURITY_SCANNER_MODE: 'http_self_hosted' }),
    /OPC_FILE_SECURITY_SCANNER_URL is required/
  );
  assert.throws(
    () => configuredFileThreatScanner({
      OPC_FILE_SECURITY_SCANNER_MODE: 'clamd',
      OPC_FILE_SECURITY_CLAMD_PORT: 'not-a-port'
    }),
    /clamd port/
  );

  const controlled = configuredFileThreatScanner({
    OPC_FILE_SECURITY_SCANNER_MODE: 'controlled'
  });
  const clamd = configuredFileThreatScanner({ OPC_FILE_SECURITY_SCANNER_MODE: 'clamd' });
  const http = configuredFileThreatScanner({
    OPC_FILE_SECURITY_SCANNER_MODE: 'http_third_party',
    OPC_FILE_SECURITY_SCANNER_URL: 'https://scanner.example.test'
  });
  assert.deepEqual(
    [controlled?.mode, clamd?.mode, http?.mode],
    ['controlled', 'self_hosted', 'third_party']
  );
});

function scanInput(content: Buffer) {
  return {
    tenant_id: 'tenant-provider-test',
    secure_file_id: 'sfile-provider-test',
    filename: 'sample.bin',
    detected_mime: 'application/octet-stream',
    content
  };
}

function hex(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'hex'), Buffer.alloc(256)]);
}

function zipFixture(): Buffer {
  return Buffer.from([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ]);
}

function wavFixture(): Buffer {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(0, 40);
  return buffer;
}
