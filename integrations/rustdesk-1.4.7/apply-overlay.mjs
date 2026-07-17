import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const integrationRoot = dirname(fileURLToPath(import.meta.url));

export function applyIveKitRustDeskOverlay(sourceRoot) {
  const libPath = join(sourceRoot, 'src', 'lib.rs');
  const cmPath = join(sourceRoot, 'src', 'ui_cm_interface.rs');
  const modulePath = join(sourceRoot, 'src', 'ivekit_native_control.rs');
  const evidenceModulePath = join(sourceRoot, 'src', 'ivekit_native_evidence.rs');
  let lib = readFileSync(libPath, 'utf8');
  let cm = readFileSync(cmPath, 'utf8');

  if (!lib.includes('pub mod ivekit_native_control;')) {
    lib = replaceOnce(
      lib,
      'pub mod ui_cm_interface;',
      'pub mod ui_cm_interface;\n#[cfg(windows)]\npub mod ivekit_native_control;',
      'RustDesk src/lib.rs ui_cm_interface module anchor'
    );
  }
  if (!lib.includes('pub mod ivekit_native_evidence;')) {
    lib = replaceOnce(
      lib,
      'pub mod ivekit_native_control;',
      'pub mod ivekit_native_control;\n#[cfg(windows)]\npub mod ivekit_native_evidence;',
      'RustDesk src/lib.rs ivekit native control module anchor'
    );
  }
  if (!cm.includes('pub fn ivekit_resolve_connection')) {
    cm = replaceOnce(
      cm,
      '#[inline]\n#[cfg(not(any(target_os = "ios")))]\npub fn close(id: i32) {',
      '#[cfg(windows)]\npub fn ivekit_resolve_connection(controller_rustdesk_id: &str) -> Result<i32, &\'static str> {\n    let clients = CLIENTS.read().map_err(|_| "native_session_registry_unavailable")?;\n    let mut matches = clients.iter().filter(|(_, client)| {\n        client.peer_id == controller_rustdesk_id &&\n        client.authorized &&\n        !client.disconnected &&\n        !client.is_file_transfer &&\n        !client.is_view_camera &&\n        !client.is_terminal &&\n        client.port_forward.is_empty()\n    }).map(|(id, _)| *id);\n    let native_id = matches.next().ok_or("native_session_unavailable")?;\n    if matches.next().is_some() {\n        return Err("native_session_ambiguous");\n    }\n    Ok(native_id)\n}\n\n#[cfg(windows)]\npub fn ivekit_connection_matches(id: i32, controller_rustdesk_id: &str) -> bool {\n    CLIENTS.read().ok().and_then(|clients| clients.get(&id).map(|client| {\n        client.peer_id == controller_rustdesk_id &&\n        client.authorized &&\n        !client.disconnected &&\n        !client.is_file_transfer &&\n        !client.is_view_camera &&\n        !client.is_terminal &&\n        client.port_forward.is_empty()\n    })).unwrap_or(false)\n}\n\n#[inline]\n#[cfg(not(any(target_os = "ios")))]\npub fn close(id: i32) {',
      'RustDesk ui_cm_interface close anchor'
    );
  }
  if (!cm.includes('pub fn ivekit_active_controller_ids')) {
    cm = replaceOnce(
      cm,
      '#[cfg(windows)]\npub fn ivekit_resolve_connection(controller_rustdesk_id: &str)',
      '#[cfg(windows)]\npub fn ivekit_active_controller_ids() -> Vec<String> {\n    let mut ids = CLIENTS.read().map(|clients| clients.values().filter(|client| {\n        client.authorized &&\n        !client.disconnected &&\n        !client.is_file_transfer &&\n        !client.is_view_camera &&\n        !client.is_terminal &&\n        client.port_forward.is_empty()\n    }).map(|client| client.peer_id.clone()).collect::<Vec<_>>()).unwrap_or_default();\n    ids.sort();\n    ids.dedup();\n    ids\n}\n\n#[cfg(windows)]\npub fn ivekit_resolve_connection(controller_rustdesk_id: &str)',
      'RustDesk ui_cm_interface ivekit resolver anchor'
    );
  }
  if (!cm.includes('crate::ivekit_native_control::start_once();')) {
    const match = cm.match(/pub async fn start_ipc<T: InvokeUiCM>\(cm: ConnectionManager<T>\) \{/);
    if (!match || match.index === undefined) {
      throw new Error('RustDesk ui_cm_interface start_ipc anchor was not found exactly once');
    }
    const anchor = match[0];
    cm = replaceOnce(
      cm,
      anchor,
      `${anchor}\n    #[cfg(windows)]\n    crate::ivekit_native_control::start_once();`,
      'RustDesk ui_cm_interface start_ipc anchor'
    );
  }
  if (!cm.includes('crate::ivekit_native_evidence::start_once();')) {
    cm = replaceOnce(
      cm,
      '    crate::ivekit_native_control::start_once();',
      '    crate::ivekit_native_control::start_once();\n    #[cfg(windows)]\n    crate::ivekit_native_evidence::start_once();',
      'RustDesk ui_cm_interface ivekit native control start anchor'
    );
  }

  writeFileSync(libPath, lib, 'utf8');
  writeFileSync(cmPath, cm, 'utf8');
  copyFileSync(join(integrationRoot, 'ivekit_native_control.rs'), modulePath);
  copyFileSync(join(integrationRoot, 'ivekit_native_evidence.rs'), evidenceModulePath);
  return { libPath, cmPath, modulePath, evidenceModulePath };
}

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${label} was not found exactly once`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourceRoot = String(process.argv[2] || '').trim();
  if (!sourceRoot) {
    console.error('usage: node apply-overlay.mjs <rustdesk-1.4.7-source-root>');
    process.exit(64);
  }
  try {
    console.log(JSON.stringify(applyIveKitRustDeskOverlay(sourceRoot), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
