import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packageName(path: string): string {
  return JSON.parse(readFileSync(join(root, path), 'utf8')).name as string;
}

function chartName(path: string): string {
  return YAML.parse(readFileSync(join(root, path), 'utf8')).name as string;
}

test('uses only Converact active package and chart names', () => {
  const expectedPackages = new Map([
    ['package.json', 'converact-platform'],
    ['frontend/package.json', 'converact-console'],
    ['clients/converact-reference/package.json', '@converact/reference-client'],
    ['sdk/converact/package.json', '@converact/sdk'],
    ['services/converact-service/package.json', '@converact/service'],
    ['infra/capacity/package.json', '@converact/capacity-runtime'],
    ['sdk/javascript/package.json', '@converact/javascript-sdk'],
    ['services/agent-panel/package.json', 'converact-agent-panel'],
    ['services/rustdesk-edge-agent/package.json', '@converact/rustdesk-edge-agent'],
  ]);
  const expectedCharts = new Map([
    ['infra/k8s/Chart.yaml', 'converact-platform'],
    ['infra/converact/helm/rtpengine/Chart.yaml', 'converact-rtpengine'],
    ['infra/converact/homer/helm/converact-homer/Chart.yaml', 'converact-homer'],
    ['services/converact-service/helm/converact/Chart.yaml', 'converact-service'],
  ]);

  for (const [path, expected] of expectedPackages) {
    assert.ok(existsSync(join(root, path)), `${path} must exist`);
    assert.equal(packageName(path), expected, path);
  }
  for (const [path, expected] of expectedCharts) {
    assert.ok(existsSync(join(root, path)), `${path} must exist`);
    assert.equal(chartName(path), expected, path);
  }

  const cargoManifest = readFileSync(
    join(root, 'integrations/component-hook-rs/Cargo.toml'),
    'utf8',
  );
  assert.match(cargoManifest, /^name = "converact-component-hook"$/m);
});

test('moves every active Converact Fabric directory and TypeScript entrypoint', () => {
  const legacyDirectories = [
    'clients/ivekit-reference',
    'sdk/ivekit',
    'services/ivekit-service',
    'infra/ivekit',
    'src/agent-runtime/ivekit',
  ];
  const currentDirectories = [
    'clients/converact-reference',
    'sdk/converact',
    'services/converact-service',
    'infra/converact',
    'src/agent-runtime/converact',
  ];

  assert.deepEqual(
    legacyDirectories.filter((path) => existsSync(join(root, path))),
    [],
  );
  assert.deepEqual(
    currentDirectories.filter((path) => !existsSync(join(root, path))),
    [],
  );
  assert.deepEqual(
    readdirSync(join(root, 'src')).filter((path) => /^ivekit-.*\.ts$/i.test(path)),
    [],
  );
  assert.ok(existsSync(join(root, 'src/converact-server.ts')));
  assert.ok(existsSync(join(root, 'src/converact-worker.ts')));
});
