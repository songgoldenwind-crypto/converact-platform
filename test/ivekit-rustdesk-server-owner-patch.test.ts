import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyPinnedPatch,
  patchCargoToml,
  patchCargoLock,
  patchLibraryRoot,
  patchRelayBinary,
  patchRelayServer,
  patchRendezvousServer,
  RUSTDESK_SERVER_UPSTREAM_COMMIT,
  RUSTDESK_SERVER_UPSTREAM_TAG,
  RUSTDESK_SERVER_HBB_COMMON_COMMIT
} from '../infra/ivekit/rustdesk-server/apply-overlay.mjs';

test('RustDesk Server owner overlay is exact-release bound', () => {
  assert.equal(RUSTDESK_SERVER_UPSTREAM_TAG, '1.1.16');
  assert.equal(
    RUSTDESK_SERVER_UPSTREAM_COMMIT,
    '73523b31cfd25d77dee862e6fc9f5e1fb5e485ef'
  );
  assert.equal(
    RUSTDESK_SERVER_HBB_COMMON_COMMIT,
    '83419b6549636ee39dacef7776c473f5802e08d6'
  );
});

test('RustDesk Server hbbs claims the relay UUID before forwarding it', () => {
  const patched = patchRendezvousServer(rendezvousFixture());
  assert.match(patched, /ivekit_owner::claim_relay\(&rf\.id, &rf\.uuid\)\.await/);
  assert.ok(
    patched.indexOf('ivekit_owner::claim_relay') <
      patched.indexOf('self.pm.get_in_memory(&rf.id).await')
  );
  assert.equal(patchRendezvousServer(patched), patched);
});

test('RustDesk Server hbbr fences setup and leaves relay frame copy untouched', () => {
  const patched = patchRelayServer(relayFixture());
  assert.match(patched, /start_relay_owner_refresh/);
  assert.match(patched, /open_or_assert_relay\(&rf\.uuid\)\.await/);
  assert.match(patched, /close_relay\(&rf\.uuid\)\.await/);
  assert.match(patched, /assert_relay\(&owner_relay_uuid\)/);
  assert.match(patched, /if PEERS\.lock\(\)\.await\.remove\(&rf\.uuid\)\.is_some\(\)/);
  assert.match(
    patched,
    /relay\(addr, &mut stream, peer, limiter, id\.clone\(\), rf\.uuid\.clone\(\)\)/
  );
  assert.doesNotMatch(
    patched.slice(patched.indexOf('async fn relay(')),
    /post_json|minreq|spawn_blocking|component_node|binding/
  );
  assert.equal(patchRelayServer(patched), patched);
});

test('RustDesk Server overlay wires only local hook modules', () => {
  assert.match(patchCargoToml(cargoFixture()), /ivekit-component-hook = \{ path = "ivekit\/component-hook-rs" \}/);
  const lock = patchCargoLock(cargoLockFixture());
  assert.match(lock, /name = "ivekit-component-hook"\nversion = "0\.1\.0"/);
  assert.match(lock, /"ivekit-component-hook",/);
  assert.equal(patchCargoLock(lock), lock);
  assert.match(patchLibraryRoot('pub mod common;\n'), /^pub mod ivekit_owner;/);
  assert.match(patchRelayBinary('mod common;\nmod relay_server;\n'), /mod ivekit_owner;/);
});

test('RustDesk Server pinned source patch is idempotent', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'ivekit-rustdesk-server-patch-'));
  const patchPath = join(sourceRoot, 'change.patch');
  try {
    execFileSync('git', ['init', '--quiet', sourceRoot]);
    writeFileSync(join(sourceRoot, 'sample.txt'), 'before\n');
    writeFileSync(
      patchPath,
      [
        'diff --git a/sample.txt b/sample.txt',
        '--- a/sample.txt',
        '+++ b/sample.txt',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        ''
      ].join('\n')
    );

    assert.equal(applyPinnedPatch(sourceRoot, patchPath), 'applied');
    assert.equal(applyPinnedPatch(sourceRoot, patchPath), 'already_applied');
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('RustDesk Server relay hot path avoids global usage writes and same-protocol frame copies', () => {
  const source = readFileSync(
    'infra/ivekit/rustdesk-server/patches/rustdesk-server-ivekit-relay-hot-path.patch',
    'utf8'
  );
  const added = source
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  assert.match(source, /struct UsageCounters/);
  assert.match(source, /usage\.update\(elapsed, total, highest_s, speed\)/);
  assert.match(source, /enum RelayFrame/);
  assert.match(source, /RelayFrame::WebSocket\(bytes\)/);
  assert.match(source, /bytes\.freeze\(\)/);
  assert.doesNotMatch(added, /USAGE\.write\(\)\.await\.insert\(\s*id\.clone\(\),\s*\(/);
  assert.doesNotMatch(added, /bytes\[\.\.\]\.into\(\)/);
});

test('RustDesk Server relay benchmark is reproducible and explicitly operation scoped', () => {
  const source = readFileSync(
    'infra/ivekit/rustdesk-server/bench/relay-hot-path.rs',
    'utf8'
  );
  const runner = readFileSync(
    'infra/ivekit/rustdesk-server/bench/run.sh',
    'utf8'
  );
  assert.match(source, /scope=operation_only/);
  assert.match(source, /usage_global_map_lower_bound/);
  assert.match(source, /frame_websocket_64k_owned/);
  assert.match(runner, /rustc --edition 2021 -C opt-level=3/);
});

test('RustDesk Server hook declares bounded setup-only owner behavior', () => {
  const hook = readFileSync('infra/ivekit/rustdesk-server/server-hook.rs', 'utf8');
  const readme = readFileSync('infra/ivekit/rustdesk-server/README.md', 'utf8');
  const build = readFileSync('infra/ivekit/rustdesk-server/build.sh', 'utf8');
  const dockerfile = readFileSync('infra/ivekit/rustdesk-server/Dockerfile', 'utf8');
  const dockerignore = readFileSync(
    'infra/ivekit/rustdesk-server/Dockerfile.dockerignore',
    'utf8'
  );
  assert.match(hook, /\/v1\/bindings\/claim/);
  assert.match(hook, /\/v1\/relays\/resolve/);
  assert.match(hook, /Guard::new/);
  assert.doesNotMatch(hook, /send_raw|peer\.recv|stream\.recv/);
  assert.match(readme, /relay byte-copy loop does not call HTTP/);
  assert.match(readme, /remain\s+`not_run`/);
  assert.match(build, /submodule update --init --recursive/);
  assert.match(build, /--file "\$SCRIPT_DIR\/Dockerfile"/);
  assert.match(build, /org\.opencontainers\.image\.revision=73523b31/);
  assert.match(build, /io\.ivekit\.owner-contract=component-node-v1/);
  assert.match(dockerfile, /FROM rust:1\.94-bookworm@sha256:[0-9a-f]{64} AS builder/);
  assert.match(dockerfile, /cargo test --locked --all-features/);
  assert.match(dockerfile, /cargo build --locked --release --all-features/);
  assert.match(dockerfile, /COPY --from=builder \/source\/target\/release\/hbbs \/usr\/local\/bin\/hbbs/);
  assert.match(dockerfile, /COPY --from=builder \/source\/target\/release\/hbbr \/usr\/local\/bin\/hbbr/);
  assert.match(dockerfile, /groupadd --system --gid 10001 rustdesk/);
  assert.match(dockerfile, /useradd --system --uid 10001 --gid 10001/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerignore, /^target$/m);
  assert.match(dockerignore, /^\.git$/m);
});

test('RustDesk Server 1.1.16 image workflow binds exact source and shared OCI gate', () => {
  const workflow = readFileSync(
    '.github/workflows/ivekit-rustdesk-server-image.yml',
    'utf8'
  );
  assert.match(workflow, /RUSTDESK_SERVER_UPSTREAM_TAG: 1\.1\.16/);
  assert.match(workflow, /RUSTDESK_SERVER_UPSTREAM_COMMIT: 73523b31cfd25d77dee862e6fc9f5e1fb5e485ef/);
  assert.match(workflow, /RUSTDESK_SERVER_HBB_COMMON_COMMIT: 83419b6549636ee39dacef7776c473f5802e08d6/);
  assert.match(workflow, /submodule update --init --recursive/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(workflow, /image: ghcr\.io\/songgoldenwind-crypto\/opc-rustdesk-server/);
  assert.match(workflow, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);
  const actions = [...workflow.matchAll(/uses:\s+([^@\s]+)@([^\s]+)/g)];
  assert.ok(actions.length >= 1);
  for (const [, action, revision] of actions) {
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} is not commit-pinned`);
  }
});

test('RustDesk Server hook is a no-op when iveKit ownership is not configured', () => {
  const hook = readFileSync('infra/ivekit/rustdesk-server/server-hook.rs', 'utf8');
  assert.match(hook, /let enabled = required \|\| configuration\.iter\(\)\.any/);
  assert.match(hook, /if enabled && configuration\.iter\(\)\.any/);
  assert.ok(
    [...hook.matchAll(/if !registry\.enabled \{\s+return Ok\(\(\)\);\s+\}/g)].length >= 4
  );
  assert.match(
    hook,
    /pub async fn close_relay[\s\S]*?if !registry\.enabled \{\s+return;\s+\}/
  );
});

function cargoFixture(): string {
  return [
    '[dependencies]',
    'hbb_common = { path = "libs/hbb_common" }',
    ''
  ].join('\n');
}

function cargoLockFixture(): string {
  return [
    'version = 4',
    '',
    '[[package]]',
    'name = "hbbs"',
    'version = "1.1.14"',
    'dependencies = [',
    ' "hbb_common",',
    ' "headers",',
    ' "http",',
    ' "ipnetwork",',
    ' "jsonwebtoken",',
    ']',
    '',
    '[[package]]',
    'name = "jni"',
    'version = "0.20.0"',
    ''
  ].join('\n');
}

function rendezvousFixture(): string {
  return [
    'match msg_in.union {',
    '                Some(rendezvous_message::Union::RequestRelay(mut rf)) => {',
    '                    // there maybe several attempt, so sink can be none',
    '                    if let Some(sink) = sink.take() {}',
    '                    if let Some(peer) = self.pm.get_in_memory(&rf.id).await {}',
    '                    return true;',
    '                }',
    '}',
    ''
  ].join('\n');
}

function relayFixture(): string {
  return [
    'pub async fn start(port: &str, key: &str) -> ResultType<()> {',
    '    let key = get_server_sk(key);',
    '    Ok(())',
    '}',
    '',
    'async fn make_pair_(stream: impl StreamTrait, addr: SocketAddr, key: &str, limiter: Limiter) {',
    '    let mut stream = stream;',
    '    if let Some(rendezvous_message::Union::RequestRelay(rf)) = msg_in.union {',
    '                if !rf.uuid.is_empty() {',
    '                    let mut peer = PEERS.lock().await.remove(&rf.uuid);',
    '                    if let Some(peer) = peer.as_mut() {',
    '                        let id = format!("{}:{}", addr.ip(), addr.port());',
    '                        if let Err(err) = relay(addr, &mut stream, peer, limiter, id.clone()).await',
    '                        {',
    '                            log::info!("{}", err);',
    '                        }',
    '                        USAGE.write().await.remove(&id);',
    '                    } else {',
    '                        log::info!("New relay request {} from {}", rf.uuid, addr);',
    '                        PEERS.lock().await.insert(rf.uuid.clone(), Box::new(stream));',
    '                        sleep(30.).await;',
    '                        PEERS.lock().await.remove(&rf.uuid);',
    '                    }',
    '                }',
    '    }',
    '}',
    '',
    'async fn relay(',
    '    addr: SocketAddr,',
    '    stream: &mut impl StreamTrait,',
    '    peer: &mut Box<dyn StreamTrait>,',
    '    total_limiter: Limiter,',
    '    id: String,',
    ') -> ResultType<()> {',
    '    let mut timer = interval(Duration::from_secs(3));',
    '    let mut last_recv_time = std::time::Instant::now();',
    '    loop {',
    '        tokio::select! {',
    '            res = peer.recv() => {}',
    '            res = stream.recv() => {}',
    '            _ = timer.tick() => {',
    '                if last_recv_time.elapsed().as_secs() > 30 {',
    '                    bail!("Timeout");',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n');
}
