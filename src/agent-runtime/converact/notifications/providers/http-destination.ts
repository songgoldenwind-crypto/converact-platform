import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

import { NotificationError } from '../errors.js';

export type NotificationAddressResolver = (hostname: string) => Promise<readonly string[]>;
export type NotificationHttpRequest = (
  url: URL,
  init: RequestInit,
  addresses: readonly string[]
) => Promise<Response>;

export type NotificationHttpDestinationResolution =
  | { status: 'safe'; addresses: readonly string[] }
  | { status: 'unsafe' | 'unavailable'; addresses: readonly [] };

const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
] as const) {
  nonPublicIpv6.addSubnet(network, prefix, 'ipv6');
}

export function parseNotificationHttpUrl(value: string, allowHttp = false): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new Error();
    if (url.username || url.password || url.hash || url.search) throw new Error();
    if (!url.hostname || url.pathname.length > 2048 || url.toString().length > 2048) throw new Error();
    return url;
  } catch {
    throw new NotificationError({ code: 'validation_failed', status: 422 });
  }
}

export async function validateNotificationHttpDestination(input: {
  url: URL;
  resolve?: NotificationAddressResolver;
  allow_private_networks?: boolean;
}): Promise<'safe' | 'unsafe' | 'unavailable'> {
  return (await resolveNotificationHttpDestination(input)).status;
}

export async function resolveNotificationHttpDestination(input: {
  url: URL;
  resolve?: NotificationAddressResolver;
  allow_private_networks?: boolean;
}): Promise<NotificationHttpDestinationResolution> {
  const hostname = unbracketHostname(input.url.hostname.toLowerCase());
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (!input.allow_private_networks) return { status: 'unsafe', addresses: [] };
  }
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname)
      ? [hostname]
      : await (input.resolve || resolveNotificationAddresses)(hostname);
  } catch {
    return { status: 'unavailable', addresses: [] };
  }
  if (!addresses.length) return { status: 'unavailable', addresses: [] };
  if (!input.allow_private_networks && addresses.some((address) => !isPublicAddress(address))) {
    return { status: 'unsafe', addresses: [] };
  }
  if (!addresses.every((address) => isIP(address) !== 0)) {
    return { status: 'unsafe', addresses: [] };
  }
  return { status: 'safe', addresses: [...new Set(addresses)] };
}

export async function pinnedNotificationHttpRequest(
  url: URL,
  init: RequestInit,
  addresses: readonly string[]
): Promise<Response> {
  const address = addresses.find((candidate) => isIP(candidate) !== 0);
  if (!address) throw new Error('validated notification destination address is required');
  const hostname = unbracketHostname(url.hostname);
  const headers = new Headers(init.headers);
  headers.set('host', url.host);
  const body = requestBody(init.body);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const response = await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const outgoing = request({
      protocol: url.protocol,
      hostname: address,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      method: init.method || 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal || undefined,
      ...(url.protocol === 'https:' && isIP(hostname) === 0 ? { servername: hostname } : {})
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1_048_576) {
          incoming.destroy(new Error('notification HTTP response exceeds size limit'));
          return;
        }
        chunks.push(buffer);
      });
      incoming.on('error', fail);
      incoming.on('aborted', () => fail(new Error('notification HTTP response aborted')));
      incoming.on('end', () => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        const content = Buffer.concat(chunks);
        resolve(new Response(content.length ? content : null, {
          status: incoming.statusCode || 502,
          statusText: incoming.statusMessage || '',
          headers: responseHeaders
        }));
      });
    });
    outgoing.on('error', fail);
    outgoing.end(body);
  });
  return response;
}

export async function resolveNotificationAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

export function notificationRetryAfterMs(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, 3_600_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.min(timestamp - now.getTime(), 3_600_000));
}

function isPublicAddress(value: string): boolean {
  const version = isIP(value);
  if (version === 4) return isPublicIpv4(value);
  if (version !== 6) return false;
  const address = value.toLowerCase();
  if (address.includes('%')) return false;
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice('::ffff:'.length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  return !nonPublicIpv6.check(address, 'ipv6');
}

function unbracketHostname(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function requestBody(
  value: RequestInit['body'] | null | undefined
): string | Buffer | Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  throw new Error('notification HTTP request body type is unsupported');
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
