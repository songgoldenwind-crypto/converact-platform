import { resolveBrandEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { createSocket } from 'node:dgram';
import { mkdirSync, promises as fsPromises, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as createTcpConnection } from 'node:net';
import { dirname } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { connect as createTlsConnection } from 'node:tls';
import { fileURLToPath } from 'node:url';

export type RustDeskServerEvidenceStatus = 'pass' | 'fail';

export interface RustDeskServerEvidenceConfig {
  outputFile?: string;
  publicKeyFile: string;
  idServer: string;
  relayServer: string;
  launchBaseUrl: string;
  hbbsTcpPorts: number[];
  hbbrTcpPorts: number[];
  udpPorts: number[];
  timeoutMs: number;
}

export interface RustDeskServerEvidenceCheck {
  id: string;
  status: RustDeskServerEvidenceStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface RustDeskServerEvidenceResult {
  ok: boolean;
  checked_at: string;
  summary: {
    public_key_readable: boolean;
    hbbs_started: boolean;
    hbbr_started: boolean;
    udp_probe_sent: boolean;
    dns_resolved: boolean;
    tls_valid: boolean;
    ingress_reachable: boolean;
  };
  public_key: {
    path: string;
    bytes: number;
    sha256: string;
  };
  checks: RustDeskServerEvidenceCheck[];
}

export interface RustDeskServerEvidenceWriteResult {
  outputFile: string;
  ok: boolean;
  checks: number;
}

export interface RustDeskServerEvidenceTlsResult {
  ok: boolean;
  authorized: boolean;
  valid_to?: string;
  issuer?: string;
  subject?: string;
  error?: string;
}

export interface RustDeskServerEvidenceIngressResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface RustDeskServerEvidenceProbes {
  readFile: (path: string) => Promise<string>;
  lookup: (host: string) => Promise<string[]>;
  tcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  udp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  tls: (host: string, port: number, timeoutMs: number) => Promise<RustDeskServerEvidenceTlsResult>;
  ingress: (url: string, timeoutMs: number) => Promise<RustDeskServerEvidenceIngressResult>;
}

const DEFAULT_HBBS_TCP_PORTS = [21115, 21116, 21118];
const DEFAULT_HBBR_TCP_PORTS = [21117, 21119];
const DEFAULT_UDP_PORTS = [21116];

export function createRustDeskServerEvidenceConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskServerEvidenceConfig {
  const outputFile = optionalString(resolveBrandEnv(env, 'RUSTDESK_SERVER_EVIDENCE_FILE'));
  const publicKeyFile = optionalString(resolveBrandEnv(env, 'RUSTDESK_PUBLIC_KEY_FILE')) || '/rustdesk/id_ed25519.pub';
  const idServer = rustDeskEndpointHost(resolveBrandEnv(env, 'RUSTDESK_CHECK_HOST') || resolveBrandEnv(env, 'RUSTDESK_ID_SERVER'));
  const relayServer = rustDeskEndpointHost(resolveBrandEnv(env, 'RUSTDESK_RELAY_SERVER')) || idServer;
  const launchBaseUrl = stripTrailingSlash(optionalString(
    resolveBrandEnv(env, 'RUSTDESK_LAUNCH_BASE_URL') ||
    resolveBrandEnv(env, 'BASE_URL') ||
    resolveBrandEnv(env, 'REMOTE_GATEWAY_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_CONTROL_PLANE_BASE_URL')
  ));
  const timeoutMs = positiveInteger(resolveBrandEnv(env, 'RUSTDESK_SERVER_EVIDENCE_TIMEOUT_MS') || resolveBrandEnv(env, 'RUSTDESK_CHECK_TIMEOUT_MS'), 1500);

  if (!idServer) throw new Error('CONVERACT_RUSTDESK_ID_SERVER or CONVERACT_RUSTDESK_CHECK_HOST is required');
  if (!relayServer) throw new Error('CONVERACT_RUSTDESK_RELAY_SERVER or CONVERACT_RUSTDESK_ID_SERVER is required');
  if (!launchBaseUrl) throw new Error('CONVERACT_RUSTDESK_LAUNCH_BASE_URL or CONVERACT_BASE_URL is required');

  return {
    ...(outputFile ? { outputFile } : {}),
    publicKeyFile,
    idServer,
    relayServer,
    launchBaseUrl,
    hbbsTcpPorts: parsePorts(resolveBrandEnv(env, 'RUSTDESK_SERVER_EVIDENCE_HBBS_TCP_PORTS'), DEFAULT_HBBS_TCP_PORTS),
    hbbrTcpPorts: parsePorts(resolveBrandEnv(env, 'RUSTDESK_SERVER_EVIDENCE_HBBR_TCP_PORTS'), DEFAULT_HBBR_TCP_PORTS),
    udpPorts: parsePorts(resolveBrandEnv(env, 'RUSTDESK_SERVER_EVIDENCE_UDP_PORTS'), DEFAULT_UDP_PORTS),
    timeoutMs
  };
}

export async function collectRustDeskServerEvidence(
  config: RustDeskServerEvidenceConfig,
  probes: RustDeskServerEvidenceProbes = defaultRustDeskServerEvidenceProbes()
): Promise<RustDeskServerEvidenceResult> {
  const checks: RustDeskServerEvidenceCheck[] = [];
  const launchUrl = parseUrl(config.launchBaseUrl);
  const publicKey = await checkPublicKey(config.publicKeyFile, probes, checks);
  const idServerDns = await checkDns('id_server_dns', config.idServer, probes, checks);
  const relayServerDns = config.relayServer === config.idServer
    ? idServerDns
    : await checkDns('relay_server_dns', config.relayServer, probes, checks);
  const launchDns = await checkDns('launch_dns', launchUrl.hostname, probes, checks);
  const hbbsStarted = await checkTcpGroup('hbbs_tcp_ports', config.idServer, config.hbbsTcpPorts, config.timeoutMs, probes, checks);
  const hbbrStarted = await checkTcpGroup('hbbr_tcp_ports', config.relayServer, config.hbbrTcpPorts, config.timeoutMs, probes, checks);
  const udpProbeSent = await checkUdpGroup('udp_ports', config.idServer, config.udpPorts, config.timeoutMs, probes, checks);
  const tlsValid = await checkTls(launchUrl, config.timeoutMs, probes, checks);
  const ingressReachable = await checkIngress(config.launchBaseUrl, config.timeoutMs, probes, checks);
  const dnsResolved = idServerDns && relayServerDns && launchDns;

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checked_at: new Date().toISOString(),
    summary: {
      public_key_readable: publicKey.bytes > 0,
      hbbs_started: hbbsStarted,
      hbbr_started: hbbrStarted,
      udp_probe_sent: udpProbeSent,
      dns_resolved: dnsResolved,
      tls_valid: tlsValid,
      ingress_reachable: ingressReachable
    },
    public_key: publicKey,
    checks
  };
}

export async function writeRustDeskServerEvidence(
  config: RustDeskServerEvidenceConfig,
  probes: RustDeskServerEvidenceProbes = defaultRustDeskServerEvidenceProbes()
): Promise<RustDeskServerEvidenceWriteResult> {
  if (!config.outputFile) throw new Error('CONVERACT_RUSTDESK_SERVER_EVIDENCE_FILE is required when writing server evidence');
  const result = await collectRustDeskServerEvidence(config, probes);
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return {
    outputFile: config.outputFile,
    ok: result.ok,
    checks: result.checks.length
  };
}

function defaultRustDeskServerEvidenceProbes(): RustDeskServerEvidenceProbes {
  return {
    readFile: async (path) => fsPromises.readFile(path, 'utf8'),
    lookup: async (host) => {
      const addresses = await dns.lookup(host, { all: true });
      return addresses.map((address) => address.address);
    },
    tcp: tcpProbe,
    udp: udpProbe,
    tls: tlsProbe,
    ingress: ingressProbe
  };
}

async function checkPublicKey(
  path: string,
  probes: RustDeskServerEvidenceProbes,
  checks: RustDeskServerEvidenceCheck[]
): Promise<RustDeskServerEvidenceResult['public_key']> {
  try {
    const raw = (await probes.readFile(path)).trim();
    const bytes = Buffer.byteLength(raw, 'utf8');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    checks.push({
      id: 'public_key_file',
      status: bytes > 0 ? 'pass' : 'fail',
      message: bytes > 0 ? 'RustDesk public key file is readable' : 'RustDesk public key file is empty',
      details: { path, bytes, sha256: sha256.slice(0, 16) }
    });
    return { path, bytes, sha256 };
  } catch (error) {
    checks.push({
      id: 'public_key_file',
      status: 'fail',
      message: `RustDesk public key file cannot be read: ${(error as Error).message}`,
      details: { path }
    });
    return { path, bytes: 0, sha256: '' };
  }
}

async function checkDns(
  id: string,
  host: string,
  probes: RustDeskServerEvidenceProbes,
  checks: RustDeskServerEvidenceCheck[]
): Promise<boolean> {
  try {
    const addresses = await probes.lookup(host);
    const pass = addresses.length > 0;
    checks.push({
      id,
      status: pass ? 'pass' : 'fail',
      message: pass ? `${host} resolves` : `${host} did not resolve`,
      details: { host, addresses }
    });
    return pass;
  } catch (error) {
    checks.push({
      id,
      status: 'fail',
      message: `${host} DNS lookup failed: ${(error as Error).message}`,
      details: { host }
    });
    return false;
  }
}

async function checkTcpGroup(
  id: string,
  host: string,
  ports: number[],
  timeoutMs: number,
  probes: RustDeskServerEvidenceProbes,
  checks: RustDeskServerEvidenceCheck[]
): Promise<boolean> {
  const results = await Promise.all(ports.map(async (port) => ({
    port,
    reachable: await probes.tcp(host, port, timeoutMs)
  })));
  const failed = results.filter((result) => !result.reachable).map((result) => result.port);
  checks.push({
    id,
    status: failed.length === 0 ? 'pass' : 'fail',
    message: failed.length === 0
      ? `${host} TCP ports reachable: ${ports.join(',')}`
      : `${host} TCP ports failed: ${failed.join(',')}`,
    details: { host, results }
  });
  return failed.length === 0;
}

async function checkUdpGroup(
  id: string,
  host: string,
  ports: number[],
  timeoutMs: number,
  probes: RustDeskServerEvidenceProbes,
  checks: RustDeskServerEvidenceCheck[]
): Promise<boolean> {
  const results = await Promise.all(ports.map(async (port) => ({
    port,
    sent: await probes.udp(host, port, timeoutMs)
  })));
  const failed = results.filter((result) => !result.sent).map((result) => result.port);
  checks.push({
    id,
    status: failed.length === 0 ? 'pass' : 'fail',
    message: failed.length === 0
      ? `${host} UDP probes sent: ${ports.join(',')}`
      : `${host} UDP probes failed: ${failed.join(',')}`,
    details: { host, results, note: 'UDP send success does not prove RustDesk protocol handshake.' }
  });
  return failed.length === 0;
}

async function checkTls(
  launchUrl: URL,
  timeoutMs: number,
  probes: RustDeskServerEvidenceProbes,
  checks: RustDeskServerEvidenceCheck[]
): Promise<boolean> {
  if (launchUrl.protocol !== 'https:') {
    checks.push({
      id: 'launch_tls',
      status: 'fail',
      message: 'RustDesk launch base URL must use https:// for TLS evidence',
      details: { url: redactUrl(launchUrl) }
    });
    return false;
  }
  const port = Number(launchUrl.port || 443);
  const result = await probes.tls(launchUrl.hostname, port, timeoutMs);
  checks.push({
    id: 'launch_tls',
    status: result.ok && result.authorized ? 'pass' : 'fail',
    message: result.ok && result.authorized
      ? `TLS handshake authorized for ${launchUrl.hostname}`
      : `TLS handshake failed for ${launchUrl.hostname}: ${result.error || 'not authorized'}`,
    details: { host: launchUrl.hostname, port, ...result }
  });
  return result.ok && result.authorized;
}

async function checkIngress(
  url: string,
  timeoutMs: number,
  probes: RustDeskServerEvidenceProbes,
  checks: RustDeskServerEvidenceCheck[]
): Promise<boolean> {
  const result = await probes.ingress(url, timeoutMs);
  checks.push({
    id: 'launch_ingress',
    status: result.ok ? 'pass' : 'fail',
    message: result.ok
      ? `Launch ingress responded with HTTP ${result.status}`
      : `Launch ingress probe failed: ${result.error || 'unreachable'}`,
    details: { status: result.status }
  });
  return result.ok;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createTcpConnection({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function udpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, timeoutMs);
    socket.send(Buffer.from('converact-rustdesk-udp-probe'), port, host, (error) => {
      clearTimeout(timer);
      socket.close();
      resolve(!error);
    });
  });
}

function tlsProbe(host: string, port: number, timeoutMs: number): Promise<RustDeskServerEvidenceTlsResult> {
  return new Promise((resolve) => {
    const socket = createTlsConnection({
      host,
      port,
      servername: host,
      rejectUnauthorized: true
    });
    const done = (result: RustDeskServerEvidenceTlsResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      done({
        ok: true,
        authorized: socket.authorized,
        valid_to: certificate.valid_to,
        issuer: typeof certificate.issuer?.O === 'string' ? certificate.issuer.O : undefined,
        subject: typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : undefined
      });
    });
    socket.once('timeout', () => done({ ok: false, authorized: false, error: 'timeout' }));
    socket.once('error', (error) => done({ ok: false, authorized: false, error: error.message }));
  });
}

function ingressProbe(url: string, timeoutMs: number): Promise<RustDeskServerEvidenceIngressResult> {
  return new Promise((resolve) => {
    const parsed = parseUrl(url);
    const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: Boolean(res.statusCode && res.statusCode < 500), status: res.statusCode });
    });
    req.once('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.once('error', (error) => resolve({ ok: false, error: error.message }));
    req.end();
  });
}

function parsePorts(value: string | undefined, fallback: number[]): number[] {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const ports = raw.split(',').map((item) => Number(item.trim()));
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`invalid RustDesk port list: ${raw}`);
  }
  return ports;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 100) throw new Error(`invalid timeout: ${raw}`);
  return parsed;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`invalid launch base URL: ${value}`);
  }
}

function stripTrailingSlash(value: string | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

function rustDeskEndpointHost(value: string | undefined): string {
  const endpoint = optionalString(value);
  if (!endpoint) return '';
  try {
    return new URL(`tcp://${endpoint}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return endpoint;
  }
}

function redactUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function main(): Promise<void> {
  const config = createRustDeskServerEvidenceConfigFromEnv(process.env);
  if (config.outputFile) {
    const result = await writeRustDeskServerEvidence(config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = await collectRustDeskServerEvidence(config);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
