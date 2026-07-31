import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectLiveKitServerEvidence,
  createLiveKitServerEvidenceConfigFromEnv,
  writeLiveKitServerEvidence,
  type LiveKitServerEvidenceConfig,
  type LiveKitServerEvidenceProbes
} from '../scripts/livekit-server-evidence.js';

function config(outputFile?: string): LiveKitServerEvidenceConfig {
  return {
    ...(outputFile ? { outputFile } : {}),
    acceptance: {
      run_id: 'lk-run-20260711-001',
      environment_id: 'led-staging-sfo2',
      deployed_commit: 'a'.repeat(40),
      deployment_fingerprint: 'b'.repeat(64),
      started_at: new Date(Date.now() - 60_000).toISOString(),
      deployment_mode: 'standalone-vm'
    },
    signalDomain: 'livekit.example.com',
    turnDomain: 'turn.example.com',
    internalUrl: 'ws://10.0.0.8:7880',
    signalTlsPort: 443,
    turnTlsPort: 443,
    rtcTcpPort: 7881,
    turnUdpPort: 3478,
    rtcUdpPorts: [50000, 55000, 60000],
    timeoutMs: 1500,
    minCertificateValidityDays: 7
  };
}

function passingProbes(): LiveKitServerEvidenceProbes {
  return {
    lookup: async (host) => host.startsWith('livekit') ? ['203.0.113.10'] : ['203.0.113.11'],
    tcp: async () => true,
    udp: async () => true,
    tls: async (host) => ({
      ok: true,
      authorized: true,
      valid_to: '2030-01-01T00:00:00.000Z',
      subject: host,
      issuer: 'Test CA',
      fingerprint256: 'AA:BB'
    }),
    health: async (url) => ({ ok: true, status: url.startsWith('https://') ? 200 : 204 })
  };
}

test('LiveKit server evidence collects named DNS TLS health TCP and UDP-send checks', async () => {
  const result = await collectLiveKitServerEvidence(
    config(),
    passingProbes(),
    new Date('2026-07-11T00:00:00.000Z')
  );

  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 1);
  assert.equal(result.topology, 'standalone-vm');
  assert.equal(result.checked_at, '2026-07-11T00:00:00.000Z');
  assert.deepEqual(result.summary, {
    signal_dns_resolved: true,
    turn_dns_resolved: true,
    signal_tls_valid: true,
    turn_tls_valid: true,
    signal_health_reachable: true,
    internal_health_reachable: true,
    rtc_tcp_reachable: true,
    turn_udp_probe_sent: true,
    rtc_udp_probe_sent: true
  });
  assert.deepEqual(result.checks.map((check) => check.id), [
    'signal_dns',
    'turn_dns',
    'signal_tls',
    'turn_tls',
    'signal_health',
    'internal_health',
    'rtc_tcp',
    'turn_udp_probe_sent',
    'rtc_udp_probe_sent'
  ]);
  const udpChecks = result.checks.filter((check) => check.id.includes('udp'));
  assert.equal(udpChecks.every((check) => check.message.includes('sent')), true);
  assert.equal(JSON.stringify(udpChecks).includes('protocol handshake succeeded'), false);
});

test('LiveKit server evidence rejects untrusted or near-expiry certificates', async () => {
  const probes = passingProbes();
  probes.tls = async (host) => host.startsWith('turn')
    ? {
        ok: true,
        authorized: true,
        valid_to: '2026-07-12T00:00:00.000Z',
        subject: host,
        issuer: 'Test CA'
      }
    : {
        ok: true,
        authorized: false,
        valid_to: '2030-01-01T00:00:00.000Z',
        subject: host,
        issuer: 'Test CA'
      };

  const result = await collectLiveKitServerEvidence(
    config(),
    probes,
    new Date('2026-07-11T00:00:00.000Z')
  );

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === 'signal_tls')?.status, 'fail');
  assert.equal(result.checks.find((check) => check.id === 'turn_tls')?.status, 'fail');
});

test('LiveKit server evidence reports probe failures without overstating UDP reachability', async () => {
  const probes = passingProbes();
  probes.lookup = async (host) => {
    if (host.startsWith('turn')) throw new Error('dns failed');
    return ['203.0.113.10'];
  };
  probes.tls = async (host) => host.startsWith('turn')
    ? { ok: false, authorized: false, error: 'certificate rejected' }
    : (passingProbes().tls(host, 443, 1000));
  probes.tcp = async () => false;
  probes.udp = async (_host, port) => port !== 3478;
  probes.health = async (url) => url.startsWith('http://')
    ? { ok: false, status: 503, error: 'unhealthy' }
    : { ok: true, status: 200 };

  const result = await collectLiveKitServerEvidence(config(), probes);

  assert.equal(result.ok, false);
  for (const id of ['turn_dns', 'turn_tls', 'internal_health', 'rtc_tcp', 'turn_udp_probe_sent']) {
    assert.equal(result.checks.find((check) => check.id === id)?.status, 'fail');
  }
  assert.equal(result.summary.turn_udp_probe_sent, false);
  assert.equal('turn_udp_reachable' in result.summary, false);
});

test('LiveKit server evidence config derives domains and rejects invalid topology', () => {
  const parsed = createLiveKitServerEvidenceConfigFromEnv({
    LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
    LIVEKIT_TURN_DOMAIN: 'turn.example.com',
    LIVEKIT_URL: 'ws://livekit.internal:7880',
    CONVERACT_LIVEKIT_ACCEPTANCE_RUN_ID: 'lk-run-20260711-001',
    CONVERACT_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID: 'led-staging-sfo2',
    CONVERACT_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT: 'a'.repeat(40),
    CONVERACT_LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT: 'b'.repeat(64),
    CONVERACT_LIVEKIT_ACCEPTANCE_STARTED_AT: new Date(Date.now() - 60_000).toISOString(),
    CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
    CONVERACT_LIVEKIT_SERVER_EVIDENCE_RTC_UDP_PORTS: '50000,55000,60000'
  });

  assert.equal(parsed.signalDomain, 'livekit.example.com');
  assert.equal(parsed.internalUrl, 'ws://livekit.internal:7880');
  assert.deepEqual(parsed.rtcUdpPorts, [50000, 55000, 60000]);
  assert.throws(
    () => createLiveKitServerEvidenceConfigFromEnv({
      LIVEKIT_PUBLIC_URL: 'ws://livekit.example.com',
      LIVEKIT_TURN_DOMAIN: 'turn.example.com',
      LIVEKIT_URL: 'ws://livekit.internal:7880'
    }),
    /LIVEKIT_PUBLIC_URL must use wss:\/\//
  );
  assert.throws(
    () => createLiveKitServerEvidenceConfigFromEnv({
      LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
      LIVEKIT_TURN_DOMAIN: 'livekit.example.com',
      LIVEKIT_URL: 'ws://livekit.internal:7880'
    }),
    /LIVEKIT_TURN_DOMAIN must differ/
  );
  assert.throws(
    () => createLiveKitServerEvidenceConfigFromEnv({
      LIVEKIT_PUBLIC_URL: 'wss://user:password@livekit.example.com/rtc?token=secret',
      LIVEKIT_TURN_DOMAIN: 'turn.example.com',
      LIVEKIT_URL: 'ws://livekit.internal:7880'
    }),
    /LIVEKIT_PUBLIC_URL must not contain credentials, query, or fragment/
  );
  assert.throws(
    () => createLiveKitServerEvidenceConfigFromEnv({
      LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
      LIVEKIT_TURN_DOMAIN: 'turn.example.com',
      LIVEKIT_URL: 'ws://livekit.internal:7880',
      CONVERACT_LIVEKIT_ACCEPTANCE_RUN_ID: 'lk-run-20260711-001',
      CONVERACT_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID: 'led-staging-sfo2',
      CONVERACT_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT: 'a'.repeat(40),
      CONVERACT_LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT: 'b'.repeat(64),
      CONVERACT_LIVEKIT_ACCEPTANCE_STARTED_AT: new Date(Date.now() - 60_000).toISOString(),
      CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
      CONVERACT_LIVEKIT_SERVER_EVIDENCE_RTC_TCP_PORT: '70000'
    }),
    /RTC_TCP_PORT must be an integer between 1 and 65535/
  );
  assert.throws(
    () => createLiveKitServerEvidenceConfigFromEnv({
      LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
      LIVEKIT_TURN_DOMAIN: 'turn.example.com',
      LIVEKIT_URL: 'ws://livekit.internal:7880',
      CONVERACT_LIVEKIT_ACCEPTANCE_RUN_ID: 'lk-run-20260711-001',
      CONVERACT_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID: 'led-staging-sfo2',
      CONVERACT_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT: 'a'.repeat(40),
      CONVERACT_LIVEKIT_ACCEPTANCE_DEPLOYMENT_FINGERPRINT: 'b'.repeat(64),
      CONVERACT_LIVEKIT_ACCEPTANCE_STARTED_AT: new Date(Date.now() - 60_000).toISOString(),
      CONVERACT_LIVEKIT_DEPLOYMENT_MODE: 'standalone-vm',
      CONVERACT_LIVEKIT_SERVER_EVIDENCE_TIMEOUT_MS: '99'
    }),
    /TIMEOUT_MS must be an integer between 100 and 60000/
  );
});

test('LiveKit server evidence writer creates a credential-free artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-livekit-server-evidence-'));
  const outputFile = join(dir, 'server-evidence.json');
  try {
    const write = await writeLiveKitServerEvidence(config(outputFile), passingProbes());
    const content = readFileSync(outputFile, 'utf8');

    assert.equal(write.outputFile, outputFile);
    assert.equal(write.ok, true);
    assert.equal(write.checks, 9);
    assert.equal(content.includes('LIVEKIT_API_SECRET'), false);
    assert.equal(content.includes('devkey'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveKit server evidence is exposed through package scripts', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };

  assert.equal(packageJson.scripts['livekit:server-evidence'], 'tsx scripts/livekit-server-evidence.ts');
});
