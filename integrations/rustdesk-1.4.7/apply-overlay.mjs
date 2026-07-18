import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const integrationRoot = dirname(fileURLToPath(import.meta.url));
export const RUSTDESK_UPSTREAM_TAG = '1.4.7';
export const RUSTDESK_UPSTREAM_COMMIT = '0c86d4616298f09435f6236599b300964aa61460';

export function applyIveKitRustDeskOverlay(sourceRoot) {
  verifyPinnedSource(sourceRoot);
  const libPath = join(sourceRoot, 'src', 'lib.rs');
  const cmPath = join(sourceRoot, 'src', 'ui_cm_interface.rs');
  const ipcPath = join(sourceRoot, 'src', 'ipc.rs');
  const serverConnectionPath = join(sourceRoot, 'src', 'server', 'connection.rs');
  const clientPath = join(sourceRoot, 'src', 'client.rs');
  const flutterPath = join(sourceRoot, 'src', 'flutter.rs');
  const cliPath = join(sourceRoot, 'src', 'cli.rs');
  const sciterRemotePath = join(sourceRoot, 'src', 'ui', 'remote.rs');
  const flutterCommonPath = join(sourceRoot, 'flutter', 'lib', 'common.dart');
  const multiWindowPath = join(sourceRoot, 'flutter', 'lib', 'utils', 'multi_window_manager.dart');
  const remoteTabPath = join(sourceRoot, 'flutter', 'lib', 'desktop', 'pages', 'remote_tab_page.dart');
  const remotePagePath = join(sourceRoot, 'flutter', 'lib', 'desktop', 'pages', 'remote_page.dart');
  const flutterModelPath = join(sourceRoot, 'flutter', 'lib', 'models', 'model.dart');
  const modulePath = join(sourceRoot, 'src', 'ivekit_native_control.rs');
  const evidenceModulePath = join(sourceRoot, 'src', 'ivekit_native_evidence.rs');
  const patched = patchIveKitRustDeskSources({
    lib: readFileSync(libPath, 'utf8'),
    connectionManager: readFileSync(cmPath, 'utf8')
  });
  const binding = patchIveKitRustDeskSessionBindingSources({
    ipc: readFileSync(ipcPath, 'utf8'),
    serverConnection: readFileSync(serverConnectionPath, 'utf8'),
    client: readFileSync(clientPath, 'utf8'),
    flutter: readFileSync(flutterPath, 'utf8'),
    cli: readFileSync(cliPath, 'utf8'),
    sciterRemote: readFileSync(sciterRemotePath, 'utf8'),
    flutterCommon: readFileSync(flutterCommonPath, 'utf8'),
    multiWindow: readFileSync(multiWindowPath, 'utf8'),
    remoteTab: readFileSync(remoteTabPath, 'utf8'),
    remotePage: readFileSync(remotePagePath, 'utf8'),
    flutterModel: readFileSync(flutterModelPath, 'utf8')
  });

  writeFileSync(libPath, patched.lib, 'utf8');
  writeFileSync(cmPath, patched.connectionManager, 'utf8');
  writeFileSync(ipcPath, binding.ipc, 'utf8');
  writeFileSync(serverConnectionPath, binding.serverConnection, 'utf8');
  writeFileSync(clientPath, binding.client, 'utf8');
  writeFileSync(flutterPath, binding.flutter, 'utf8');
  writeFileSync(cliPath, binding.cli, 'utf8');
  writeFileSync(sciterRemotePath, binding.sciterRemote, 'utf8');
  writeFileSync(flutterCommonPath, binding.flutterCommon, 'utf8');
  writeFileSync(multiWindowPath, binding.multiWindow, 'utf8');
  writeFileSync(remoteTabPath, binding.remoteTab, 'utf8');
  writeFileSync(remotePagePath, binding.remotePage, 'utf8');
  writeFileSync(flutterModelPath, binding.flutterModel, 'utf8');
  copyFileSync(join(integrationRoot, 'ivekit_native_control.rs'), modulePath);
  copyFileSync(join(integrationRoot, 'ivekit_native_evidence.rs'), evidenceModulePath);
  return { libPath, cmPath, ipcPath, serverConnectionPath, clientPath, flutterPath, modulePath, evidenceModulePath };
}

export function patchIveKitRustDeskSources(input) {
  let lib = input.lib;
  let cm = input.connectionManager;
  if (!lib.includes('pub mod ivekit_native_control;')) {
    lib = replaceOnce(
      lib,
      'mod ui_cm_interface;',
      'mod ui_cm_interface;\n#[cfg(windows)]\npub mod ivekit_native_control;',
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
      '#[cfg(windows)]\npub fn ivekit_resolve_connection(native_session_id: u64, controller_rustdesk_id: &str) -> Result<i32, &\'static str> {\n    let clients = CLIENTS.read().map_err(|_| "native_session_registry_unavailable")?;\n    let mut matches = clients.iter().filter(|(_, client)| {\n        client.ivekit_native_session_id == native_session_id &&\n        client.peer_id == controller_rustdesk_id &&\n        client.authorized &&\n        !client.disconnected &&\n        !client.is_file_transfer &&\n        !client.is_view_camera &&\n        !client.is_terminal &&\n        client.port_forward.is_empty()\n    }).map(|(id, _)| *id);\n    let native_id = matches.next().ok_or("native_session_unavailable")?;\n    if matches.next().is_some() {\n        return Err("native_session_ambiguous");\n    }\n    Ok(native_id)\n}\n\n#[cfg(windows)]\npub fn ivekit_connection_matches(id: i32, native_session_id: u64, controller_rustdesk_id: &str) -> bool {\n    CLIENTS.read().ok().and_then(|clients| clients.get(&id).map(|client| {\n        client.ivekit_native_session_id == native_session_id &&\n        client.peer_id == controller_rustdesk_id &&\n        client.authorized &&\n        !client.disconnected &&\n        !client.is_file_transfer &&\n        !client.is_view_camera &&\n        !client.is_terminal &&\n        client.port_forward.is_empty()\n    })).unwrap_or(false)\n}\n\n#[inline]\n#[cfg(not(any(target_os = "ios")))]\npub fn close(id: i32) {',
      'RustDesk ui_cm_interface close anchor'
    );
  }
  if (cm.includes('pub struct Client') && !cm.includes('pub ivekit_native_session_id: u64')) {
    cm = replaceOnce(
      cm,
      '    pub is_terminal: bool,\n    pub port_forward: String,',
      '    pub is_terminal: bool,\n    pub ivekit_native_session_id: u64,\n    pub port_forward: String,',
      'RustDesk connection manager client native session field'
    );
    cm = replaceOnce(
      cm,
      '        is_terminal: bool,\n        port_forward: String,',
      '        is_terminal: bool,\n        ivekit_native_session_id: u64,\n        port_forward: String,',
      'RustDesk connection manager native session argument'
    );
    cm = replaceOnce(
      cm,
      '            is_terminal,\n            port_forward,',
      '            is_terminal,\n            ivekit_native_session_id,\n            port_forward,',
      'RustDesk connection manager native session assignment'
    );
    cm = replaceOnce(
      cm,
      'Data::Login{id, is_file_transfer, is_view_camera, is_terminal, port_forward, peer_id,',
      'Data::Login{id, is_file_transfer, is_view_camera, is_terminal, ivekit_native_session_id, port_forward, peer_id,',
      'RustDesk connection manager login native session pattern'
    );
    cm = replaceOnce(
      cm,
      'self.cm.add_connection(id, is_file_transfer, is_view_camera, is_terminal, port_forward,',
      'self.cm.add_connection(id, is_file_transfer, is_view_camera, is_terminal, ivekit_native_session_id, port_forward,',
      'RustDesk connection manager login native session forwarding'
    );
  }
  if (!cm.includes('pub fn ivekit_active_controller_ids')) {
    cm = replaceOnce(
      cm,
      '#[cfg(windows)]\npub fn ivekit_resolve_connection(native_session_id: u64, controller_rustdesk_id: &str)',
      '#[cfg(windows)]\npub fn ivekit_active_controller_ids() -> Vec<String> {\n    let mut ids = CLIENTS.read().map(|clients| clients.values().filter(|client| {\n        client.authorized &&\n        !client.disconnected &&\n        !client.is_file_transfer &&\n        !client.is_view_camera &&\n        !client.is_terminal &&\n        client.port_forward.is_empty()\n    }).map(|client| client.peer_id.clone()).collect::<Vec<_>>()).unwrap_or_default();\n    ids.sort();\n    ids.dedup();\n    ids\n}\n\n#[cfg(windows)]\npub fn ivekit_resolve_connection(native_session_id: u64, controller_rustdesk_id: &str)',
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
  return { lib, connectionManager: cm };
}

export function patchIveKitRustDeskSessionBindingSources(input) {
  let ipc = input.ipc;
  let serverConnection = input.serverConnection;
  let client = input.client;
  let flutter = input.flutter;
  let cli = input.cli;
  let sciterRemote = input.sciterRemote;
  let flutterCommon = input.flutterCommon;
  let multiWindow = input.multiWindow;
  let remoteTab = input.remoteTab;
  let remotePage = input.remotePage;
  let flutterModel = input.flutterModel;

  if (!ipc.includes('ivekit_native_session_id: u64')) {
    ipc = replaceOnce(
      ipc,
      '        is_terminal: bool,\n        peer_id: String,',
      '        is_terminal: bool,\n        ivekit_native_session_id: u64,\n        peer_id: String,',
      'RustDesk IPC login native session field'
    );
  }
  if (!serverConnection.includes('ivekit_native_session_id: self.lr.session_id')) {
    serverConnection = replaceOnce(
      serverConnection,
      '            is_terminal: self.terminal,\n            port_forward:',
      '            is_terminal: self.terminal,\n            ivekit_native_session_id: self.lr.session_id,\n            port_forward:',
      'RustDesk server login native session forwarding'
    );
  }
  if (!client.includes('ivekit_native_session_id: Option<u64>')) {
    client = replaceOnce(
      client,
      '        shared_password: Option<String>,\n        conn_token: Option<String>,\n    ) {',
      '        shared_password: Option<String>,\n        conn_token: Option<String>,\n        ivekit_native_session_id: Option<u64>,\n    ) {',
      'RustDesk login initialization native session argument'
    );
    client = replaceOnce(
      client,
      '        if sid == 0 {\n            sid = rand::random();',
      '        if let Some(value) = ivekit_native_session_id {\n            sid = value;\n        }\n        if sid == 0 {\n            sid = rand::random();',
      'RustDesk login native session selection'
    );
  }
  if (!flutter.includes('ivekit_native_session_id: String')) {
    flutter = replaceOnce(
      flutter,
      '    is_shared_password: bool,\n    conn_token: Option<String>,\n) -> ResultType<FlutterSession> {',
      '    is_shared_password: bool,\n    conn_token: Option<String>,\n    ivekit_native_session_id: String,\n) -> ResultType<FlutterSession> {',
      'RustDesk Flutter session native binding argument'
    );
    flutter = replaceOnce(
      flutter,
      '    session.lc.write().unwrap().initialize(\n        id.to_owned(),',
      '    let ivekit_native_session_id = if ivekit_native_session_id.is_empty() {\n        None\n    } else {\n        let value = ivekit_native_session_id.parse::<u64>()\n            .map_err(|_| anyhow!("invalid iveKit native session ID"))?;\n        if value == 0 || value > i64::MAX as u64 {\n            bail!("invalid iveKit native session ID");\n        }\n        Some(value)\n    };\n\n    session.lc.write().unwrap().initialize(\n        id.to_owned(),',
      'RustDesk Flutter native session validation'
    );
    flutter = replaceOnce(
      flutter,
      '        shared_password,\n        conn_token,\n    );',
      '        shared_password,\n        conn_token,\n        ivekit_native_session_id,\n    );',
      'RustDesk Flutter native session initialization'
    );
  }
  if (!cli.includes('// iveKit native session binding')) {
    cli = replaceOnce(
      cli,
      '            None,\n            None,\n        );',
      '            None,\n            None,\n            None,\n            None, // iveKit native session binding\n        );',
      'RustDesk CLI native session default'
    );
  }
  if (!sciterRemote.includes('None, None, None, None);')) {
    sciterRemote = replaceOnce(
      sciterRemote,
      '.initialize(id, conn_type, None, force_relay, None, None, None);',
      '.initialize(id, conn_type, None, force_relay, None, None, None, None);',
      'RustDesk Sciter native session default'
    );
  }

  if (!flutterCommon.includes('String? ivekitSessionId;')) {
    flutterCommon = replaceOnce(
      flutterCommon,
      '  String? switchUuid;\n  bool? forceRelay;',
      '  String? switchUuid;\n  String? ivekitSessionId;\n  bool? forceRelay;',
      'RustDesk deep link native session variable'
    );
    flutterCommon = replaceOnce(
      flutterCommon,
      "      case '--switch_uuid':\n        switchUuid = args[i + 1];\n        i++;\n        break;",
      "      case '--switch_uuid':\n        switchUuid = args[i + 1];\n        i++;\n        break;\n      case '--ivekit_session_id':\n        ivekitSessionId = args[i + 1];\n        i++;\n        break;",
      'RustDesk deep link native session argument parsing'
    );
    flutterCommon = replaceOnce(
      flutterCommon,
      '              switchUuid: switchUuid,\n              forceRelay: forceRelay);',
      '              switchUuid: switchUuid,\n              ivekitSessionId: ivekitSessionId,\n              forceRelay: forceRelay);',
      'RustDesk deep link native session launch'
    );
    flutterCommon = replaceOnce(
      flutterCommon,
      '    String? switch_uuid = param["switch_uuid"];\n    if (switch_uuid != null) args.addAll([\'--switch_uuid\', switch_uuid]);',
      '    String? switch_uuid = param["switch_uuid"];\n    if (switch_uuid != null) args.addAll([\'--switch_uuid\', switch_uuid]);\n    String? ivekitSessionId = param["ivekit_session_id"];\n    if (ivekitSessionId != null) {\n      final parsed = BigInt.tryParse(ivekitSessionId);\n      if (parsed == null || parsed <= BigInt.zero || parsed > BigInt.from(0x7fffffffffffffff)) return null;\n      args.addAll([\'--ivekit_session_id\', parsed.toString()]);\n    }',
      'RustDesk protocol URL native session query'
    );
  }
  if (!multiWindow.includes('String? ivekitSessionId,')) {
    multiWindow = replaceOnce(
      multiWindow,
      '    String? switchUuid,\n    bool? isRDP,',
      '    String? switchUuid,\n    String? ivekitSessionId,\n    bool? isRDP,',
      'RustDesk multi-window native session argument'
    );
    multiWindow = replaceOnce(
      multiWindow,
      "    if (switchUuid != null) {\n      params['switch_uuid'] = switchUuid;\n    }",
      "    if (switchUuid != null) {\n      params['switch_uuid'] = switchUuid;\n    }\n    if (ivekitSessionId != null) {\n      params['ivekit_session_id'] = ivekitSessionId;\n    }",
      'RustDesk multi-window native session message'
    );
    multiWindow = replaceOnce(
      multiWindow,
      '    String? switchUuid,\n    bool? forceRelay,\n  }) async {',
      '    String? switchUuid,\n    String? ivekitSessionId,\n    bool? forceRelay,\n  }) async {',
      'RustDesk remote desktop native session argument'
    );
    multiWindow = replaceOnce(
      multiWindow,
      '      _remoteDesktopWindows,\n      password: password,\n      forceRelay: forceRelay,\n      switchUuid: switchUuid,\n      isSharedPassword:',
      '      _remoteDesktopWindows,\n      password: password,\n      forceRelay: forceRelay,\n      switchUuid: switchUuid,\n      ivekitSessionId: ivekitSessionId,\n      isSharedPassword:',
      'RustDesk remote desktop native session forwarding'
    );
  }
  if (!remoteTab.includes('ivekitSessionId: params[\'ivekit_session_id\']')) {
    remoteTab = replaceOnce(
      remoteTab,
      "          switchUuid: params['switch_uuid'],\n          forceRelay:",
      "          switchUuid: params['switch_uuid'],\n          ivekitSessionId: params['ivekit_session_id'],\n          forceRelay:",
      'RustDesk initial remote tab native session forwarding'
    );
    remoteTab = replaceOnce(
      remoteTab,
      '          switchUuid: switchUuid,\n          forceRelay:',
      "          switchUuid: switchUuid,\n          ivekitSessionId: args['ivekit_session_id'],\n          forceRelay:",
      'RustDesk new remote tab native session forwarding'
    );
  }
  if (!remotePage.includes('this.ivekitSessionId,')) {
    remotePage = replaceOnce(
      remotePage,
      '    this.switchUuid,\n    this.forceRelay,',
      '    this.switchUuid,\n    this.ivekitSessionId,\n    this.forceRelay,',
      'RustDesk remote page native session constructor'
    );
    remotePage = replaceOnce(
      remotePage,
      '  final String? switchUuid;\n  final bool? forceRelay;',
      '  final String? switchUuid;\n  final String? ivekitSessionId;\n  final bool? forceRelay;',
      'RustDesk remote page native session field'
    );
    remotePage = replaceOnce(
      remotePage,
      '      switchUuid: widget.switchUuid,\n      forceRelay:',
      '      switchUuid: widget.switchUuid,\n      ivekitNativeSessionId: widget.ivekitSessionId,\n      forceRelay:',
      'RustDesk remote page native session start'
    );
  }
  if (!flutterModel.includes('String? ivekitNativeSessionId,')) {
    flutterModel = replaceOnce(
      flutterModel,
      '    String? switchUuid,\n    String? password,',
      '    String? switchUuid,\n    String? ivekitNativeSessionId,\n    String? password,',
      'RustDesk FFI native session argument'
    );
    flutterModel = replaceOnce(
      flutterModel,
      '        connToken: connToken,\n      );',
      '        connToken: connToken,\n        ivekitNativeSessionId: ivekitNativeSessionId ?? \'\',\n      );',
      'RustDesk FFI native session forwarding'
    );
  }

  return {
    ipc,
    serverConnection,
    client,
    flutter,
    cli,
    sciterRemote,
    flutterCommon,
    multiWindow,
    remoteTab,
    remotePage,
    flutterModel
  };
}

function verifyPinnedSource(sourceRoot) {
  let head = '';
  try {
    head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    throw new Error('RustDesk overlay requires a pinned Git checkout');
  }
  if (head !== RUSTDESK_UPSTREAM_COMMIT) {
    throw new Error(
      `RustDesk source identity mismatch: expected ${RUSTDESK_UPSTREAM_COMMIT}, received ${head || 'unknown'}`
    );
  }
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
