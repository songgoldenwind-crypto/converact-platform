import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 1024 * 1024;

export function createOwnerAdmissionFixture(input) {
  const serviceKey = requiredSecret(input.serviceKey, 16, 'service key');
  const componentToken = requiredSecret(input.componentToken, 24, 'component token');
  const nodeId = requiredIdentifier(input.nodeId, 'node ID');
  const now = input.now || (() => new Date());
  const owners = new Map();
  let stateSequence = 0;

  return {
    dispatch(request) {
      if (request.method === 'GET' && request.path === '/health') {
        return response(200, { data: { status: 'ok' } });
      }
      if (request.method !== 'POST') return response(404, { error: 'not_found' });
      if (request.path === '/inbound-admission') {
        if (!safeEqual(request.headers['x-pbx-key'], serviceKey)) {
          return response(401, { error: 'unauthorized' });
        }
        const body = plainRecord(request.body);
        if (body.ivekit_owner_node_id !== nodeId) {
          return response(409, { error: 'owner_node_mismatch' });
        }
        const callId = requiredCallId(body.call_id);
        const callDigest = createHash('sha256')
          .update(callId)
          .digest('hex')
          .slice(0, 32);
        const reservationId = `reservation-${callDigest}`;
        const interactionId = `vcall-${callDigest}`;
        const owner = {
          reservation_id: reservationId,
          interaction_id: interactionId,
          owner_epoch: '4294967297'
        };
        owners.set(reservationId, owner);
        return response(200, {
          data: {
            accepted: true,
            call_id: interactionId,
            provider_call_id: callId,
            reservation_id: reservationId,
            owner_epoch: owner.owner_epoch
          }
        });
      }
      if (request.path === '/v1/authorize') {
        if (!safeEqual(request.headers.authorization, `Bearer ${componentToken}`)) {
          return response(401, { error: 'unauthorized' });
        }
        const body = plainRecord(request.body);
        const owner = owners.get(String(body.reservation_id || ''));
        if (!owner
          || body.interaction_id !== owner.interaction_id
          || body.owner_epoch !== owner.owner_epoch
          || !['open', 'mutate', 'close'].includes(String(body.operation || ''))) {
          return response(409, { error: 'owner_contract_mismatch' });
        }
        stateSequence += 1;
        const observedAt = now();
        if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
          return response(500, { error: 'invalid_clock' });
        }
        const result = response(200, {
          data: {
            allowed: true,
            component: 'rustpbx',
            node_id: nodeId,
            cell_lease_epoch: 1,
            owner_epoch: owner.owner_epoch,
            state_sequence: stateSequence,
            lease_expires_at: new Date(observedAt.getTime() + 30_000).toISOString()
          }
        });
        if (body.operation === 'close') owners.delete(owner.reservation_id);
        return result;
      }
      if (request.path === '/cdr') {
        if (!safeEqual(request.headers['x-pbx-key'], serviceKey)) {
          return response(401, { error: 'unauthorized' });
        }
        return response(200, { data: { accepted: true } });
      }
      return response(404, { error: 'not_found' });
    }
  };
}

function response(status, body) {
  return { status, body };
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredSecret(value, minimum, label) {
  const normalized = String(value || '');
  if (normalized.length < minimum
    || normalized.length > 512
    || [...normalized].some((character) => character <= '\u001f' || character === '\u007f')) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requiredIdentifier(value, label) {
  const normalized = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requiredCallId(value) {
  const normalized = String(value || '');
  if (!normalized
    || Buffer.byteLength(normalized) > 255
    || /[\u0000-\u0020\u007f-\uffff]/u.test(normalized)) {
    throw new Error('SIP Call-ID is invalid');
  }
  return normalized;
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body is invalid');
  }
  return value;
}

async function startServer() {
  const fixture = createOwnerAdmissionFixture({
    serviceKey: process.env.RUSTPBX_WEBHOOK_TOKEN,
    componentToken: process.env.CONVERACT_FABRIC_RUSTPBX_COMPONENT_NODE_TOKEN,
    nodeId: process.env.CONVERACT_FABRIC_RUSTPBX_OWNER_NODE_ID
  });
  const port = Number(process.env.CONVERACT_FABRIC_RUSTPBX_OWNER_FIXTURE_PORT || 3210);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('fixture port is invalid');
  }
  const server = createServer(async (request, reply) => {
    try {
      const body = await readJsonBody(request);
      const result = fixture.dispatch({
        method: request.method || '',
        path: new URL(request.url || '/', 'http://127.0.0.1').pathname,
        headers: {
          authorization: request.headers.authorization || '',
          'x-pbx-key': request.headers['x-pbx-key'] || ''
        },
        body
      });
      reply.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      reply.end(`${JSON.stringify(result.body)}\n`);
    } catch {
      reply.writeHead(400, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      reply.end('{"error":"invalid_request"}\n');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function readJsonBody(request) {
  if (request.method === 'GET') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds limit');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isMainModule() {
  return Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  startServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'fixture failed'}\n`);
    process.exitCode = 1;
  });
}
