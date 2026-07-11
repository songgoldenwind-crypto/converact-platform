import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('iveKit entrypoint starts only the reusable communication runtime', () => {
  const source = readFileSync('src/ivekit-server.ts', 'utf8');
  assert.match(source, /createIveKitHttpServer/);
  assert.match(source, /startIveKitApplication/);
  assert.match(source, /initWebSocket/);
  assert.match(source, /initPostgres/);
  assert.match(source, /closePostgres/);
  assert.match(source, /validateEnvOrExit/);
  assert.doesNotMatch(source, /from ['"]\.\/http\.js/);
  assert.doesNotMatch(source, /call-center|connectNats|migrateIvrRuntimeTables|outbound-dialer/);
  assert.doesNotMatch(source, /createDatabase|node:sqlite/);
  assert.doesNotMatch(source, /shutdown\(\)\.finally\(\(\) => process\.exit\(0\)\)/);
  assert.match(source, /process\.exit\(1\)/);
});

test('package exposes the iveKit production start command', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.['start:ivekit'], 'tsx src/ivekit-server.ts');
  assert.equal(
    pkg.scripts?.['test:ivekit:foundation'],
    'node --import tsx --test test/ivekit-standalone-http.test.ts test/ivekit-media-hooks.test.ts test/ivekit-application.test.ts test/ivekit-server-entrypoint.test.ts test/ivekit-sdk-package.test.ts'
  );
});
