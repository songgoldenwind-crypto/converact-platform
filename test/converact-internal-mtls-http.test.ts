import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConveractFabricHttpServer } from '../src/agent-runtime/converact/http-server.js';

test('Converact Fabric internal listener requires a trusted mTLS client', async () => {
  const certificates = testCertificates();
  const server = createConveractFabricHttpServer({
    db: {},
    pg: null,
    tls: {
      key: certificates.serverKey,
      cert: certificates.serverCert,
      ca: certificates.ca,
      requestCert: true,
      rejectUnauthorized: true
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;

    await assert.rejects(
      httpsStatus(port, certificates.ca),
      /certificate|alert|socket|reset/i
    );
    assert.equal(
      await httpsStatus(
        port,
        certificates.ca,
        certificates.clientCert,
        certificates.clientKey
      ),
      200
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(certificates.directory, { recursive: true, force: true });
  }
});

function httpsStatus(
  port: number,
  ca: Buffer,
  cert?: Buffer,
  key?: Buffer
): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = request({
      host: '127.0.0.1',
      port,
      path: '/livez',
      method: 'GET',
      ca,
      cert,
      key,
      rejectUnauthorized: true
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode || 0));
    });
    call.once('error', reject);
    call.end();
  });
}

function testCertificates(): {
  directory: string;
  ca: Buffer;
  serverKey: Buffer;
  serverCert: Buffer;
  clientKey: Buffer;
  clientCert: Buffer;
} {
  const directory = mkdtempSync(join(tmpdir(), 'converact-internal-mtls-'));
  const run = (...arguments_: string[]) => {
    execFileSync('openssl', arguments_, {
      cwd: directory,
      stdio: 'ignore'
    });
  };
  run(
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1',
    '-subj', '/CN=converact-internal-test-ca'
  );
  run(
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'server.key', '-out', 'server.csr',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
    '-addext', 'extendedKeyUsage=serverAuth'
  );
  run(
    'x509', '-req', '-in', 'server.csr',
    '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.crt', '-days', '1', '-copy_extensions', 'copy'
  );
  run(
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'client.key', '-out', 'client.csr',
    '-subj', '/CN=rustpbx-cdr-client',
    '-addext', 'extendedKeyUsage=clientAuth'
  );
  run(
    'x509', '-req', '-in', 'client.csr',
    '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'client.crt', '-days', '1', '-copy_extensions', 'copy'
  );
  return {
    directory,
    ca: readFileSync(join(directory, 'ca.crt')),
    serverKey: readFileSync(join(directory, 'server.key')),
    serverCert: readFileSync(join(directory, 'server.crt')),
    clientKey: readFileSync(join(directory, 'client.key')),
    clientCert: readFileSync(join(directory, 'client.crt'))
  };
}
