import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  dialogPeerIdentityFromVerifiedUriSans
} from '../src/agent-runtime/converact/voice/dialog-shadow-server.js';

interface PeerIdentity {
  spiffe_id: string;
  cell_id: string;
  fault_domain: string;
  node_id: string;
}

interface FixtureCase {
  name: string;
  authorized: boolean;
  uri_subject_alt_names: string[];
  expected: 'allowed' | 'rejected';
  identity?: PeerIdentity;
}

interface Fixture {
  trust_domain: string;
  cases: FixtureCase[];
}

const fixture = JSON.parse(readFileSync(
  new URL('../server-rs/tests/fixtures/platform-mtls-peer-v1.json', import.meta.url),
  'utf8'
)) as Fixture;
const dialogShadowServerSource = readFileSync(
  new URL('../src/agent-runtime/converact/voice/dialog-shadow-server.ts', import.meta.url),
  'utf8'
);

test('active TypeScript mTLS peer mapping replays the Rust migration corpus', () => {
  for (const vector of fixture.cases) {
    const actual = dialogPeerIdentityFromVerifiedUriSans({
      authorized: vector.authorized,
      uri_subject_alt_names: vector.uri_subject_alt_names,
      trust_domain: fixture.trust_domain
    });
    assert.equal(actual !== undefined, vector.expected === 'allowed', vector.name);
    if (vector.identity) assert.deepEqual(actual, vector.identity, vector.name);
  }
});

test('active server rejects an unauthorized socket before certificate retrieval', () => {
  const start = dialogShadowServerSource.indexOf('function peerIdentity(');
  const end = dialogShadowServerSource.indexOf(
    'export function dialogPeerIdentityFromVerifiedUriSans',
    start
  );
  const source = dialogShadowServerSource.slice(start, end);
  const rejection = source.indexOf('if (!socket.authorized ||');
  const certificateRead = source.indexOf('socket.getPeerX509Certificate();');
  assert.ok(start >= 0 && end > start, 'peerIdentity source boundary');
  assert.ok(rejection >= 0, 'authorized early-rejection guard');
  assert.ok(certificateRead > rejection, 'certificate read follows authorization guard');
});
