import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';

const port = Number(process.env.PORT || 4318);
const countFile = '/evidence/count';

async function count() {
  try {
    return Number(await readFile(countFile, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

async function increment() {
  const next = await count() + 1;
  const temporary = `${countFile}.${process.pid}`;
  await writeFile(temporary, String(next));
  await rename(temporary, countFile);
  return next;
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/traces') {
    response.writeHead(404);
    response.end();
    return;
  }
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2 * 1024 * 1024) {
      response.writeHead(413);
      response.end();
      return;
    }
  }
  const deliveryCount = await increment();
  process.stdout.write(`${JSON.stringify({ event: 'trace_delivery', bytes, delivery_count: deliveryCount })}\n`);
  response.writeHead(200, { 'content-type': 'application/x-protobuf' });
  response.end();
});

server.listen(port, '0.0.0.0');
