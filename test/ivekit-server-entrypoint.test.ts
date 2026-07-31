import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('iveKit entrypoint starts only the reusable communication runtime', () => {
  const source = readFileSync('src/converact-server.ts', 'utf8');
  assert.match(source, /createIveKitHttpServer/);
  assert.match(source, /startIveKitApplication/);
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

test('package exposes the iveKit production start command', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.['start:ivekit'], 'tsx src/converact-server.ts');
  assert.equal(pkg.scripts?.['start:ivekit:worker'], 'tsx src/converact-worker.ts');
  assert.equal(
    pkg.scripts?.['start:ivekit:realtime-audio-tap'],
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
    pkg.scripts?.['test:ivekit:foundation'],
    'node --import tsx --test test/ivekit-standalone-http.test.ts test/ivekit-media-hooks.test.ts test/ivekit-application.test.ts test/ivekit-server-entrypoint.test.ts test/ivekit-sdk-package.test.ts test/ivekit-voice-controller.test.ts test/ivekit-voice-sdk.test.ts test/ivekit-sip-webphone.test.ts test/livekit-standalone-deployment.test.ts test/ivekit-contact-center-domain.test.ts test/ivekit-contact-center-migration.test.ts test/ivekit-contact-center-configuration.test.ts test/ivekit-contact-center-service.test.ts test/ivekit-contact-center-postgres.test.ts test/ivekit-contact-center-http.test.ts test/ivekit-contact-center-worker.test.ts'
  );
  assert.equal(
    pkg.scripts?.['verify:ivekit:foundation'],
    'npm run test:ivekit:foundation && npm run build:ivekit-sdk && npm run pack:ivekit-sdk'
  );
});

test('standalone iveKit dependency path does not load the SQLite database module', () => {
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
