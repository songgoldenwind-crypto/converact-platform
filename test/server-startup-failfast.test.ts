import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('server exits when PostgreSQL startup fails', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://opc:invalid@127.0.0.1:1/opc'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });

  const result = await new Promise<
    { exited: true; code: number | null } | { exited: false; code: null }
  >((resolve) => {
    const timer = setTimeout(() => resolve({ exited: false, code: null }), 7_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code });
    });
  });
  if (!result.exited) child.kill('SIGKILL');

  assert.equal(result.exited, true, output);
  assert.equal(result.code, 1, output);
  assert.match(output, /startup.*FATAL/i);
});
