import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyIveKitRustDeskOverlay,
  patchIveKitRustDeskSources,
  RUSTDESK_UPSTREAM_COMMIT,
  RUSTDESK_UPSTREAM_TAG
} from '../integrations/rustdesk-1.4.7/apply-overlay.mjs';

test('RustDesk 1.4.7 overlay installs one fail-closed native control path idempotently', () => {
  assert.equal(RUSTDESK_UPSTREAM_TAG, '1.4.7');
  assert.equal(RUSTDESK_UPSTREAM_COMMIT, '0c86d4616298f09435f6236599b300964aa61460');
  const source = {
    lib: 'mod ui_cm_interface;\n',
    connectionManager: [
    'pub async fn start_ipc<T: InvokeUiCM>(cm: ConnectionManager<T>) {',
    '    use_cm(cm);',
    '}',
    '',
    '#[inline]',
    '#[cfg(not(any(target_os = "ios")))]',
    'pub fn close(id: i32) {',
    '    send_close(id);',
    '}',
    ''
    ].join('\n')
  };
  const patched = patchIveKitRustDeskSources(source);
  assert.deepEqual(patchIveKitRustDeskSources(patched), patched);

  const lib = patched.lib;
  const cm = patched.connectionManager;
  const native = readFileSync('integrations/rustdesk-1.4.7/ivekit_native_control.rs', 'utf8');
  const evidence = readFileSync('integrations/rustdesk-1.4.7/ivekit_native_evidence.rs', 'utf8');
  assert.equal((lib.match(/pub mod ivekit_native_control/g) || []).length, 1);
  assert.equal((lib.match(/pub mod ivekit_native_evidence/g) || []).length, 1);
  assert.equal((cm.match(/ivekit_native_control::start_once/g) || []).length, 1);
  assert.equal((cm.match(/ivekit_native_evidence::start_once/g) || []).length, 1);
  assert.equal((cm.match(/pub fn ivekit_resolve_connection/g) || []).length, 1);
  assert.equal((cm.match(/pub fn ivekit_connection_matches/g) || []).length, 1);
  assert.equal((cm.match(/pub fn ivekit_active_controller_ids/g) || []).length, 1);
  assert.match(cm, /client\.peer_id == controller_rustdesk_id/);
  assert.match(cm, /client\.ivekit_native_session_id == native_session_id/);
  assert.match(cm, /client\.authorized/);
  assert.match(cm, /!client\.disconnected/);
  assert.match(cm, /!client\.is_file_transfer/);
  assert.match(cm, /!client\.is_terminal/);
  assert.match(native, /ui_cm_interface::close\(native_id\)/);
  assert.match(native, /ui_cm_interface::ivekit_resolve_connection/);
  assert.match(native, /ui_cm_interface::ivekit_connection_matches/);
  assert.match(native, /controller_rustdesk_id/);
  assert.match(native, /native_session_id/);
  assert.match(native, /ivekit_resolve_connection\(native_session_id, &request\.controller_rustdesk_id\)/);
  assert.match(native, /schema_version != 2/);
  assert.match(native, /interaction_id/);
  assert.match(native, /reservation_id/);
  assert.match(native, /owner_epoch/);
  assert.match(native, /ivekit-rustdesk-native-control-v2/);
  assert.match(native, /create_with_security_attributes_raw/);
  assert.match(native, /ConvertStringSecurityDescriptorToSecurityDescriptorW/);
  assert.match(native, /D:P\(A;;GA;;;SY\)\(A;;GA;;;BA\)/);
  assert.match(native, /reject_remote_clients\(true\)/);
  assert.match(native, /disconnect_timeout/);
  assert.match(native, /deny_unknown_fields/);
  assert.doesNotMatch(native, /Command::new|powershell|cmd\.exe|service restart/i);
  assert.match(evidence, /native-evidence-roots-v1\.txt/);
  assert.match(evidence, /native-evidence\\candidates/);
  assert.match(evidence, /ivekit_active_controller_ids/);
  assert.match(evidence, /file_type\(\).*is_symlink/);
  assert.match(evidence, /stable_scans/);
  assert.match(evidence, /controller_rustdesk_ids/);
  assert.doesNotMatch(evidence, /clipboard|keystroke|screen_pixels|read_to_end/i);
});

test('RustDesk overlay rejects an unpinned checkout and source layout drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-rustdesk-overlay-drift-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'lib.rs'), 'pub mod something_else;\n', 'utf8');
  writeFileSync(join(root, 'src', 'ui_cm_interface.rs'), 'pub fn close(id: i32) {}\n', 'utf8');
  assert.throws(() => applyIveKitRustDeskOverlay(root), /pinned Git checkout/);
  assert.throws(
    () => patchIveKitRustDeskSources({
      lib: 'pub mod something_else;\n',
      connectionManager: 'pub fn close(id: i32) {}\n'
    }),
    /anchor/
  );
});

test('RustDesk Windows CI checks out the immutable upstream commit', () => {
  const workflow = readFileSync('.github/workflows/ivekit-rustdesk-windows-ci.yml', 'utf8');
  assert.match(workflow, /ref: 0c86d4616298f09435f6236599b300964aa61460/);
  assert.doesNotMatch(workflow, /ref: 1\.4\.7/);
});
