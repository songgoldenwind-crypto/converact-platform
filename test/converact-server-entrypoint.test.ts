import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Converact Fabric entrypoint starts only the reusable communication runtime', () => {
  const source = readFileSync('src/converact-server.ts', 'utf8');
  assert.match(source, /createConveractFabricHttpServer/);
  assert.match(source, /startConveractFabricApplication/);
  assert.match(source, /initWebSocket/);
  assert.match(source, /initPostgres/);
  assert.match(source, /closePostgres/);
  assert.match(source, /validateEnvOrExit/);
  assert.match(source, /createConfiguredWebPhoneExtensionSessionService/);
  assert.match(source, /extension_sessions: webphoneSessions/);
  assert.doesNotMatch(source, /from ['"]\.\/http\.js/);
  assert.doesNotMatch(source, /call-center|connectNats|migrateIvrRuntimeTables|outbound-dialer/);
  assert.doesNotMatch(source, /createDatabase|node:sqlite/);
  assert.doesNotMatch(source, /shutdown\(\)\.finally\(\(\) => process\.exit\(0\)\)/);
  assert.match(source, /process\.exit\(1\)/);
});

test('package exposes the Converact Fabric production start command', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.['start:converact'], 'tsx src/converact-server.ts');
  assert.equal(pkg.scripts?.['start:converact:worker'], 'tsx src/converact-worker.ts');
  assert.equal(
    pkg.scripts?.['start:converact:realtime-audio-tap'],
    'tsx src/converact-realtime-audio-tap-worker.ts'
  );
  const servicePackage = JSON.parse(
    readFileSync('services/converact-service/package.json', 'utf8')
  ) as { scripts?: Record<string, string> };
  assert.equal(
    servicePackage.scripts?.['start:realtime-audio-tap'],
    'node dist/converact-realtime-audio-tap-worker.js'
  );
  assert.equal(
    pkg.scripts?.['test:converact:foundation'],
    'node --import tsx --test test/converact-standalone-http.test.ts test/converact-media-hooks.test.ts test/converact-application.test.ts test/converact-server-entrypoint.test.ts test/converact-sdk-package.test.ts test/converact-voice-controller.test.ts test/converact-voice-sdk.test.ts test/converact-sip-webphone.test.ts test/livekit-standalone-deployment.test.ts test/converact-contact-center-domain.test.ts test/converact-contact-center-migration.test.ts test/converact-contact-center-configuration.test.ts test/converact-contact-center-service.test.ts test/converact-contact-center-postgres.test.ts test/converact-contact-center-http.test.ts test/converact-contact-center-worker.test.ts'
  );
  assert.equal(
    pkg.scripts?.['verify:converact:foundation'],
    'npm run test:converact:foundation && npm run build:converact-sdk && npm run pack:converact-sdk'
  );
});

test('standalone Converact Fabric dependency path does not load the SQLite database module', () => {
  const compatibilitySource = readFileSync('src/db-compat.ts', 'utf8');
  assert.doesNotMatch(compatibilitySource, /node:sqlite|createDatabase|call-center/);

  for (const filename of [
    'src/agent-runtime/converact/media-hooks.ts',
    'src/agent-runtime/livekit/webhook-handler.ts',
    'src/agent-runtime/livekit/recording-service.ts',
    'src/agent-runtime/livekit/room-store.ts',
    'src/agent-runtime/livekit/participant-store.ts'
  ]) {
    const source = readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /from ['"].*\/db\.js['"]/, `${filename} loads the SQLite database module`);
    assert.match(source, /from ['"].*\/db-compat\.js['"]/);
  }

  for (const filename of ['src/redis-pubsub.ts', 'src/redis-session-cache.ts']) {
    const source = readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /agent-runtime\/call-center/);
    assert.match(source, /\.\/redis-client\.js/);
  }

  const imported = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./src/agent-runtime/converact/http-server.ts')"],
    { encoding: 'utf8' }
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.doesNotMatch(imported.stderr, /SQLite is an experimental feature|node:sqlite/);
});
