import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectRustDeskServerEvidence,
  createRustDeskServerEvidenceConfigFromEnv,
  writeRustDeskServerEvidence,
  type RustDeskServerEvidenceProbes
} from '../scripts/rustdesk-server-evidence.js';

test('RustDesk server evidence config maps production runtime env', () => {
  const config = createRustDeskServerEvidenceConfigFromEnv({
    OPC_RUSTDESK_SERVER_EVIDENCE_FILE: '/tmp/rustdesk-server-evidence.json',
    OPC_RUSTDESK_PUBLIC_KEY_FILE: '/rustdesk/id_ed25519.pub',
    OPC_RUSTDESK_ID_SERVER: 'rustdesk-id.example.com',
    OPC_RUSTDESK_RELAY_SERVER: 'rustdesk-relay.example.com',
    OPC_RUSTDESK_LAUNCH_BASE_URL: 'https://opc.example.com',
    OPC_RUSTDESK_SERVER_EVIDENCE_HBBS_TCP_PORTS: '21115,21116,21118',
    OPC_RUSTDESK_SERVER_EVIDENCE_HBBR_TCP_PORTS: '21117,21119',
    OPC_RUSTDESK_SERVER_EVIDENCE_UDP_PORTS: '21116',
    OPC_RUSTDESK_SERVER_EVIDENCE_TIMEOUT_MS: '2500'
  });

  assert.equal(config.outputFile, '/tmp/rustdesk-server-evidence.json');
  assert.equal(config.publicKeyFile, '/rustdesk/id_ed25519.pub');
  assert.equal(config.idServer, 'rustdesk-id.example.com');
  assert.equal(config.relayServer, 'rustdesk-relay.example.com');
  assert.equal(config.launchBaseUrl, 'https://opc.example.com');
  assert.deepEqual(config.hbbsTcpPorts, [21115, 21116, 21118]);
  assert.deepEqual(config.hbbrTcpPorts, [21117, 21119]);
  assert.deepEqual(config.udpPorts, [21116]);
  assert.equal(config.timeoutMs, 2500);
});

test('RustDesk server evidence passes when key, ports, DNS, TLS, and ingress probes pass', async () => {
  const result = await collectRustDeskServerEvidence(validConfig(), passingProbes());

  assert.equal(result.ok, true);
  assert.equal(result.summary.public_key_readable, true);
  assert.equal(result.summary.hbbs_started, true);
  assert.equal(result.summary.hbbr_started, true);
  assert.equal(result.summary.udp_probe_sent, true);
  assert.equal(result.summary.dns_resolved, true);
  assert.equal(result.summary.tls_valid, true);
  assert.equal(result.summary.ingress_reachable, true);
  assert.match(result.public_key.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(failedCheckIds(result), []);
});

test('RustDesk server evidence fails failed hbbr port and TLS probes without leaking secrets', async () => {
  const probes = passingProbes({
    tcp: async (_host, port) => port !== 21117,
    tls: async () => ({
      ok: false,
      authorized: false,
      valid_to: '2026-07-01T00:00:00.000Z',
      error: 'self signed certificate'
    })
  });

  const result = await collectRustDeskServerEvidence(validConfig(), probes);

  assert.equal(result.ok, false);
  assert.equal(failedCheckIds(result).includes('hbbr_tcp_ports'), true);
  assert.equal(failedCheckIds(result).includes('launch_tls'), true);
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('RustDesk server evidence writes a JSON artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-server-evidence-'));
  const outputFile = join(dir, 'server-evidence.json');

  const result = await writeRustDeskServerEvidence({
    ...validConfig(),
    outputFile
  }, passingProbes());

  assert.equal(result.outputFile, outputFile);
  assert.equal(result.ok, true);
  const written = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(written.ok, true);
  assert.equal(written.checks.some((check: { id: string }) => check.id === 'public_key_file'), true);
});

test('RustDesk server evidence is exposed as a package script with env samples', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:server-evidence'], 'tsx scripts/rustdesk-server-evidence.ts');

  const rootEnv = readFileSync('.env.example', 'utf8');
  const infraEnv = readFileSync('infra/env.example', 'utf8');
  for (const key of [
    'OPC_RUSTDESK_SERVER_EVIDENCE_FILE=',
    'OPC_RUSTDESK_SERVER_EVIDENCE_HBBS_TCP_PORTS=',
    'OPC_RUSTDESK_SERVER_EVIDENCE_HBBR_TCP_PORTS=',
    'OPC_RUSTDESK_SERVER_EVIDENCE_UDP_PORTS=',
    'OPC_RUSTDESK_SERVER_EVIDENCE_TIMEOUT_MS='
  ]) {
    assert.match(rootEnv, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnv, new RegExp(`^${key}`, 'm'));
  }
});

function validConfig() {
  return {
    outputFile: '',
    publicKeyFile: '/rustdesk/id_ed25519.pub',
    idServer: 'rustdesk-id.example.com',
    relayServer: 'rustdesk-relay.example.com',
    launchBaseUrl: 'https://opc.example.com',
    hbbsTcpPorts: [21115, 21116, 21118],
    hbbrTcpPorts: [21117, 21119],
    udpPorts: [21116],
    timeoutMs: 1500
  };
}

function passingProbes(overrides: Partial<RustDeskServerEvidenceProbes> = {}): RustDeskServerEvidenceProbes {
  return {
    readFile: async () => 'rustdesk-public-key',
    lookup: async (host) => [`${host}:203.0.113.10`],
    tcp: async () => true,
    udp: async () => true,
    tls: async () => ({
      ok: true,
      authorized: true,
      valid_to: '2027-07-08T00:00:00.000Z',
      issuer: 'Example CA',
      subject: 'opc.example.com'
    }),
    ingress: async () => ({ ok: true, status: 200 }),
    ...overrides
  };
}

function failedCheckIds(result: { checks: Array<{ id: string; status: string }> }): string[] {
  return result.checks.filter((check) => check.status === 'fail').map((check) => check.id);
}
