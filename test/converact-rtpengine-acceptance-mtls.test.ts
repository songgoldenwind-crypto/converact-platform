import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadRtpengineAcceptanceCliConfig
} from '../scripts/converact-rtpengine-acceptance-cli.js';

test('RTPengine server acceptance uses a private-CA mTLS client', async () => {
  const certificates = testCertificates();
  const server = createServer({
    key: certificates.serverKey,
    cert: certificates.serverCert,
    ca: certificates.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const env = acceptanceEnv(
      `https://127.0.0.1:${port}`,
      certificates.identityFile,
      certificates.caFile
    );
    const config = loadRtpengineAcceptanceCliConfig(env);
    const response = await config.media_control_fetch(
      `https://127.0.0.1:${port}/health`,
      { signal: AbortSignal.timeout(2_000) }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(certificates.directory, { recursive: true, force: true });
  }
});

test('RTPengine HTTPS acceptance requires complete bounded TLS files', () => {
  const certificates = testCertificates();
  try {
    assert.throws(
      () => loadRtpengineAcceptanceCliConfig({
        ...acceptanceEnv(
          'https://127.0.0.1:3211',
          certificates.identityFile,
          certificates.caFile
        ),
        CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_TLS_CA_FILE: ''
      }),
      /TLS fields must be configured together/
    );

    if (process.platform !== 'win32') {
      chmodSync(certificates.identityFile, 0o444);
      assert.throws(
        () => loadRtpengineAcceptanceCliConfig(acceptanceEnv(
          'https://127.0.0.1:3211',
          certificates.identityFile,
          certificates.caFile
        )),
        /permissions are too broad/
      );
    }
  } finally {
    rmSync(certificates.directory, { recursive: true, force: true });
  }
});

function acceptanceEnv(
  endpoint: string,
  identityFile: string,
  caFile: string
): Record<string, string> {
  return {
    CONVERACT_FABRIC_MEDIA_CONTROL_ENDPOINT: endpoint,
    CONVERACT_FABRIC_MEDIA_CONTROL_TOKEN: 'goal3-media-control-token-123456789',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_TLS_IDENTITY_FILE: identityFile,
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_TLS_CA_FILE: caFile,
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_TLS_SERVERNAME: '127.0.0.1',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_BIND_ADDRESS: '127.0.0.1',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_SOURCE_COMMIT: 'a'.repeat(40),
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_CONFIG_HASH: `sha256:${'c'.repeat(64)}`,
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_RUNTIME_MODE: 'userspace',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_OUTPUT: '/evidence/goal3.json',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_SOURCE_DIR: '/work',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_DOCKER_BINARY: '/usr/bin/docker',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_CONTAINER_PREFIX: 'converact-goal3-test-',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_MEDIA_CONTROL_CONTAINER:
      'converact-goal3-test-media-control',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_ADMISSION_CONTAINER:
      'converact-goal3-test-admission',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_RTPENGINE_CONTAINER:
      'converact-goal3-test-rtpengine',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_NG_HOST: '127.0.0.1',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_NG_PORT: '22222',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MIN: '36000',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MAX: '36100',
    CONVERACT_FABRIC_RTPENGINE_ACCEPTANCE_MAX_ACTIVE_CALLS: '2'
  };
}

function testCertificates(): {
  directory: string;
  ca: Buffer;
  serverKey: Buffer;
  serverCert: Buffer;
  identityFile: string;
  caFile: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'converact-rtpengine-mtls-'));
  const run = (...arguments_: string[]) => {
    execFileSync('openssl', arguments_, {
      cwd: directory,
      stdio: 'ignore'
    });
  };
  run(
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1',
    '-subj', '/CN=converact-rtpengine-test-ca'
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
    '-subj', '/CN=converact-rtpengine-acceptance',
    '-addext', 'extendedKeyUsage=clientAuth'
  );
  run(
    'x509', '-req', '-in', 'client.csr',
    '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'client.crt', '-days', '1', '-copy_extensions', 'copy'
  );
  const identityFile = join(directory, 'client-identity.pem');
  const caFile = join(directory, 'ca.crt');
  writeFileSync(identityFile, Buffer.concat([
    readFileSync(join(directory, 'client.crt')),
    readFileSync(join(directory, 'client.key'))
  ]), { mode: 0o400 });
  chmodSync(identityFile, 0o400);
  return {
    directory,
    ca: readFileSync(caFile),
    serverKey: readFileSync(join(directory, 'server.key')),
    serverCert: readFileSync(join(directory, 'server.crt')),
    identityFile,
    caFile
  };
}
