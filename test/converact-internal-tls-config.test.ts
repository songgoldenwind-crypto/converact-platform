import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadConveractFabricInternalTlsConfig
} from '../src/agent-runtime/converact/internal-tls.js';

test('Converact Fabric internal TLS configuration is optional but all-or-none', () => {
  assert.equal(loadConveractFabricInternalTlsConfig({}), null);
  assert.throws(
    () => loadConveractFabricInternalTlsConfig({
      CONVERACT_FABRIC_INTERNAL_TLS_PORT: '3443'
    }),
    /configured together/
  );
});

test('Converact Fabric internal TLS configuration reads bounded certificate files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-tls-config-'));
  const key = join(directory, 'server.key');
  const cert = join(directory, 'server.crt');
  const ca = join(directory, 'client-ca.crt');
  writeFileSync(key, 'key');
  chmodSync(key, 0o440);
  writeFileSync(cert, 'cert');
  writeFileSync(ca, 'ca');

  try {
    const config = loadConveractFabricInternalTlsConfig({
      CONVERACT_FABRIC_INTERNAL_TLS_PORT: '3443',
      CONVERACT_FABRIC_INTERNAL_TLS_KEY_FILE: key,
      CONVERACT_FABRIC_INTERNAL_TLS_CERT_FILE: cert,
      CONVERACT_FABRIC_INTERNAL_TLS_CLIENT_CA_FILE: ca
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
  'Converact Fabric internal TLS rejects a world-readable server key',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'converact-tls-config-mode-'));
    const key = join(directory, 'server.key');
    const cert = join(directory, 'server.crt');
    const ca = join(directory, 'client-ca.crt');
    writeFileSync(key, 'key');
    writeFileSync(cert, 'cert');
    writeFileSync(ca, 'ca');

    try {
      chmodSync(key, 0o444);
      assert.throws(
        () => loadConveractFabricInternalTlsConfig({
          CONVERACT_FABRIC_INTERNAL_TLS_PORT: '3443',
          CONVERACT_FABRIC_INTERNAL_TLS_KEY_FILE: key,
          CONVERACT_FABRIC_INTERNAL_TLS_CERT_FILE: cert,
          CONVERACT_FABRIC_INTERNAL_TLS_CLIENT_CA_FILE: ca
        }),
        /permissions/
      );
      chmodSync(key, 0o440);
      assert.doesNotThrow(() => loadConveractFabricInternalTlsConfig({
        CONVERACT_FABRIC_INTERNAL_TLS_PORT: '3443',
        CONVERACT_FABRIC_INTERNAL_TLS_KEY_FILE: key,
        CONVERACT_FABRIC_INTERNAL_TLS_CERT_FILE: cert,
        CONVERACT_FABRIC_INTERNAL_TLS_CLIENT_CA_FILE: ca
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test('Converact Fabric internal TLS rejects relative and oversized files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-tls-config-limit-'));
  const key = join(directory, 'server.key');
  const cert = join(directory, 'server.crt');
  const ca = join(directory, 'client-ca.crt');
  writeFileSync(key, Buffer.alloc(65_537, 1));
  writeFileSync(cert, 'cert');
  writeFileSync(ca, 'ca');

  try {
    assert.throws(
      () => loadConveractFabricInternalTlsConfig({
        CONVERACT_FABRIC_INTERNAL_TLS_PORT: '3443',
        CONVERACT_FABRIC_INTERNAL_TLS_KEY_FILE: 'server.key',
        CONVERACT_FABRIC_INTERNAL_TLS_CERT_FILE: cert,
        CONVERACT_FABRIC_INTERNAL_TLS_CLIENT_CA_FILE: ca
      }),
      /absolute/
    );
    assert.throws(
      () => loadConveractFabricInternalTlsConfig({
        CONVERACT_FABRIC_INTERNAL_TLS_PORT: '3443',
        CONVERACT_FABRIC_INTERNAL_TLS_KEY_FILE: key,
        CONVERACT_FABRIC_INTERNAL_TLS_CERT_FILE: cert,
        CONVERACT_FABRIC_INTERNAL_TLS_CLIENT_CA_FILE: ca
      }),
      /size/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
