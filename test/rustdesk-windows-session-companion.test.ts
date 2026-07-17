import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

test('Windows disconnect adapter uses the packaged precise-session bridge only', () => {
  const adapter = source('scripts/rustdesk-edge-adapters/windows-disconnect.ps1');

  assert.doesNotMatch(adapter, /OPC_RUSTDESK_SESSION_DISCONNECT_HOOK/);
  assert.match(adapter, /OPC_RUSTDESK_PRECISE_DISCONNECT_SCRIPT/);
  assert.match(adapter, /Invoke-IveKitRustDeskSessionDisconnect\.ps1/);
  assert.match(adapter, /-Mode'\s+\$Mode/);
  assert.match(adapter, /-ExternalId'\s+\$ExternalId/);
  assert.match(adapter, /-TargetId'\s+\$TargetId/);
  assert.match(adapter, /-RustDeskId'\s+\$RustDeskId/);
  assert.match(adapter, /-ControllerRustDeskId'\s+\$ControllerRustDeskId/);
  assert.doesNotMatch(adapter, /Invoke-Expression|Start-Process|cmd\.exe/i);
});

test('Windows legacy session registry remains an ACL-protected diagnostic migration tool', () => {
  const resolver = source('scripts/rustdesk-windows/Resolve-IveKitRustDeskSession.ps1');

  assert.match(resolver, /ValidateSet\('register', 'unregister', 'resolve'\)/);
  assert.match(resolver, /NativeSessionId/);
  assert.match(resolver, /ExternalId/);
  assert.match(resolver, /TargetId/);
  assert.match(resolver, /RustDeskId/);
  assert.match(resolver, /Move-Item[^\n]+-Force/);
  assert.match(resolver, /icacls/);
  assert.match(resolver, /ambiguous/i);
  assert.match(resolver, /expires_at/i);
  assert.doesNotMatch(resolver, /Invoke-Expression|Start-Process|cmd\.exe/i);
});

test('Windows precise disconnect sends an epoch-fenced v2 named-pipe request for the resolved native ID', () => {
  const bridge = source('scripts/rustdesk-windows/Invoke-IveKitRustDeskSessionDisconnect.ps1');

  assert.match(bridge, /NamedPipeClientStream/);
  assert.doesNotMatch(bridge, /Resolve-IveKitRustDeskSession\.ps1/);
  assert.match(bridge, /ControllerRustDeskId/);
  assert.match(bridge, /controller_rustdesk_id/);
  assert.match(bridge, /native_session_id/);
  assert.match(bridge, /command_id/);
  assert.match(bridge, /disconnect_session/);
  assert.match(bridge, /InteractionId/);
  assert.match(bridge, /ReservationId/);
  assert.match(bridge, /OwnerEpoch/);
  assert.match(bridge, /schema_version\s*=\s*\$schemaVersion/);
  assert.match(bridge, /ivekit-rustdesk-native-control-v2'\)\s*\{\s*2\s*\}/);
  assert.match(bridge, /ivekit-rustdesk-native-control-v2/);
  assert.match(bridge, /OPC_RUSTDESK_NATIVE_CONTROL_PIPE/);
  assert.match(bridge, /already_disconnected/);
  assert.match(bridge, /native_session_id_mismatch/);
  assert.doesNotMatch(bridge, /Invoke-Expression|Start-Process|cmd\.exe/i);
});

test('Windows installer packages the companion and supplies complete adapter arguments', () => {
  const deployment = source('scripts/rustdesk-windows/Deploy-IveKitRustDesk.ps1');
  const service = source('scripts/rustdesk-windows/IveKitRustDeskEdge.xml.template');
  const packager = source('scripts/rustdesk-windows-package.ts');

  assert.match(deployment, /'-Mode', 'execute'/);
  assert.match(deployment, /'-TargetId', '\{target_id\}'/);
  assert.match(deployment, /'-ControllerRustDeskId', '\{controller_rustdesk_id\}'/);
  assert.match(deployment, /'-InteractionId', '\{interaction_id\}'/);
  assert.match(deployment, /'-ReservationId', '\{reservation_id\}'/);
  assert.match(deployment, /'-OwnerEpoch', '\{owner_epoch\}'/);
  assert.match(deployment, /Invoke-IveKitRustDeskSessionDisconnect\.ps1/);
  assert.match(deployment, /Resolve-IveKitRustDeskSession\.ps1/);
  assert.match(service, /OPC_RUSTDESK_PRECISE_DISCONNECT_SCRIPT/);
  assert.match(service, /OPC_RUSTDESK_SESSION_REGISTRY_FILE/);
  assert.match(service, /OPC_RUSTDESK_NATIVE_CONTROL_PIPE/);
  assert.match(packager, /Invoke-IveKitRustDeskSessionDisconnect\.ps1/);
  assert.match(packager, /Resolve-IveKitRustDeskSession\.ps1/);
});
