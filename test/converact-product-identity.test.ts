import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const legacyName = /(?<![A-Za-z0-9])(?:opc|ivekit)(?![A-Za-z0-9])/i;
const legacyActiveFileName = /(?:OPC|IveKit|(?<![Ll])iveKit)|(?<![A-Za-z0-9])(?:opc|ivekit)(?![A-Za-z0-9])/;

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

test('active script and test filenames use Converact identity', () => {
  const files = execFileSync('git', ['ls-files', '-z', 'scripts', 'test'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  const legacy = files.filter((path) => legacyActiveFileName.test(basename(path)));
  assert.deepEqual(legacy, []);
});

test('product-facing applications present the Converact product family', () => {
  assert.match(source('frontend/index.html'), /<title>Converact Console<\/title>/);
  assert.match(source('services/agent-panel/index.html'), /<title>Converact Engage<\/title>/);
  assert.match(
    source('clients/converact-reference/index.html'),
    /<title>Converact Fabric Workspace<\/title>/,
  );
  assert.match(source('docs/openapi.yaml'), /title: Converact Platform API/);
  assert.match(
    source('docs/api/converact-media-control-v1.openapi.yaml'),
    /title: Converact Fabric Internal Voice Media Control API/,
  );
});

test('active runtime entrypoints no longer present OPC or iveKit as products', () => {
  for (const path of [
    'src/server.ts',
    'src/converact-server.ts',
    'src/converact-worker.ts',
    'src/converact-migrate.ts',
    'src/converact-init-runtime-role.ts',
    'src/converact-realtime-audio-tap-worker.ts',
  ]) {
    const activePresentation = source(path).replaceAll('ivekit_schema_migrations', 'stable_schema_lock');
    assert.doesNotMatch(activePresentation, legacyName, path);
  }
  assert.doesNotMatch(
    JSON.parse(source('sdk/converact/package.json')).description,
    legacyName,
  );
});

test('Converact source symbols are authoritative while published SDK names remain aliases', () => {
  const server = source('src/server.ts');
  assert.match(server, /startConveractFabricApplication/);
  assert.match(server, /ConveractFabricTenantEventStore/);

  const sdkIndex = source('sdk/converact/src/index.ts');
  assert.match(sdkIndex, /createConveractFabricClient/);
  assert.match(sdkIndex, /interface ConveractFabricClient/);
  assert.match(sdkIndex, /legacy-fabric-v1-aliases\.js/);

  const legacyAliases = source('sdk/converact/src/legacy-fabric-v1-aliases.ts');
  assert.match(legacyAliases, /@deprecated Use createConveractFabricClient/);
  assert.match(legacyAliases, /createConveractFabricClient as createIveKitClient/);

  const javascriptSdk = source('sdk/javascript/src/index.ts');
  assert.match(javascriptSdk, /class ConveractClient/);
  assert.match(javascriptSdk, /@deprecated Use ConveractClient/);
  assert.match(javascriptSdk, /ConveractClient as OPCClient/);

  const pythonSdk = source('sdk/python/converact_client/client.py');
  assert.match(pythonSdk, /class ConveractClient/);
  const pythonLegacyShim = source('sdk/python/opc_client/client.py');
  assert.match(pythonLegacyShim, /Remove with Converact Python SDK 1\.0\.0/);
  assert.match(pythonLegacyShim, /OpcClient = ConveractClient/);
});
