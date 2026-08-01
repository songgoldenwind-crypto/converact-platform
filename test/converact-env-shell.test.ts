import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = resolve(root, 'scripts/converact-env-compat.sh');

function run(script: string, env: Record<string, string> = {}): string {
  return execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', `source "$1"; ${script}`, 'bash', helper], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
}

test('shell resolver accepts current, legacy, equal, and empty values', () => {
  assert.equal(
    run('converact_env_resolve_brand API_KEY; printf %s "$CONVERACT_API_KEY"', {
      CONVERACT_API_KEY: 'new',
    }),
    'new',
  );
  assert.equal(
    run('converact_env_resolve_brand API_KEY; printf %s "$CONVERACT_API_KEY"', {
      OPC_API_KEY: 'old',
    }),
    'old',
  );
  assert.equal(
    run('converact_env_resolve_brand API_KEY; printf %s "$CONVERACT_API_KEY"', {
      CONVERACT_API_KEY: 'same',
      OPC_API_KEY: 'same',
    }),
    'same',
  );
  assert.equal(
    run('converact_env_resolve_brand API_KEY; printf %s "$CONVERACT_API_KEY"', {
      CONVERACT_API_KEY: '',
    }),
    '',
  );
});

test('shell resolver rejects conflicts without exposing values', () => {
  const result = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', 'source "$1"; converact_env_resolve_brand API_KEY', 'bash', helper],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        CONVERACT_API_KEY: 'current-secret',
        OPC_API_KEY: 'legacy-secret',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicting branded environment variables/);
  assert.match(result.stderr, /CONVERACT_API_KEY/);
  assert.match(result.stderr, /OPC_API_KEY/);
  assert.doesNotMatch(result.stderr, /current-secret|legacy-secret/);
});

test('shell installer maps Fabric aliases and emits only key metadata', () => {
  const result = spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; converact_env_install_aliases; printf %s "$CONVERACT_FABRIC_INSTANCE_ID"',
      'bash',
      helper,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OPC_IVEKIT_INSTANCE_ID: 'legacy-instance',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'legacy-instance');
  assert.match(result.stderr, /converact\.config\.deprecated_environment_key/);
  assert.match(result.stderr, /CONVERACT_FABRIC_INSTANCE_ID/);
  assert.doesNotMatch(result.stderr, /legacy-instance/);
});

test('shell installer maps the direct legacy Fabric alias', () => {
  const result = spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; converact_env_install_aliases; printf %s "$CONVERACT_FABRIC_INSTANCE_ID"',
      'bash',
      helper,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        IVEKIT_INSTANCE_ID: 'direct-legacy-instance',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'direct-legacy-instance');
  assert.match(result.stderr, /converact\.config\.deprecated_environment_key/);
  assert.match(result.stderr, /IVEKIT_INSTANCE_ID/);
  assert.doesNotMatch(result.stderr, /direct-legacy-instance/);
});

test('shell Fabric resolver rejects conflicts across both legacy aliases', () => {
  const result = spawnSync(
    '/bin/bash',
    ['-c', 'source "$1"; converact_env_resolve_fabric API_KEY', 'bash', helper],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OPC_IVEKIT_API_KEY: 'first-secret',
        IVEKIT_API_KEY: 'second-secret',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicting branded environment variables/);
  assert.match(result.stderr, /CONVERACT_FABRIC_API_KEY/);
  assert.match(result.stderr, /IVEKIT_API_KEY/);
  assert.doesNotMatch(result.stderr, /first-secret|second-secret/);
});

test('shell compatibility helper also runs under POSIX sh', () => {
  const output = execFileSync(
    '/bin/sh',
    ['-c', '. "$1"; converact_env_install_aliases; printf %s "$CONVERACT_API_KEY"', 'sh', helper],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', OPC_API_KEY: 'legacy' },
      encoding: 'utf8',
    },
  );
  assert.equal(output, 'legacy');
});
