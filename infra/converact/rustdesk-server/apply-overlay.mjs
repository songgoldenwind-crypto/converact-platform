import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUSTDESK_SERVER_UPSTREAM_TAG = '1.1.16';
export const RUSTDESK_SERVER_UPSTREAM_COMMIT =
  '73523b31cfd25d77dee862e6fc9f5e1fb5e485ef';
export const RUSTDESK_SERVER_HBB_COMMON_COMMIT =
  '83419b6549636ee39dacef7776c473f5802e08d6';

const overlayRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repositoryRoot = resolve(overlayRoot, '../../..');

export function applyPinnedPatch(sourceRoot, patchPath) {
  try {
    execFileSync('git', ['-C', sourceRoot, 'apply', '--check', patchPath], {
      stdio: 'pipe'
    });
    execFileSync(
      'git',
      ['-C', sourceRoot, 'apply', '--whitespace=error-all', patchPath],
      { stdio: 'pipe' }
    );
    return 'applied';
  } catch (forwardError) {
    try {
      execFileSync(
        'git',
        ['-C', sourceRoot, 'apply', '--reverse', '--check', patchPath],
        { stdio: 'pipe' }
      );
      return 'already_applied';
    } catch {
      const reason = forwardError instanceof Error
        ? forwardError.message
        : String(forwardError);
      throw new Error(`RustDesk Server pinned patch does not apply: ${reason}`);
    }
  }
}

export function applyIveKitRustDeskServerOverlay(sourceRoot) {
  const root = resolve(sourceRoot);
  assertPinnedSource(root);
  mkdirSync(join(root, 'ivekit'), { recursive: true });
  cpSync(
    join(repositoryRoot, 'integrations/component-hook-rs'),
    join(root, 'ivekit/component-hook-rs'),
    { recursive: true }
  );
  cpSync(
    join(overlayRoot, 'server-hook.rs'),
    join(root, 'src/ivekit_owner.rs')
  );

  patchFile(join(root, 'Cargo.toml'), patchCargoToml);
  patchFile(join(root, 'Cargo.lock'), patchCargoLock);
  patchFile(join(root, 'src/lib.rs'), patchLibraryRoot);
  patchFile(join(root, 'src/hbbr.rs'), patchRelayBinary);
  patchFile(join(root, 'src/rendezvous_server.rs'), patchRendezvousServer);
  patchFile(join(root, 'src/relay_server.rs'), patchRelayServer);
  const hotPathPatchStatus = applyPinnedPatch(
    root,
    join(
      overlayRoot,
      'patches/rustdesk-server-ivekit-relay-hot-path.patch'
    )
  );

  return {
    tag: RUSTDESK_SERVER_UPSTREAM_TAG,
    commit: RUSTDESK_SERVER_UPSTREAM_COMMIT,
    hot_path_patch_status: hotPathPatchStatus,
    files: [
      'Cargo.toml',
      'Cargo.lock',
      'src/lib.rs',
      'src/hbbr.rs',
      'src/rendezvous_server.rs',
      'src/relay_server.rs',
      'src/ivekit_owner.rs',
      'ivekit/component-hook-rs'
    ]
  };
}

export function patchCargoToml(source) {
  if (source.includes('converact-component-hook =')) return source;
  return replaceOnce(
    source,
    '[dependencies]\n' +
      'hbb_common = { path = "libs/hbb_common" }\n',
    '[dependencies]\n' +
      'hbb_common = { path = "libs/hbb_common" }\n' +
      'converact-component-hook = { path = "ivekit/component-hook-rs" }\n',
    'RustDesk Server Cargo dependency anchor'
  );
}

export function patchCargoLock(source) {
  const packageIdentity = 'name = "converact-component-hook"\nversion = "0.1.0"';
  const dependencyIdentity = ' "converact-component-hook",';
  const hasPackage = source.includes(packageIdentity);
  const hasDependency = source.includes(dependencyIdentity);
  if (hasPackage && hasDependency) return source;
  if (hasPackage || hasDependency) {
    throw new Error('RustDesk Server Cargo.lock overlay is partially applied');
  }

  let patched = replaceOnce(
    source,
    ' "hbb_common",\n' +
      ' "headers",\n' +
      ' "http",\n' +
      ' "ipnetwork",\n' +
      ' "jsonwebtoken",',
    ' "hbb_common",\n' +
      ' "headers",\n' +
      ' "http",\n' +
      ' "ipnetwork",\n' +
      ' "converact-component-hook",\n' +
      ' "jsonwebtoken",',
    'RustDesk Server Cargo.lock hbbs dependency anchor'
  );
  patched = replaceOnce(
    patched,
    '[[package]]\nname = "jni"',
    '[[package]]\n' +
      'name = "converact-component-hook"\n' +
      'version = "0.1.0"\n\n' +
      '[[package]]\n' +
      'name = "jni"',
    'RustDesk Server Cargo.lock package anchor'
  );
  return patched;
}

export function patchLibraryRoot(source) {
  if (source.includes('pub mod ivekit_owner;')) return source;
  return `pub mod ivekit_owner;\n${source}`;
}

export function patchRelayBinary(source) {
  if (source.includes('mod ivekit_owner;')) return source;
  return replaceOnce(
    source,
    'mod common;\nmod relay_server;',
    'mod common;\nmod ivekit_owner;\nmod relay_server;',
    'RustDesk hbbr module anchor'
  );
}

export function patchRendezvousServer(source) {
  if (source.includes('ivekit_owner::claim_relay')) return source;
  return replaceOnce(
    source,
    '                Some(rendezvous_message::Union::RequestRelay(mut rf)) => {\n' +
      '                    // there maybe several attempt, so sink can be none',
    '                Some(rendezvous_message::Union::RequestRelay(mut rf)) => {\n' +
      '                    if let Err(err) = crate::ivekit_owner::claim_relay(&rf.id, &rf.uuid).await {\n' +
      '                        log::warn!("Converact RustDesk relay claim rejected: target={} relay_uuid={} err={}", rf.id, rf.uuid, err);\n' +
      '                        return true;\n' +
      '                    }\n' +
      '                    // there maybe several attempt, so sink can be none',
    'RustDesk rendezvous RequestRelay anchor'
  );
}

export function patchRelayServer(source) {
  let patched = source;
  if (!patched.includes('start_relay_owner_refresh')) {
    patched = replaceOnce(
      patched,
      '    let key = get_server_sk(key);\n',
      '    let key = get_server_sk(key);\n' +
        '    crate::ivekit_owner::start_relay_owner_refresh()\n' +
        '        .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;\n',
      'RustDesk relay start anchor'
    );
  }
  if (!patched.includes('open_or_assert_relay(&rf.uuid)')) {
    patched = replaceOnce(
      patched,
      '                if !rf.uuid.is_empty() {\n' +
        '                    let mut peer = PEERS.lock().await.remove(&rf.uuid);',
      '                if !rf.uuid.is_empty() {\n' +
        '                    if let Err(err) = crate::ivekit_owner::open_or_assert_relay(&rf.uuid).await {\n' +
        '                        log::warn!("Converact RustDesk relay owner rejected: relay_uuid={} err={}", rf.uuid, err);\n' +
        '                        return;\n' +
        '                    }\n' +
        '                    let mut peer = PEERS.lock().await.remove(&rf.uuid);',
      'RustDesk relay owner open anchor'
    );
  }
  if (!patched.includes('rf.uuid.clone()).await') &&
      !patched.includes('owner_relay_uuid: String')) {
    patched = replaceOnce(
      patched,
      '                        if let Err(err) = relay(addr, &mut stream, peer, limiter, id.clone()).await\n',
      '                        if let Err(err) = relay(addr, &mut stream, peer, limiter, id.clone(), rf.uuid.clone()).await\n',
      'RustDesk relay owner argument anchor'
    );
  }
  if (!patched.includes('owner_relay_uuid: String')) {
    patched = replaceOnce(
      patched,
      '    total_limiter: Limiter,\n' +
        '    id: String,\n' +
        ') -> ResultType<()> {',
      '    total_limiter: Limiter,\n' +
        '    id: String,\n' +
        '    owner_relay_uuid: String,\n' +
        ') -> ResultType<()> {',
      'RustDesk relay owner parameter anchor'
    );
  }
  if (!patched.includes('assert_relay(&owner_relay_uuid)')) {
    patched = replaceOnce(
      patched,
      '            _ = timer.tick() => {\n' +
        '                if last_recv_time.elapsed().as_secs() > 30 {',
      '            _ = timer.tick() => {\n' +
        '                crate::ivekit_owner::assert_relay(&owner_relay_uuid)\n' +
        '                    .map_err(|err| std::io::Error::new(std::io::ErrorKind::PermissionDenied, err))?;\n' +
        '                if last_recv_time.elapsed().as_secs() > 30 {',
      'RustDesk relay cached owner assertion anchor'
    );
  }
  if (!patched.includes('close_relay(&rf.uuid).await;')) {
    patched = replaceOnce(
      patched,
      '                        USAGE.write().await.remove(&id);\n' +
        '                    } else {\n' +
        '                        log::info!("New relay request {} from {}", rf.uuid, addr);\n' +
        '                        PEERS.lock().await.insert(rf.uuid.clone(), Box::new(stream));\n' +
        '                        sleep(30.).await;\n' +
        '                        PEERS.lock().await.remove(&rf.uuid);\n' +
        '                    }',
      '                        USAGE.write().await.remove(&id);\n' +
        '                        crate::ivekit_owner::close_relay(&rf.uuid).await;\n' +
        '                    } else {\n' +
        '                        log::info!("New relay request {} from {}", rf.uuid, addr);\n' +
        '                        PEERS.lock().await.insert(rf.uuid.clone(), Box::new(stream));\n' +
        '                        sleep(30.).await;\n' +
        '                        if PEERS.lock().await.remove(&rf.uuid).is_some() {\n' +
        '                            crate::ivekit_owner::close_relay(&rf.uuid).await;\n' +
        '                        }\n' +
        '                    }',
      'RustDesk relay owner close anchor'
    );
  }
  return patched;
}

function assertPinnedSource(root) {
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  if (commit !== RUSTDESK_SERVER_UPSTREAM_COMMIT) {
    throw new Error(
      `RustDesk Server source must be ${RUSTDESK_SERVER_UPSTREAM_COMMIT}; got ${commit}`
    );
  }
  const tag = execFileSync(
    'git',
    ['-C', root, 'describe', '--tags', '--exact-match', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (tag !== RUSTDESK_SERVER_UPSTREAM_TAG) {
    throw new Error(
      `RustDesk Server source tag must be ${RUSTDESK_SERVER_UPSTREAM_TAG}; got ${tag}`
    );
  }
  const submodules = execFileSync(
    'git',
    ['-C', root, 'submodule', 'status', '--recursive'],
    { encoding: 'utf8' }
  ).trim().split('\n').filter(Boolean);
  const [identity, path] = submodules[0]?.trim().split(/\s+/) || [];
  if (submodules.length !== 1 ||
      identity !== RUSTDESK_SERVER_HBB_COMMON_COMMIT ||
      path !== 'libs/hbb_common') {
    throw new Error(
      `RustDesk Server hbb_common must be initialized at ${RUSTDESK_SERVER_HBB_COMMON_COMMIT}`
    );
  }
}

function patchFile(path, patcher) {
  const source = readFileSync(path, 'utf8');
  const patched = patcher(source);
  if (patched !== source) writeFileSync(path, patched);
}

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${label} was not found exactly once`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourceRoot = process.argv[2];
  if (!sourceRoot) throw new Error('usage: node apply-overlay.mjs <rustdesk-server-source>');
  console.log(JSON.stringify(applyIveKitRustDeskServerOverlay(sourceRoot), null, 2));
}
