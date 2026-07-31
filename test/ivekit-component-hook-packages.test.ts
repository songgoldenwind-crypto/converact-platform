import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Go and Rust component hooks enforce local hot-path epoch checks', () => {
  const goHook = readFileSync(
    'integrations/component-hook-go/hook.go',
    'utf8'
  );
  const rustHook = readFileSync(
    'integrations/component-hook-rs/src/lib.rs',
    'utf8'
  );
  const livekitOwner = readFileSync(
    'integrations/livekit-v1.13.4/registry.go',
    'utf8'
  );
  const livekitOverlay = readFileSync(
    'infra/ivekit/livekit/apply-overlay.mjs',
    'utf8'
  );
  const tinodeOwner = readFileSync(
    'integrations/tinode-v0.25.3/registry.go',
    'utf8'
  );
  const tinodeOverlay = readFileSync(
    'infra/ivekit/tinode/apply-overlay.mjs',
    'utf8'
  );
  const rustdeskServerHook = readFileSync(
    'infra/ivekit/rustdesk-server/server-hook.rs',
    'utf8'
  );
  const rustdeskServerOverlay = readFileSync(
    'infra/ivekit/rustdesk-server/apply-overlay.mjs',
    'utf8'
  );
  const workflow = readFileSync(
    '.github/workflows/ivekit-component-hooks-ci.yml',
    'utf8'
  );

  assert.match(goHook, /func \(guard \*Guard\) AssertMutation/);
  assert.match(goHook, /atomic\.Pointer\[cachedState\]/);
  assert.doesNotMatch(goHook, /http\./);
  assert.match(rustHook, /pub fn assert_mutation/);
  assert.match(rustHook, /RwLock<Option<CachedState>>/);
  assert.doesNotMatch(rustHook, /reqwest|tokio|hyper/);
  assert.match(livekitOwner, /func \(registry \*Registry\) OpenOrAssert/);
  assert.match(livekitOwner, /start \+= 64/);
  assert.match(livekitOwner, /entry\.guard\.AssertCurrent/);
  assert.doesNotMatch(livekitOwner, /RTP|RTCP|PacketRouter/);
  assert.match(
    livekitOverlay,
    /0b3fd288e3ef3263ec475ba0d78cf3ad77459981/
  );
  assert.match(livekitOverlay, /currentNode\.SetNodeID/);
  assert.match(tinodeOwner, /func \(registry \*Registry\) OpenOrAssert/);
  assert.match(tinodeOwner, /start \+= 64/);
  assert.match(tinodeOwner, /entry\.guard\.AssertCurrent/);
  assert.match(
    tinodeOverlay,
    /22a7c18e9cd695e9a061bf1b8c84175196ef5a15/
  );
  assert.match(tinodeOverlay, /ivekitUseStableClusterNodeID/);
  assert.match(
    rustdeskServerOverlay,
    /73523b31cfd25d77dee862e6fc9f5e1fb5e485ef/
  );
  assert.match(rustdeskServerOverlay, /claim_relay/);
  assert.match(rustdeskServerOverlay, /assert_relay/);
  assert.match(rustdeskServerHook, /Guard::new/);
  assert.doesNotMatch(rustdeskServerHook, /send_raw|peer\.recv|stream\.recv/);
  assert.match(workflow, /go test \.\/\.\.\./);
  assert.match(workflow, /integrations\/livekit-v1\.13\.4/);
  assert.match(workflow, /integrations\/tinode-v0\.25\.3/);
  assert.match(workflow, /rustdesk-owner-boundary/);
  assert.match(workflow, /cargo test --locked/);
});

test('component hook docs prohibit remote calls in media and fanout loops', () => {
  const goReadme = readFileSync(
    'integrations/component-hook-go/README.md',
    'utf8'
  );
  const rustReadme = readFileSync(
    'integrations/component-hook-rs/README.md',
    'utf8'
  );
  const livekitReadme = readFileSync(
    'integrations/livekit-v1.13.4/README.md',
    'utf8'
  );
  const tinodeReadme = readFileSync(
    'integrations/tinode-v0.25.3/README.md',
    'utf8'
  );

  assert.match(goReadme, /never performs HTTP or database work/);
  assert.match(goReadme, /RTP packet routing/);
  assert.match(goReadme, /Tinode fanout/);
  assert.match(rustReadme, /only reads the in-process cache/);
  assert.match(rustReadme, /RustDesk frame relay/);
  assert.match(rustReadme, /RTP packet/);
  assert.match(livekitReadme, /RTP, RTCP, WebRTC forwarding/);
  assert.match(livekitReadme, /bounded batches of 64 rooms/);
  assert.match(tinodeReadme, /batches of 64 topics/);
  assert.match(tinodeReadme, /never call HTTP/);
});
