import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadKamailioConfigRuntime,
  renderKamailioConfig,
  writeKamailioConfigRuntime
} from '../src/agent-runtime/ivekit/voice/kamailio-config.js';

const TOPOH_KEY = 'ivekit-topology-mask-key-1234567890abcdef';
const RPC_TOKEN = 'ivekit-kamailio-rpc-token-1234567890abcdef';

test('Kamailio renderer emits the complete stateful SIP edge route machine', () => {
  const rendered = renderKamailioConfig(baseConfig(), {
    topoh_mask_key: TOPOH_KEY,
    rpc_bearer_token: RPC_TOKEN
  });

  for (const module of [
    'dispatcher.so', 'dialog.so', 'rr.so', 'topoh.so', 'tm.so', 'tmx.so',
    'pike.so', 'htable.so', 'ipops.so', 'jsonrpcs.so', 'xhttp.so',
    'websocket.so', 'tls.so', 'xhttp_prom.so'
  ]) {
    assert.match(rendered.kamailio_cfg, new RegExp(`loadmodule "${escapeRegExp(module)}"`));
  }
  for (const route of [
    'REQINIT', 'AUTH', 'WITHINDLG', 'NEW_INVITE', 'DISPATCH', 'RELAY'
  ]) {
    assert.match(rendered.kamailio_cfg, new RegExp(`route\\[${route}\\]`));
  }
  assert.match(rendered.kamailio_cfg, /failure_route\[RUSTPBX_FAILOVER\]/);
  assert.match(rendered.kamailio_cfg, /ds_select_dst\("\$var\(pool\)", "11", "3"\)/);
  assert.match(rendered.kamailio_cfg, /ds_next_dst\(\)/);
  assert.match(rendered.kamailio_cfg, /ds_mark_dst\("tp"\)/);
  assert.match(rendered.kamailio_cfg, /record_route\(";ivkpin=/);
  assert.match(rendered.kamailio_cfg, /\$dlg_var\(ivekit_pin_set\)/);
  assert.match(rendered.kamailio_cfg, /\$\(route_uri\{uri\.param,ivkpin\}\)/);
  assert.match(rendered.kamailio_cfg, /dlg_manage\(\)/);
  assert.doesNotMatch(rendered.kamailio_cfg, /sqlite|sip:rustpbx:5060/);
});

test('Kamailio renderer limits failover to transport, 408 and selected 5xx responses', () => {
  const cfg = render().kamailio_cfg;

  assert.match(cfg, /t_branch_timeout\(\)/);
  assert.match(cfg, /t_check_status\("408\|500\|502\|503\|504"\)/);
  assert.match(cfg, /t_is_canceled\(\)/);
  assert.match(cfg, /remove_record_route\(\)/);
  assert.match(cfg, /Retry-After: 2/);
  assert.doesNotMatch(cfg, /t_check_status\("[^"\n]*(401|403|404|480|486|487|488)/);
  assert.match(cfg, /sl_send_reply\("503", "No Capacity"\)/);
});

test('Kamailio renderer protects trust boundaries, RPC and topology data', () => {
  const cfg = render().kamailio_cfg;

  assert.match(cfg, /listen=tcp:127\.0\.0\.1:5065/);
  assert.match(cfg, /\$si == "127\.0\.0\.1"/);
  assert.match(cfg, /\$hdr\(Authorization\) != "Bearer ivekit-kamailio-rpc-token/);
  assert.match(cfg, /jsonrpc_dispatch\(\)/);
  assert.match(cfg, /prom_dispatch\(\)/);
  assert.match(cfg, /modparam\("topoh", "mask_key", "ivekit-topology-mask-key/);
  assert.match(cfg, /remove_hf\("X-IveKit-Node-ID"\)/);
  assert.match(cfg, /remove_hf\("X-IveKit-Pin-Set"\)/);
  assert.match(cfg, /is_in_subnet\("\$si", "10\.20\.0\.0\/16"\)/);
  assert.match(cfg, /pike_check_req\(\)/);
  assert.match(cfg, /\$sht\(ivekit_source_cps=>/);
  assert.match(cfg, /\$sht\(ivekit_global_cps=>/);
  assert.match(cfg, /\$ml > 65535/);
  assert.doesNotMatch(cfg, /xlog\([^\n]*(Authorization|rpc-token|topology-mask)/i);
});

test('Kamailio renderer emits TLS and WSS configuration with strict transport bounds', () => {
  const rendered = render();

  assert.match(rendered.kamailio_cfg, /enable_tls=yes/);
  assert.match(rendered.kamailio_cfg, /listen=tls:0\.0\.0\.0:5061 advertise sip\.cell-a\.example\.com:5061/);
  assert.match(rendered.kamailio_cfg, /listen=tls:0\.0\.0\.0:7443 advertise wss\.cell-a\.example\.com:443/);
  assert.match(rendered.kamailio_cfg, /ws_handle_handshake\(\)/);
  assert.match(rendered.kamailio_cfg, /\$Rp == 7443/);
  assert.match(rendered.tls_cfg, /method = TLSv1\.2\+/);
  assert.match(rendered.tls_cfg, /private_key = \/run\/secrets\/kamailio-tls-key\.pem/);
  assert.match(rendered.tls_cfg, /certificate = \/run\/secrets\/kamailio-tls-cert\.pem/);
  assert.match(rendered.tls_cfg, /ca_list = \/run\/secrets\/kamailio-ca\.pem/);
});

test('Kamailio renderer rejects unsafe listeners, ACLs, secrets and capacity values', () => {
  assert.throws(
    () => renderKamailioConfig({
      ...baseConfig(),
      rpc_listener: { host: '0.0.0.0', port: 5065 }
    }, secrets()),
    /loopback/i
  );
  assert.throws(
    () => renderKamailioConfig({
      ...baseConfig(),
      trusted_source_cidrs: ['0.0.0.0/0']
    }, secrets()),
    /wildcard/i
  );
  assert.throws(
    () => renderKamailioConfig(baseConfig(), {
      topoh_mask_key: RPC_TOKEN,
      rpc_bearer_token: RPC_TOKEN
    }),
    /distinct/i
  );
  assert.throws(
    () => renderKamailioConfig({
      ...baseConfig(),
      per_source_invite_cps: 0
    }, secrets()),
    /per_source_invite_cps/i
  );
});

test('Kamailio runtime reads bounded secret files and writes generated configs atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-kamailio-render-'));
  const configFile = join(directory, 'config.json');
  const topohFile = join(directory, 'topoh-key');
  const rpcFile = join(directory, 'rpc-token');
  const outputFile = join(directory, 'kamailio.cfg');
  const tlsOutputFile = join(directory, 'tls.cfg');
  await writeFile(configFile, JSON.stringify({
    ...baseConfig(),
    tls_config_file: tlsOutputFile
  }), { mode: 0o600 });
  await writeFile(topohFile, `${TOPOH_KEY}\n`, { mode: 0o600 });
  await writeFile(rpcFile, `${RPC_TOKEN}\n`, { mode: 0o600 });

  const runtime = await loadKamailioConfigRuntime({
    OPC_IVEKIT_KAMAILIO_CONFIG_FILE: configFile,
    OPC_IVEKIT_KAMAILIO_TOPOH_KEY_FILE: topohFile,
    OPC_IVEKIT_KAMAILIO_RPC_TOKEN_FILE: rpcFile,
    OPC_IVEKIT_KAMAILIO_OUTPUT_FILE: outputFile,
    OPC_IVEKIT_KAMAILIO_TLS_OUTPUT_FILE: tlsOutputFile
  });
  assert.equal(runtime.config.cell_id, 'cell-a');
  await writeKamailioConfigRuntime(runtime);

  assert.match(await readFile(outputFile, 'utf8'), /route\[NEW_INVITE\]/);
  assert.match(await readFile(tlsOutputFile, 'utf8'), /TLSv1\.2\+/);
  assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
  assert.equal((await stat(tlsOutputFile)).mode & 0o777, 0o600);

  await assert.rejects(
    () => loadKamailioConfigRuntime({
      OPC_IVEKIT_KAMAILIO_CONFIG_FILE: configFile,
      OPC_IVEKIT_KAMAILIO_TOPOH_KEY_FILE: topohFile,
      OPC_IVEKIT_KAMAILIO_RPC_TOKEN_FILE: rpcFile,
      OPC_IVEKIT_KAMAILIO_OUTPUT_FILE: outputFile,
      OPC_IVEKIT_KAMAILIO_TLS_OUTPUT_FILE: tlsOutputFile,
      OPC_IVEKIT_KAMAILIO_RPC_TOKEN: RPC_TOKEN
    }),
    /inline.*secret/i
  );
});

test('Kamailio renderer has a file-only CLI and documented deployment contract', async () => {
  const [script, packageJson, envExample, referenceConfig, exampleJson] = await Promise.all([
    readFile(new URL('../scripts/render-kamailio-config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../infra/ivekit/env.example', import.meta.url), 'utf8'),
    readFile(new URL('../infra/config/kamailio.cfg', import.meta.url), 'utf8'),
    readFile(new URL('../infra/config/kamailio.runtime.example.json', import.meta.url), 'utf8')
  ]);
  assert.match(script, /loadKamailioConfigRuntime/);
  assert.match(script, /writeKamailioConfigRuntime/);
  assert.match(packageJson, /"ivekit:kamailio:render"/);
  for (const name of [
    'OPC_IVEKIT_KAMAILIO_CONFIG_FILE',
    'OPC_IVEKIT_KAMAILIO_TOPOH_KEY_FILE',
    'OPC_IVEKIT_KAMAILIO_RPC_TOKEN_FILE',
    'OPC_IVEKIT_KAMAILIO_OUTPUT_FILE',
    'OPC_IVEKIT_KAMAILIO_TLS_OUTPUT_FILE'
  ]) assert.match(envExample, new RegExp(`^${name}=`, 'm'));
  assert.match(referenceConfig, /ivekit:kamailio:render/);
  assert.doesNotMatch(referenceConfig, /sqlite|sip:rustpbx:5060/);
  assert.doesNotThrow(() => renderKamailioConfig(JSON.parse(exampleJson), secrets()));
});

function render() {
  return renderKamailioConfig(baseConfig(), secrets());
}

function secrets() {
  return {
    topoh_mask_key: TOPOH_KEY,
    rpc_bearer_token: RPC_TOKEN
  };
}

function baseConfig() {
  return {
    schema_version: '1.0.0' as const,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    default_pool_id: 100,
    dispatcher_file: '/var/lib/kamailio/dispatcher.list',
    tls_config_file: '/etc/kamailio/tls.cfg',
    udp_listener: {
      host: '0.0.0.0', port: 5060,
      advertise: { host: 'sip.cell-a.example.com', port: 5060 }
    },
    tcp_listener: {
      host: '0.0.0.0', port: 5060,
      advertise: { host: 'sip.cell-a.example.com', port: 5060 }
    },
    tls_listener: {
      host: '0.0.0.0', port: 5061,
      advertise: { host: 'sip.cell-a.example.com', port: 5061 }
    },
    wss_listener: {
      host: '0.0.0.0', port: 7443,
      advertise: { host: 'wss.cell-a.example.com', port: 443 }
    },
    rpc_listener: { host: '127.0.0.1', port: 5065 },
    trusted_source_cidrs: ['10.20.0.0/16', '192.0.2.10/32'],
    allow_public_wss: true,
    max_message_bytes: 65_535,
    per_source_invite_cps: 100,
    global_invite_cps: 5_000,
    pike_sampling_seconds: 2,
    pike_request_density: 30,
    max_failovers: 3,
    retry_after_seconds: 2,
    tls: {
      private_key_file: '/run/secrets/kamailio-tls-key.pem',
      certificate_file: '/run/secrets/kamailio-tls-cert.pem',
      ca_file: '/run/secrets/kamailio-ca.pem',
      require_client_certificate: false
    }
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
