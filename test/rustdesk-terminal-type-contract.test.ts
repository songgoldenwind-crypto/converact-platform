import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('RustDesk operation evidence enforces observation invariants under strict TypeScript', () => {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '-p',
      'test/fixtures/tsconfig.rustdesk-terminal-contract.json'
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
