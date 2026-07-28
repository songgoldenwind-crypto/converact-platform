import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadIveKitInternalTlsConfig
} from '../src/agent-runtime/ivekit/internal-tls.js';

test('iveKit internal TLS configuration is optional but all-or-none', () => {
  assert.equal(loadIveKitInternalTlsConfig({}), null);
  assert.throws(
    () => loadIveKitInternalTlsConfig({
      OPC_IVEKIT_INTERNAL_TLS_PORT: '3443'
    }),
    /configured together/
  );
});

test('iveKit internal TLS configuration reads bounded certificate files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-tls-config-'));
  const key = join(directory, 'server.key');
  const cert = join(directory, 'server.crt');
  const ca = join(directory, 'client-ca.crt');
  writeFileSync(key, 'key');
  chmodSync(key, 0o440);
  writeFileSync(cert, 'cert');
  writeFileSync(ca, 'ca');

  try {
    const config = loadIveKitInternalTlsConfig({
      OPC_IVEKIT_INTERNAL_TLS_PORT: '3443',
      OPC_IVEKIT_INTERNAL_TLS_KEY_FILE: key,
      OPC_IVEKIT_INTERNAL_TLS_CERT_FILE: cert,
      OPC_IVEKIT_INTERNAL_TLS_CLIENT_CA_FILE: ca
    });

    assert.equal(config?.port, 3443);
    assert.equal(config?.tls.requestCert, true);
    assert.equal(config?.tls.rejectUnauthorized, true);
    assert.equal(config?.tls.minVersion, 'TLSv1.2');
    assert.equal(config?.tls.key?.toString(), 'key');
    assert.equal(config?.tls.cert?.toString(), 'cert');
    assert.equal(config?.tls.ca?.toString(), 'ca');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'iveKit internal TLS rejects a world-readable server key',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'ivekit-tls-config-mode-'));
    const key = join(directory, 'server.key');
    const cert = join(directory, 'server.crt');
    const ca = join(directory, 'client-ca.crt');
    writeFileSync(key, 'key');
    writeFileSync(cert, 'cert');
    writeFileSync(ca, 'ca');

    try {
      chmodSync(key, 0o444);
      assert.throws(
        () => loadIveKitInternalTlsConfig({
          OPC_IVEKIT_INTERNAL_TLS_PORT: '3443',
          OPC_IVEKIT_INTERNAL_TLS_KEY_FILE: key,
          OPC_IVEKIT_INTERNAL_TLS_CERT_FILE: cert,
          OPC_IVEKIT_INTERNAL_TLS_CLIENT_CA_FILE: ca
        }),
        /permissions/
      );
      chmodSync(key, 0o440);
      assert.doesNotThrow(() => loadIveKitInternalTlsConfig({
        OPC_IVEKIT_INTERNAL_TLS_PORT: '3443',
        OPC_IVEKIT_INTERNAL_TLS_KEY_FILE: key,
        OPC_IVEKIT_INTERNAL_TLS_CERT_FILE: cert,
        OPC_IVEKIT_INTERNAL_TLS_CLIENT_CA_FILE: ca
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test('iveKit internal TLS rejects relative and oversized files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-tls-config-limit-'));
  const key = join(directory, 'server.key');
  const cert = join(directory, 'server.crt');
  const ca = join(directory, 'client-ca.crt');
  writeFileSync(key, Buffer.alloc(65_537, 1));
  writeFileSync(cert, 'cert');
  writeFileSync(ca, 'ca');

  try {
    assert.throws(
      () => loadIveKitInternalTlsConfig({
        OPC_IVEKIT_INTERNAL_TLS_PORT: '3443',
        OPC_IVEKIT_INTERNAL_TLS_KEY_FILE: 'server.key',
        OPC_IVEKIT_INTERNAL_TLS_CERT_FILE: cert,
        OPC_IVEKIT_INTERNAL_TLS_CLIENT_CA_FILE: ca
      }),
      /absolute/
    );
    assert.throws(
      () => loadIveKitInternalTlsConfig({
        OPC_IVEKIT_INTERNAL_TLS_PORT: '3443',
        OPC_IVEKIT_INTERNAL_TLS_KEY_FILE: key,
        OPC_IVEKIT_INTERNAL_TLS_CERT_FILE: cert,
        OPC_IVEKIT_INTERNAL_TLS_CLIENT_CA_FILE: ca
      }),
      /size/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
