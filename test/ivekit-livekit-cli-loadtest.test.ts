import assert from 'node:assert/strict';
import {
  readFileSync,
  statSync
} from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../infra/converact/livekit-cli/', import.meta.url);

test('LiveKit CLI capacity dependency is versioned and checksum pinned', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('version.json', ROOT), 'utf8')
  ) as Record<string, string>;

  assert.equal(manifest.component, 'livekit-cli');
  assert.equal(manifest.version, '2.18.1');
  assert.equal(manifest.role, 'capacity_load_generator');
  assert.equal(
    manifest.download_url,
    'https://github.com/livekit/livekit-cli/releases/download/v2.18.1/lk_2.18.1_linux_amd64.tar.gz'
  );
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});

test('LiveKit CLI fetch verifies the pinned archive without installing globally', () => {
  const scriptPath = new URL('fetch.sh', ROOT);
  const script = readFileSync(scriptPath, 'utf8');

  assert.match(script, /curl --fail --location --proto '=https' --tlsv1\.2/);
  assert.match(script, /sha256sum --check/);
  assert.match(script, /tar --extract --gzip/);
  assert.doesNotMatch(script, /\/usr\/local|sudo|apt-get/);
  assert.equal(statSync(scriptPath).mode & 0o111, 0o111);
});

test('LiveKit native capacity role does not replace endpoint QoE evidence', () => {
  const documentation = readFileSync(new URL('README.md', ROOT), 'utf8');

  assert.match(documentation, /capacity load generator/i);
  assert.match(documentation, /not\s+part of the runtime service graph/i);
  assert.match(documentation, /glass-to-glass latency/i);
  assert.match(documentation, /separate hosts/i);
  assert.match(documentation, /host exceeds 85% CPU/i);
});
