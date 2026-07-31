import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('root regression declares packages imported directly by root tests', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    devDependencies?: Record<string, string>;
  };

  assert.equal(packageJson.devDependencies?.['sip.js'], '^0.21.2');
  assert.equal(packageJson.devDependencies?.yaml, '^2.4.2');
});
