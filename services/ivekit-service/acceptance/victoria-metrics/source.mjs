import { createServer } from 'node:http';

let counter = 1;
setInterval(() => {
  counter += 1;
}, 250);

createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (request.url === '/value') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify({ value: counter })}\n`);
    return;
  }
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    response.end(
      '# HELP opc_vm_acceptance_counter Controlled acceptance counter.\n' +
      '# TYPE opc_vm_acceptance_counter counter\n' +
      `opc_vm_acceptance_counter ${counter}\n`
    );
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(9100, '0.0.0.0');
