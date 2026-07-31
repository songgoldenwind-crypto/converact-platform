import { resolveBrandEnv, resolveConveractEnv } from '../src/config/converact-env.js';
import { promises as dns } from 'node:dns';
import { createSocket } from 'node:dgram';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as createTcpConnection } from 'node:net';
import { dirname } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { connect as createTlsConnection } from 'node:tls';
import { fileURLToPath } from 'node:url';

import {
  createLiveKitAcceptanceMetadata,
  type LiveKitAcceptanceMetadata
} from './livekit-acceptance-metadata.js';

export type LiveKitServerEvidenceStatus = 'pass' | 'fail';
export type LiveKitServerEvidenceTopology = 'standalone-vm' | 'external';

export interface LiveKitServerEvidenceConfig {
  acceptance: LiveKitAcceptanceMetadata;
  outputFile?: string;
  topology?: LiveKitServerEvidenceTopology;
  signalDomain: string;
  turnDomain: string;
  internalUrl: string;
  signalTlsPort: number;
  turnTlsPort: number;
  rtcTcpPort: number;
  turnUdpPort: number;
  rtcUdpPorts: number[];
  timeoutMs: number;
  minCertificateValidityDays: number;
}

export interface LiveKitServerEvidenceCheck {
  id: string;
  status: LiveKitServerEvidenceStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface LiveKitServerEvidenceTlsResult {
  ok: boolean;
  authorized: boolean;
  valid_to?: string;
  subject?: string;
  issuer?: string;
  fingerprint256?: string;
  error?: string;
}

export interface LiveKitServerEvidenceHealthResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface LiveKitServerEvidenceProbes {
  lookup: (host: string) => Promise<string[]>;
  tcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  udp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  tls: (host: string, port: number, timeoutMs: number) => Promise<LiveKitServerEvidenceTlsResult>;
  health: (url: string, timeoutMs: number) => Promise<LiveKitServerEvidenceHealthResult>;
}

export interface LiveKitServerEvidenceResult {
  schema_version: 1;
  acceptance: LiveKitAcceptanceMetadata;
  ok: boolean;
  checked_at: string;
  topology: LiveKitServerEvidenceTopology;
  summary: {
    signal_dns_resolved: boolean;
    turn_dns_resolved: boolean;
    signal_tls_valid: boolean;
    turn_tls_valid: boolean;
    signal_health_reachable: boolean;
    internal_health_reachable: boolean;
    rtc_tcp_reachable: boolean;
    turn_udp_probe_sent: boolean;
    rtc_udp_probe_sent: boolean;
  };
  checks: LiveKitServerEvidenceCheck[];
}

export interface LiveKitServerEvidenceWriteResult {
  outputFile: string;
  ok: boolean;
  checks: number;
}

export function createLiveKitServerEvidenceConfigFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitServerEvidenceConfig {
  const publicUrl = parseCleanUrl(required(env, 'LIVEKIT_PUBLIC_URL'), 'LIVEKIT_PUBLIC_URL');
  if (publicUrl.protocol !== 'wss:') throw new Error('LIVEKIT_PUBLIC_URL must use wss://');
  const internalUrl = parseCleanUrl(
    String(env.LIVEKIT_URL || resolveBrandEnv(env, 'LIVEKIT_URL') || '').trim(),
    'LIVEKIT_URL'
  );
  if (internalUrl.protocol !== 'ws:' && internalUrl.protocol !== 'wss:') {
    throw new Error('LIVEKIT_URL must use ws:// or wss://');
  }
  const turnDomain = validDomain(required(env, 'LIVEKIT_TURN_DOMAIN'), 'LIVEKIT_TURN_DOMAIN');
  const signalDomain = validDomain(publicUrl.hostname, 'LIVEKIT_PUBLIC_URL hostname');
  if (turnDomain === signalDomain) {
    throw new Error('LIVEKIT_TURN_DOMAIN must differ from LIVEKIT_PUBLIC_URL hostname');
  }
  const topology = parseTopology(resolveBrandEnv(env, 'LIVEKIT_DEPLOYMENT_MODE'));
  const rangeStart = port(resolveBrandEnv(env, 'LIVEKIT_EDGE_RTC_PORT_RANGE_START'), 'CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_START', 50_000);
  const rangeEnd = port(resolveBrandEnv(env, 'LIVEKIT_EDGE_RTC_PORT_RANGE_END'), 'CONVERACT_LIVEKIT_EDGE_RTC_PORT_RANGE_END', 60_000);
  if (rangeEnd < rangeStart) throw new Error('RTC UDP port range end must be greater than or equal to start');

  return {
    acceptance: createLiveKitAcceptanceMetadata(env),
    ...(optional(resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_FILE')) ? {
      outputFile: optional(resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_FILE'))
    } : {}),
    topology,
    signalDomain,
    turnDomain,
    internalUrl: serializeCleanUrl(internalUrl),
    signalTlsPort: port(
      resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_SIGNAL_TLS_PORT') || publicUrl.port,
      'CONVERACT_LIVEKIT_SERVER_EVIDENCE_SIGNAL_TLS_PORT',
      443
    ),
    turnTlsPort: port(resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_TURN_TLS_PORT'), 'CONVERACT_LIVEKIT_SERVER_EVIDENCE_TURN_TLS_PORT', 443),
    rtcTcpPort: port(
      resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_RTC_TCP_PORT') || resolveBrandEnv(env, 'MEDIA_CONFIG_RTC_TCP_PORT'),
      'CONVERACT_LIVEKIT_SERVER_EVIDENCE_RTC_TCP_PORT',
      7881
    ),
    turnUdpPort: port(
      resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_TURN_UDP_PORT') || resolveBrandEnv(env, 'LIVEKIT_EDGE_TURN_UDP_PORT'),
      'CONVERACT_LIVEKIT_SERVER_EVIDENCE_TURN_UDP_PORT',
      3478
    ),
    rtcUdpPorts: parsePortList(resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_RTC_UDP_PORTS'), rangeStart, rangeEnd),
    timeoutMs: boundedInteger(
      resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_TIMEOUT_MS'),
      'CONVERACT_LIVEKIT_SERVER_EVIDENCE_TIMEOUT_MS',
      1500,
      100,
      60_000
    ),
    minCertificateValidityDays: boundedInteger(
      resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_MIN_CERT_VALIDITY_DAYS'),
      'CONVERACT_LIVEKIT_SERVER_EVIDENCE_MIN_CERT_VALIDITY_DAYS',
      7,
      1,
      365
    )
  };
}

export async function collectLiveKitServerEvidence(
  config: LiveKitServerEvidenceConfig,
  probes: LiveKitServerEvidenceProbes = defaultProbes(),
  now = new Date()
): Promise<LiveKitServerEvidenceResult> {
  const checks: LiveKitServerEvidenceCheck[] = [];
  const signalDns = await checkDns('signal_dns', config.signalDomain, probes, checks);
  const turnDns = await checkDns('turn_dns', config.turnDomain, probes, checks);
  const signalTls = await checkTls(
    'signal_tls',
    config.signalDomain,
    config.signalTlsPort,
    config,
    probes,
    checks,
    now
  );
  const turnTls = await checkTls(
    'turn_tls',
    config.turnDomain,
    config.turnTlsPort,
    config,
    probes,
    checks,
    now
  );
  const signalHealth = await checkHealth(
    'signal_health',
    `https://${config.signalDomain}${config.signalTlsPort === 443 ? '' : `:${config.signalTlsPort}`}/`,
    config.timeoutMs,
    probes,
    checks
  );
  const internalHealth = await checkHealth(
    'internal_health',
    liveKitHealthUrl(config.internalUrl),
    config.timeoutMs,
    probes,
    checks
  );
  const rtcTcp = await checkTcp(
    'rtc_tcp',
    config.signalDomain,
    config.rtcTcpPort,
    config.timeoutMs,
    probes,
    checks
  );
  const turnUdp = await checkUdp(
    'turn_udp_probe_sent',
    config.turnDomain,
    [config.turnUdpPort],
    config.timeoutMs,
    probes,
    checks
  );
  const rtcUdp = await checkUdp(
    'rtc_udp_probe_sent',
    config.signalDomain,
    config.rtcUdpPorts,
    config.timeoutMs,
    probes,
    checks
  );

  return {
    schema_version: 1,
    acceptance: config.acceptance,
    ok: checks.every((check) => check.status === 'pass'),
    checked_at: now.toISOString(),
    topology: config.topology || 'standalone-vm',
    summary: {
      signal_dns_resolved: signalDns,
      turn_dns_resolved: turnDns,
      signal_tls_valid: signalTls,
      turn_tls_valid: turnTls,
      signal_health_reachable: signalHealth,
      internal_health_reachable: internalHealth,
      rtc_tcp_reachable: rtcTcp,
      turn_udp_probe_sent: turnUdp,
      rtc_udp_probe_sent: rtcUdp
    },
    checks
  };
}

export async function writeLiveKitServerEvidence(
  config: LiveKitServerEvidenceConfig,
  probes: LiveKitServerEvidenceProbes = defaultProbes()
): Promise<LiveKitServerEvidenceWriteResult> {
  if (!config.outputFile) {
    throw new Error('CONVERACT_LIVEKIT_SERVER_EVIDENCE_FILE is required when writing server evidence');
  }
  const result = await collectLiveKitServerEvidence(config, probes);
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { outputFile: config.outputFile, ok: result.ok, checks: result.checks.length };
}

function defaultProbes(): LiveKitServerEvidenceProbes {
  return {
    lookup: async (host) => (await dns.lookup(host, { all: true })).map((item) => item.address),
    tcp: tcpProbe,
    udp: udpProbe,
    tls: tlsProbe,
    health: healthProbe
  };
}

async function checkDns(
  id: string,
  host: string,
  probes: LiveKitServerEvidenceProbes,
  checks: LiveKitServerEvidenceCheck[]
): Promise<boolean> {
  try {
    const addresses = await probes.lookup(host);
    const ok = addresses.length > 0;
    checks.push({
      id,
      status: ok ? 'pass' : 'fail',
      message: ok ? `${host} resolves` : `${host} returned no address`,
      details: { host, addresses }
    });
    return ok;
  } catch (error) {
    checks.push({
      id,
      status: 'fail',
      message: `${host} DNS lookup failed: ${errorMessage(error)}`,
      details: { host }
    });
    return false;
  }
}

async function checkTls(
  id: string,
  host: string,
  portValue: number,
  config: LiveKitServerEvidenceConfig,
  probes: LiveKitServerEvidenceProbes,
  checks: LiveKitServerEvidenceCheck[],
  now: Date
): Promise<boolean> {
  const result = await probes.tls(host, portValue, config.timeoutMs);
  const validTo = result.valid_to ? new Date(result.valid_to) : null;
  const minimumValidTo = new Date(now.getTime() + config.minCertificateValidityDays * 86_400_000);
  const validityOk = Boolean(validTo && Number.isFinite(validTo.getTime()) && validTo >= minimumValidTo);
  const ok = result.ok && result.authorized && validityOk;
  checks.push({
    id,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${host}:${portValue} TLS certificate is trusted and sufficiently valid`
      : `${host}:${portValue} TLS validation failed: ${result.error || (result.authorized ? 'certificate expires too soon' : 'certificate is not authorized')}`,
    details: {
      host,
      port: portValue,
      authorized: result.authorized,
      valid_to: result.valid_to || '',
      issuer: result.issuer || '',
      subject: result.subject || '',
      fingerprint256: result.fingerprint256 || '',
      minimum_validity_days: config.minCertificateValidityDays
    }
  });
  return ok;
}

async function checkHealth(
  id: string,
  url: string,
  timeoutMs: number,
  probes: LiveKitServerEvidenceProbes,
  checks: LiveKitServerEvidenceCheck[]
): Promise<boolean> {
  const result = await probes.health(url, timeoutMs);
  checks.push({
    id,
    status: result.ok ? 'pass' : 'fail',
    message: result.ok
      ? `${safeUrl(url)} health endpoint responded`
      : `${safeUrl(url)} health endpoint failed: ${result.error || result.status || 'unknown'}`,
    details: { url: safeUrl(url), status: result.status || 0 }
  });
  return result.ok;
}

async function checkTcp(
  id: string,
  host: string,
  portValue: number,
  timeoutMs: number,
  probes: LiveKitServerEvidenceProbes,
  checks: LiveKitServerEvidenceCheck[]
): Promise<boolean> {
  const ok = await probes.tcp(host, portValue, timeoutMs);
  checks.push({
    id,
    status: ok ? 'pass' : 'fail',
    message: ok ? `${host}:${portValue} TCP connection succeeded` : `${host}:${portValue} TCP connection failed`,
    details: { host, port: portValue }
  });
  return ok;
}

async function checkUdp(
  id: string,
  host: string,
  ports: number[],
  timeoutMs: number,
  probes: LiveKitServerEvidenceProbes,
  checks: LiveKitServerEvidenceCheck[]
): Promise<boolean> {
  const results = await Promise.all(ports.map(async (portValue) => ({
    port: portValue,
    sent: await probes.udp(host, portValue, timeoutMs)
  })));
  const ok = results.every((item) => item.sent);
  checks.push({
    id,
    status: ok ? 'pass' : 'fail',
    message: ok ? `${host} UDP probes sent` : `${host} one or more UDP probes could not be sent`,
    details: {
      host,
      results,
      note: 'This is a send-only probe. No ICE or TURN response is verified.'
    }
  });
  return ok;
}

function tcpProbe(host: string, portValue: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createTcpConnection({ host, port: portValue });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function udpProbe(host: string, portValue: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    socket.once('error', () => finish(false));
    socket.send(Buffer.from([0]), portValue, host, (error) => finish(!error));
  });
}

function tlsProbe(host: string, portValue: number, timeoutMs: number): Promise<LiveKitServerEvidenceTlsResult> {
  return new Promise((resolve) => {
    const socket = createTlsConnection({
      host,
      port: portValue,
      servername: host,
      rejectUnauthorized: true
    });
    let settled = false;
    const finish = (result: LiveKitServerEvidenceTlsResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, authorized: false, error: 'timeout' }));
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      finish({
        ok: true,
        authorized: socket.authorized,
        valid_to: certificate.valid_to ? new Date(certificate.valid_to).toISOString() : undefined,
        subject: certificateName(certificate.subject?.CN),
        issuer: certificateName(certificate.issuer?.CN),
        fingerprint256: certificate.fingerprint256
      });
    });
    socket.once('error', (error) => finish({ ok: false, authorized: false, error: error.message }));
  });
}

function healthProbe(urlValue: string, timeoutMs: number): Promise<LiveKitServerEvidenceHealthResult> {
  return new Promise((resolve) => {
    const url = new URL(urlValue);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      timeout: timeoutMs
    }, (response) => {
      response.resume();
      const status = response.statusCode || 0;
      resolve({ ok: status >= 200 && status < 400, status });
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', (error) => resolve({ ok: false, error: error.message }));
    request.end();
  });
}

function parseCleanUrl(raw: string, key: string): URL {
  if (!raw) throw new Error(`${key} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must not contain credentials, query, or fragment`);
  }
  return url;
}

function liveKitHealthUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function serializeCleanUrl(url: URL): string {
  if (url.pathname === '/') return `${url.protocol}//${url.host}`;
  return url.toString();
}

function safeUrl(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseTopology(value: string | undefined): LiveKitServerEvidenceTopology {
  const normalized = String(value || 'standalone-vm').trim();
  if (normalized === 'standalone-vm' || normalized === 'external') return normalized;
  throw new Error('CONVERACT_LIVEKIT_DEPLOYMENT_MODE must be standalone-vm or external for server evidence');
}

function parsePortList(value: string | undefined, start: number, end: number): number[] {
  if (!value?.trim()) return [...new Set([start, Math.floor((start + end) / 2), end])];
  const values = value.split(',').map((item) => port(item.trim(), 'CONVERACT_LIVEKIT_SERVER_EVIDENCE_RTC_UDP_PORTS', 0));
  if (!values.length) throw new Error('CONVERACT_LIVEKIT_SERVER_EVIDENCE_RTC_UDP_PORTS is required');
  return [...new Set(values)];
}

function port(value: string | undefined, key: string, fallback: number): number {
  return boundedInteger(value, key, fallback, 1, 65_535);
}

function boundedInteger(
  value: string | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = value == null || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function validDomain(value: string, key: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(normalized)) {
    throw new Error(`${key} must be a valid DNS domain`);
  }
  return normalized;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = optional(resolveConveractEnv(env, key));
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optional(value: string | undefined): string {
  return String(value || '').trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function certificateName(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

async function main(): Promise<void> {
  const config = createLiveKitServerEvidenceConfigFromEnv(process.env);
  const result = await collectLiveKitServerEvidence(config);
  if (config.outputFile) {
    mkdirSync(dirname(config.outputFile), { recursive: true });
    writeFileSync(config.outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
