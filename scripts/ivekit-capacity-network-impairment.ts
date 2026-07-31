import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  FencedNetworkImpairmentController,
  buildNetworkImpairmentPlan,
  buildNetworkImpairmentRestoreCommands,
  executeNetworkImpairmentCommand,
  type NetworkImpairmentLease,
  type NetworkImpairmentProfile
} from './capacity/generators/network-impairment.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface NetworkImpairmentRuntimeConfig {
  host: '127.0.0.1' | '::1';
  port: number;
  interface_name: string;
  ifb_interface_name: string;
}

interface NetworkImpairmentControl {
  apply(plan: ReturnType<typeof buildNetworkImpairmentPlan>): Promise<unknown>;
  runBlackout(lease: NetworkImpairmentLease): Promise<unknown>;
  release(lease: NetworkImpairmentLease): Promise<unknown>;
  activeLease(): NetworkImpairmentLease | null;
}

export function networkImpairmentRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): NetworkImpairmentRuntimeConfig {
  const host = env.OPC_IVEKIT_NETWORK_IMPAIRMENT_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('network impairment sidecar must listen on loopback');
  }
  const port = integer(env.OPC_IVEKIT_NETWORK_IMPAIRMENT_PORT || '3199', 0, 65_535, 'port');
  const interfaceName = networkInterface(
    env.OPC_IVEKIT_NETWORK_IMPAIRMENT_INTERFACE || 'eth0',
    'network interface'
  );
  const ifbInterfaceName = networkInterface(
    env.OPC_IVEKIT_NETWORK_IMPAIRMENT_IFB_INTERFACE || 'ifb-ivekit0',
    'IFB interface'
  );
  if (interfaceName === ifbInterfaceName) throw new Error('network and IFB interfaces must differ');
  return {
    host,
    port,
    interface_name: interfaceName,
    ifb_interface_name: ifbInterfaceName
  };
}

export function createNetworkImpairmentHttpServer(input: {
  config: NetworkImpairmentRuntimeConfig;
  controller: NetworkImpairmentControl;
}): Server {
  return createServer(async (request, response) => {
    try {
      await route(request, response, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /stale|another assignment|already active/i.test(message) ? 409
        : /invalid|missing|must|exceeds|differs|JSON/i.test(message) ? 400
          : 500;
      json(response, status, { error: status === 500 ? 'network_impairment_failed' : message });
    }
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  input: { config: NetworkImpairmentRuntimeConfig; controller: NetworkImpairmentControl }
): Promise<void> {
  if (request.method === 'GET' && (request.url === '/healthz' || request.url === '/readyz')) {
    json(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/status') {
    json(response, 200, { active_lease: input.controller.activeLease() });
    return;
  }
  if (request.method !== 'POST') {
    json(response, 404, { error: 'not_found' });
    return;
  }
  const body = await readJson(request);
  if (request.url === '/v1/apply') {
    const lease = requiredObject(body.lease, 'lease') as unknown as NetworkImpairmentLease;
    const profile = requiredObject(body.profile, 'profile') as unknown as NetworkImpairmentProfile;
    const result = await input.controller.apply(buildNetworkImpairmentPlan({
      lease,
      profile,
      interface_name: input.config.interface_name,
      ifb_interface_name: input.config.ifb_interface_name
    }));
    json(response, 200, result);
    return;
  }
  if (request.url === '/v1/blackout') {
    const result = await input.controller.runBlackout(
      requiredObject(body.lease, 'lease') as unknown as NetworkImpairmentLease
    );
    json(response, 200, result);
    return;
  }
  if (request.url === '/v1/release') {
    const result = await input.controller.release(
      requiredObject(body.lease, 'lease') as unknown as NetworkImpairmentLease
    );
    json(response, 200, result);
    return;
  }
  json(response, 404, { error: 'not_found' });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new Error('content-type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('JSON body exceeds 65536 bytes');
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return requiredObject(parsed, 'JSON body');
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store'
  });
  response.end(encoded);
}

function integer(value: string, minimum: number, maximum: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`network impairment ${label} is invalid`);
  }
  return parsed;
}

function networkInterface(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value)) {
    throw new Error(`network impairment ${label} is invalid`);
  }
  return value;
}

async function main(): Promise<void> {
  const config = networkImpairmentRuntimeConfig();
  for (const command of buildNetworkImpairmentRestoreCommands(config)) {
    await executeNetworkImpairmentCommand(command);
  }
  const controller = new FencedNetworkImpairmentController({
    execute: executeNetworkImpairmentCommand
  });
  const server = createNetworkImpairmentHttpServer({ config, controller });
  const shutdown = async () => {
    const active = controller.activeLease();
    if (active) await controller.release(active).catch(() => undefined);
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(config.port, config.host);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
