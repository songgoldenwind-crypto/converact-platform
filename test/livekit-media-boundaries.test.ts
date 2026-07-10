import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const repoRoot = new URL('..', import.meta.url).pathname;

test('legacy video start route uses LiveKit media module instead of direct gateway access', () => {
  const source = readFileSync(
    join(repoRoot, 'src/agent-runtime/call-center/analytics/sprint10-http.ts'),
    'utf8'
  );
  assert.match(source, /createLiveKitMediaModule/);
  assert.doesNotMatch(source, /getMediaGatewayRegistry/);
});
