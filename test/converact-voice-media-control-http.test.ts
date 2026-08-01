import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { createServer } from 'node:http';
import { request as requestHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  MediaControlAgent,
  MediaControlError,
  type MediaControlAuthorityPort
} from '../src/agent-runtime/converact/media-control/agent.js';
import {
  HttpMediaControlClient
} from '../src/agent-runtime/converact/media-control/client.js';
import {
  createMediaControlHttpServer,
  type MediaControlHttpFailure,
  type MediaControlHttpServer
} from '../src/agent-runtime/converact/media-control/http.js';
import {
  mediaControlPayloadHash,
  type MediaControlCommand
} from '../src/agent-runtime/converact/media-control/protocol.js';
import {
  InMemoryMediaTransport
} from '../src/agent-runtime/converact/media-control/simulator.js';

const TOKEN = 'media-control-test-token-0123456789';
const NOW = new Date('2026-07-25T00:00:00.000Z');
const servers: MediaControlHttpServer[] = [];

class AllowAuthority implements MediaControlAuthorityPort {
  async authorize() {
    return {
      owner_epoch: ((1n << 32n) | 1n).toString(),
      reservation_expires_at: '2026-07-25T00:01:00.000Z',
      node_lease_expires_at: '2026-07-25T00:00:30.000Z'
    };
  }
}

function command(): MediaControlCommand {
  const payload = {
    offer_sdp: 'v=0\r\n',
    media_profile_id: 'g711-relay-v1'
  };
  return {
    protocol_version: 'ivekit.media-control.v1',
    action: 'offer',
    command_id: 'http-command-1',
    tenant_id: 'http-tenant-handle-1',
    call_id: 'http-call-1',
    leg_id: 'http-leg-1',
    cell_id: 'http-cell-1',
    owner_node_id: 'http-rustpbx-1',
    owner_epoch: ((1n << 32n) | 1n).toString(),
    admission_reservation_id: 'http-reservation-1',
    media_reservation_id: 'http-reservation-1',
    command_sequence: 1,
    idempotency_key: 'http-idem-1',
    expires_at: '2026-07-25T00:01:00.000Z',
    payload,
    payload_hash: mediaControlPayloadHash(payload)
  };
}

function agent(): MediaControlAgent {
  return new MediaControlAgent({
    authority: new AllowAuthority(),
    transport: new InMemoryMediaTransport()
  });
}

async function listen(
  server: MediaControlHttpServer,
  protocol: 'http' | 'https' = 'http'
): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `${protocol}://127.0.0.1:${address.port}/`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

describe('Converact Fabric media control HTTP boundary', () => {
  it('requires mTLS configuration in production on server and client', () => {
    assert.throws(
      () => createMediaControlHttpServer({
        agent: agent(),
        service_token: TOKEN,
        production: true
      }),
      /production mTLS is required/
    );
    assert.throws(
      () => new HttpMediaControlClient({
        endpoint: 'http://127.0.0.1:8099',
        service_token: TOKEN,
        production: true
      }),
      /production mTLS is required/
    );
  });

  it('completes a real mutual-TLS handshake and rejects clients without a certificate', async () => {
    const certificates = testCertificates();
    try {
      const endpoint = await listen(createMediaControlHttpServer({
        agent: agent(),
        service_token: TOKEN,
        production: true,
        tls: {
          key: certificates.serverKey,
          cert: certificates.serverCert,
          ca: certificates.ca
        },
        now: () => NOW
      }), 'https');
      const client = new HttpMediaControlClient({
        endpoint,
        service_token: TOKEN,
        production: true,
        tls: {
          key: certificates.clientKey,
          cert: certificates.clientCert,
          ca: certificates.ca
        }
      });

      assert.equal(
        (await client.execute(command())).result_class,
        'committed'
      );
      await assert.rejects(httpsWithoutClientCertificate(
        endpoint,
        certificates.ca
      ));
    } finally {
      rmSync(certificates.directory, { recursive: true, force: true });
    }
  });

  it('executes, replays, reads sessions, and exposes authenticated metrics', async () => {
    const server = createMediaControlHttpServer({
      agent: agent(),
      service_token: TOKEN,
      now: () => NOW
    });
    const endpoint = await listen(server);
    const client = new HttpMediaControlClient({
      endpoint,
      service_token: TOKEN
    });

    const first = await client.execute(command());
    const replay = await client.execute(command());
    const session = await client.session('http-reservation-1');
    const metrics = await fetch(new URL('/metrics', endpoint), {
      headers: { authorization: `Bearer ${TOKEN}` }
    });

    assert.equal(first.result_class, 'committed');
    assert.equal(replay.result_class, 'replayed');
    assert.deepEqual(replay.session, first.session);
    assert.equal(session.state, 'prepared');
    assert.equal(metrics.status, 200);
    assert.match(
      await metrics.text(),
      /ivekit_media_control_commands_total\{action="offer",result="replayed"\} 1/
    );
  });

  it('protects every non-health endpoint with the service token', async () => {
    const endpoint = await listen(createMediaControlHttpServer({
      agent: agent(),
      service_token: TOKEN,
      now: () => NOW
    }));

    assert.equal((await fetch(new URL('/livez', endpoint))).status, 200);
    assert.equal((await fetch(new URL('/readyz', endpoint))).status, 200);
    assert.equal((await fetch(new URL('/metrics', endpoint))).status, 401);
    assert.equal((await fetch(new URL('/v1/sessions/x', endpoint))).status, 401);
  });

  it('rejects invalid content types, JSON, and oversized bodies', async () => {
    const endpoint = await listen(createMediaControlHttpServer({
      agent: agent(),
      service_token: TOKEN,
      max_body_bytes: 1_024,
      now: () => NOW
    }));
    const headers = { authorization: `Bearer ${TOKEN}` };

    const contentType = await fetch(new URL('/v1/commands', endpoint), {
      method: 'POST',
      headers,
      body: '{}'
    });
    const invalidJson = await fetch(new URL('/v1/commands', endpoint), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{'
    });
    const oversized = await fetch(new URL('/v1/commands', endpoint), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(2_000) })
    });

    assert.equal(contentType.status, 415);
    assert.equal(invalidJson.status, 400);
    assert.equal(oversized.status, 413);
  });

  it('reports a normalized HTTP rejection without changing its response', async () => {
    const failures: MediaControlHttpFailure[] = [];
    const endpoint = await listen(createMediaControlHttpServer({
      agent: agent(),
      service_token: TOKEN,
      now: () => NOW,
      error_observer: (failure) => failures.push(failure)
    }));

    const response = await fetch(new URL('/v1/commands', endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      },
      body: '{}'
    });
    const body = await response.json() as {
      error: { code: string; retryable: boolean };
    };

    assert.equal(response.status, 400);
    assert.deepEqual(failures, [{
      method: 'POST',
      path: '/v1/commands',
      error_code: body.error.code,
      status: 400,
      retryable: body.error.retryable
    }]);
  });

  it('returns unknown when a mutating request times out', async () => {
    const hanging = createServer(() => {});
    const endpoint = await listen(hanging);
    const client = new HttpMediaControlClient({
      endpoint,
      service_token: TOKEN,
      timeout_ms: 50
    });

    const result = await client.execute(command());

    assert.deepEqual(result, {
      protocol_version: 'ivekit.media-control.v1',
      result_class: 'unknown',
      command_id: 'http-command-1',
      error_code: 'media_control_timeout',
      retryable: true
    });
  });

  it('uses an absolute deadline even when a server drips response bytes', async () => {
    const dripping = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => response.write('{'), 20);
      response.on('close', () => clearInterval(timer));
    });
    const endpoint = await listen(dripping);
    const client = new HttpMediaControlClient({
      endpoint,
      service_token: TOKEN,
      timeout_ms: 50
    });

    const result = await client.execute(command());

    assert.equal(result.result_class, 'unknown');
    assert.equal(
      result.result_class === 'unknown' && result.error_code,
      'media_control_timeout'
    );
  });

  it('classifies malformed success and server errors as unknown outcomes', async () => {
    for (const response of [
      {
        status: 200,
        body: {
          data: {
            protocol_version: 'ivekit.media-control.v1',
            result_class: 'committed',
            command_id: 'http-command-1'
          }
        }
      },
      {
        status: 500,
        body: {
          error: {
            code: 'internal_error',
            retryable: true
          }
        }
      }
    ]) {
      const server = createServer((_request, output) => {
        output.writeHead(response.status, {
          'content-type': 'application/json'
        });
        output.end(JSON.stringify(response.body));
      });
      const endpoint = await listen(server);
      const client = new HttpMediaControlClient({
        endpoint,
        service_token: TOKEN
      });

      const result = await client.execute(command());

      assert.equal(result.result_class, 'unknown');
      assert.equal(result.command_id, 'http-command-1');
    }
  });

  it('preserves deterministic server errors as typed failures', async () => {
    const endpoint = await listen(createMediaControlHttpServer({
      agent: agent(),
      service_token: TOKEN,
      now: () => NOW
    }));
    const client = new HttpMediaControlClient({
      endpoint,
      service_token: TOKEN
    });

    await assert.rejects(
      client.session('missing'),
      (error: unknown) =>
        error instanceof MediaControlError &&
        error.code === 'media_session_not_found' &&
        error.status === 404
    );
  });
});

function testCertificates(): {
  directory: string;
  ca: Buffer;
  serverKey: Buffer;
  serverCert: Buffer;
  clientKey: Buffer;
  clientCert: Buffer;
} {
  const directory = mkdtempSync(join(tmpdir(), 'converact-media-mtls-'));
  const run = (...arguments_: string[]) => {
    execFileSync('openssl', arguments_, {
      cwd: directory,
      stdio: 'ignore'
    });
  };
  run(
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1',
    '-subj', '/CN=converact-test-ca'
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
    '-subj', '/CN=converact-test-client',
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

function httpsWithoutClientCertificate(
  endpoint: string,
  ca: Buffer
): Promise<void> {
  const target = new URL('/livez', endpoint);
  return new Promise((resolve, reject) => {
    const request = requestHttps({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      ca,
      rejectUnauthorized: true
    }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
    request.end();
  });
}
