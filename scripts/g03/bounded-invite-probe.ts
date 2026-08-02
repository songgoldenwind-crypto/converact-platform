import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_SIP_MESSAGE_BYTES = 65_535;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const SIP_USER = /^\+?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface BoundedInviteRequest {
  service: string;
  target_ip: string;
  target_port: number;
  local_ip: string;
  local_port: number;
  call_id: string;
  branch: string;
  from_tag: string;
}

export interface ParsedSipResponse {
  status: number;
  reason: string;
  to: string;
  retry_after_seconds: number | null;
}

export function renderBoundedInvite(input: BoundedInviteRequest): string {
  const request = validateRequest(input);
  return [
    `INVITE sip:${request.service}@${request.target_ip}:${request.target_port} SIP/2.0`,
    `Via: SIP/2.0/UDP ${request.local_ip}:${request.local_port};branch=${request.branch}`,
    `From: Converact G03 Probe <sip:g03-probe@${request.local_ip}:${request.local_port}>;tag=${request.from_tag}`,
    `To: <sip:${request.service}@${request.target_ip}:${request.target_port}>`,
    `Call-ID: ${request.call_id}`,
    'CSeq: 1 INVITE',
    `Contact: <sip:g03-probe@${request.local_ip}:${request.local_port};transport=UDP>`,
    'Max-Forwards: 70',
    'Subject: Converact G03 bounded blocking probe',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n');
}

export function parseSipResponse(wire: string | Uint8Array): ParsedSipResponse {
  const bytes = typeof wire === 'string' ? Buffer.from(wire) : Buffer.from(wire);
  if (!bytes.length || bytes.length > MAX_SIP_MESSAGE_BYTES) {
    throw new Error('SIP response size is invalid');
  }
  const text = bytes.toString('utf8');
  const lines = text.split(/\r\n|\n/u);
  const statusLine = /^SIP\/2\.0 ([1-6][0-9]{2})(?: ([^\r\n]*))?$/u.exec(lines[0] || '');
  if (!statusLine) throw new Error('SIP response status line is invalid');
  const status = Number(statusLine[1]);
  const to = header(lines, 'To');
  if (!to || /[\r\n\0]/u.test(to)) throw new Error('SIP response To header is invalid');
  const retryAfter = header(lines, 'Retry-After');
  let retryAfterSeconds: number | null = null;
  if (retryAfter !== null) {
    if (!/^[1-9][0-9]{0,3}$/u.test(retryAfter)) {
      throw new Error('SIP response Retry-After header is invalid');
    }
    retryAfterSeconds = Number(retryAfter);
    if (retryAfterSeconds > 3_600) {
      throw new Error('SIP response Retry-After header is invalid');
    }
  }
  return Object.freeze({
    status,
    reason: statusLine[2] || '',
    to,
    retry_after_seconds: retryAfterSeconds
  });
}

export function renderNon2xxAck(
  input: BoundedInviteRequest,
  responseTo: string
): string {
  const request = validateRequest(input);
  if (!responseTo || responseTo.length > 2_048 || /[\r\n\0]/u.test(responseTo)) {
    throw new Error('SIP response To header is invalid');
  }
  return [
    `ACK sip:${request.service}@${request.target_ip}:${request.target_port} SIP/2.0`,
    `Via: SIP/2.0/UDP ${request.local_ip}:${request.local_port};branch=${request.branch}`,
    `From: Converact G03 Probe <sip:g03-probe@${request.local_ip}:${request.local_port}>;tag=${request.from_tag}`,
    `To: ${responseTo}`,
    `Call-ID: ${request.call_id}`,
    'CSeq: 1 ACK',
    'Max-Forwards: 70',
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n');
}

async function runProbe(env: NodeJS.ProcessEnv): Promise<number> {
  const probeId = token(required(env, 'CONVERACT_G03_PROBE_ID'), 'probe ID');
  const targetIp = ipv4(env.CONVERACT_G03_PROBE_TARGET_IP || '172.30.44.10', 'target IP');
  const localIp = ipv4(env.CONVERACT_G03_PROBE_LOCAL_IP || '172.30.44.21', 'local IP');
  const request: BoundedInviteRequest = {
    service: sipUser(env.CONVERACT_G03_PROBE_SERVICE || '+18005550999'),
    target_ip: targetIp,
    target_port: port(env.CONVERACT_G03_PROBE_TARGET_PORT || '5060', 'target port'),
    local_ip: localIp,
    local_port: port(env.CONVERACT_G03_PROBE_LOCAL_PORT || '5060', 'local port'),
    call_id: `${probeId}@${localIp}`,
    branch: `z9hG4bK-${probeId}`,
    from_tag: probeId
  };
  const deadlineMs = integer(
    env.CONVERACT_G03_PROBE_DEADLINE_MS || '10000',
    100,
    30_000,
    'deadline'
  );
  const socket = createSocket('udp4');
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const responses: Array<{
    status: number;
    elapsed_ms: number;
    retry_after_seconds: number | null;
  }> = [];

  const result = await new Promise<{ report: object; exitCode: number }>((finish) => {
    let completed = false;
    const complete = (report: object, exitCode: number): void => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      socket.close(() => finish({ report, exitCode }));
    };
    const deadline = setTimeout(() => complete({
      schema_version: 1,
      probe_id: probeId,
      status: 'timed_out',
      started_at: startedAt,
      deadline_ms: deadlineMs,
      elapsed_ms: elapsedMilliseconds(started),
      responses
    }, 2), deadlineMs);

    socket.on('error', () => complete({
      schema_version: 1,
      probe_id: probeId,
      status: 'socket_error',
      started_at: startedAt,
      deadline_ms: deadlineMs,
      elapsed_ms: elapsedMilliseconds(started),
      responses
    }, 3));
    socket.on('message', (message) => {
      let response: ParsedSipResponse;
      try {
        response = parseSipResponse(message);
      } catch {
        complete({
          schema_version: 1,
          probe_id: probeId,
          status: 'malformed_response',
          started_at: startedAt,
          deadline_ms: deadlineMs,
          elapsed_ms: elapsedMilliseconds(started),
          responses
        }, 3);
        return;
      }
      responses.push(Object.freeze({
        status: response.status,
        elapsed_ms: elapsedMilliseconds(started),
        retry_after_seconds: response.retry_after_seconds
      }));
      if (response.status < 200) return;
      if (response.status < 300) {
        complete({
          schema_version: 1,
          probe_id: probeId,
          status: 'unexpected_success',
          started_at: startedAt,
          deadline_ms: deadlineMs,
          elapsed_ms: elapsedMilliseconds(started),
          responses,
          final_status: response.status
        }, 4);
        return;
      }
      const ack = Buffer.from(renderNon2xxAck(request, response.to));
      socket.send(ack, request.target_port, request.target_ip, (error) => complete({
        schema_version: 1,
        probe_id: probeId,
        status: error ? 'ack_send_error' : 'completed',
        started_at: startedAt,
        deadline_ms: deadlineMs,
        elapsed_ms: elapsedMilliseconds(started),
        responses,
        final_status: response.status,
        final_reason: response.reason,
        retry_after_seconds: response.retry_after_seconds
      }, error ? 3 : 0));
    });
    socket.bind(request.local_port, request.local_ip, () => {
      const invite = Buffer.from(renderBoundedInvite(request));
      socket.send(invite, request.target_port, request.target_ip, (error) => {
        if (error) complete({
          schema_version: 1,
          probe_id: probeId,
          status: 'invite_send_error',
          started_at: startedAt,
          deadline_ms: deadlineMs,
          elapsed_ms: elapsedMilliseconds(started),
          responses
        }, 3);
      });
    });
  });

  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  return result.exitCode;
}

function validateRequest(input: BoundedInviteRequest): Readonly<BoundedInviteRequest> {
  return Object.freeze({
    service: sipUser(input.service),
    target_ip: ipv4(input.target_ip, 'target IP'),
    target_port: port(input.target_port, 'target port'),
    local_ip: ipv4(input.local_ip, 'local IP'),
    local_port: port(input.local_port, 'local port'),
    call_id: boundedWireToken(input.call_id, 'Call-ID'),
    branch: boundedWireToken(input.branch, 'branch'),
    from_tag: boundedWireToken(input.from_tag, 'From tag')
  });
}

function header(lines: string[], name: string): string | null {
  const prefix = `${name.toLowerCase()}:`;
  const found = lines.find((line) => line.toLowerCase().startsWith(prefix));
  return found ? found.slice(found.indexOf(':') + 1).trim() : null;
}

function sipUser(value: string): string {
  if (!SIP_USER.test(value)) throw new Error('probe service is invalid');
  return value;
}

function token(value: string, name: string): string {
  if (!TOKEN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function boundedWireToken(value: string, name: string): string {
  if (!value || value.length > 128 || /[\s\r\n\0]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function ipv4(value: string, name: string): string {
  if (isIP(value) !== 4) throw new Error(`${name} is invalid`);
  return value;
}

function port(value: string | number, name: string): number {
  return integer(value, 1, 65_535, name);
}

function integer(value: string | number, minimum: number, maximum: number, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function elapsedMilliseconds(started: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - started) / 1_000) / 1_000;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runProbe(process.env).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 3; }
  );
}
