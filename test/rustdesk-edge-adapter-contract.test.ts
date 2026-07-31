import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const adapters = new URL('../scripts/rustdesk-edge-adapters/', import.meta.url);
const shellAdapters = [
  'linux-disconnect.sh',
  'linux-restart.sh',
  'macos-disconnect.sh',
  'macos-restart.sh'
];
const powershellAdapters = ['windows-disconnect.ps1', 'windows-restart.ps1'];

test('platform adapters are strict argument-based wrappers without eval or command strings', () => {
  for (const filename of [...shellAdapters, ...powershellAdapters]) {
    const source = readFileSync(new URL(filename, adapters), 'utf8');
    assert.doesNotMatch(source, /\beval\b|Invoke-Expression|cmd\.exe|sh\s+-c|bash\s+-c/i, filename);
    assert.match(source, /external[-_]?id/i, filename);
    assert.match(source, /target[-_]?id/i, filename);
    assert.match(source, /rustdesk[-_]?id/i, filename);
    assert.match(source, /validate/i, filename);
  }
});

test('linux targeted disconnect validates safely and reports unavailable without a local hook', () => {
  const script = fileURLToPath(new URL('linux-disconnect.sh', adapters));
  chmodSync(script, 0o755);
  const validation = spawnSync(script, [
    '--mode', 'validate',
    '--external-id', 'gateway-1',
    '--target-id', 'device-1',
    '--rustdesk-id', '123456789',
    '--reason', 'gateway_ended'
  ], { encoding: 'utf8', env: cleanAdapterEnv() });
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /"available":false/);
  assert.match(validation.stdout, /"mode":"validate"/);

  const execution = spawnSync(script, [
    '--mode', 'execute',
    '--external-id', 'gateway-1',
    '--target-id', 'device-1',
    '--rustdesk-id', '123456789',
    '--reason', 'gateway_ended'
  ], { encoding: 'utf8', env: cleanAdapterEnv() });
  assert.equal(execution.status, 20);
  assert.match(execution.stderr, /session-specific disconnect hook is not configured/);
});

test('linux targeted disconnect passes identifiers as fixed argv and is idempotent', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-adapter-'));
  const capture = join(dataDir, 'args.txt');
  const hook = join(dataDir, 'hook.sh');
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capture)}\nexit 0\n`);
  chmodSync(hook, 0o755);
  const script = fileURLToPath(new URL('linux-disconnect.sh', adapters));
  const args = [
    '--mode', 'execute', '--external-id', 'gateway-1', '--target-id', 'device-1',
    '--rustdesk-id', '123456789', '--reason', 'gateway_ended'
  ];
  const env = { ...cleanAdapterEnv(), CONVERACT_RUSTDESK_SESSION_DISCONNECT_HOOK: hook };
  assert.equal(spawnSync(script, args, { encoding: 'utf8', env }).status, 0);
  assert.equal(spawnSync(script, args, { encoding: 'utf8', env }).status, 0);
  assert.deepEqual(readFileSync(capture, 'utf8').trim().split('\n'), [
    '--external-id', 'gateway-1', '--target-id', 'device-1',
    '--rustdesk-id', '123456789', '--reason', 'gateway_ended'
  ]);

  const rejected = spawnSync(script, [
    '--mode', 'execute', '--external-id', 'gateway;shutdown', '--target-id', 'device-1',
    '--rustdesk-id', '123456789', '--reason', 'gateway_ended'
  ], { encoding: 'utf8', env });
  assert.equal(rejected.status, 64);
  assert.equal(readFileSync(capture, 'utf8').includes('shutdown'), false);
});

test('linux restart validate mode never invokes the service manager', () => {
  const script = fileURLToPath(new URL('linux-restart.sh', adapters));
  chmodSync(script, 0o755);
  const result = spawnSync(script, [
    '--mode', 'validate',
    '--external-id', 'gateway-1',
    '--target-id', 'device-1',
    '--rustdesk-id', '123456789',
    '--reason', 'gateway_ended'
  ], {
    encoding: 'utf8',
    env: { ...cleanAdapterEnv(), CONVERACT_RUSTDESK_SERVICE_NAME: 'rustdesk-test.service' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"mode":"validate"/);
  assert.match(result.stdout, /"collateral_sessions_may_disconnect":true/);

  const execution = spawnSync(script, [
    '--mode', 'execute', '--external-id', 'gateway-1', '--target-id', 'device-1',
    '--rustdesk-id', '123456789', '--reason', 'gateway_ended'
  ], {
    encoding: 'utf8',
    env: { ...cleanAdapterEnv(), CONVERACT_RUSTDESK_SERVICE_NAME: 'opc-definitely-missing-rustdesk.service' }
  });
  assert.equal(execution.status, 21);
  assert.match(execution.stderr, /systemd service is unavailable/);
});

function cleanAdapterEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CONVERACT_RUSTDESK_SESSION_DISCONNECT_HOOK;
  return env;
}
