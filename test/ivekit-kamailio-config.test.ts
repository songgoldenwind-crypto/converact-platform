import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadKamailioConfigRuntime,
  renderKamailioConfig,
  writeKamailioConfigRuntime
} from '../src/agent-runtime/converact/voice/kamailio-config.js';

const TOPOH_KEY = 'ivekit-topology-mask-key-1234567890abcdef';
const RPC_TOKEN = 'ivekit-kamailio-rpc-token-1234567890abcdef';
const WEBPHONE_JWT_SECRET = 'ivekit-webphone-jwt-secret-1234567890abcdef';

test('Kamailio renderer emits the complete stateful SIP edge route machine', () => {
  const rendered = renderKamailioConfig(baseConfig(), {
    topoh_mask_key: TOPOH_KEY,
    rpc_bearer_token: RPC_TOKEN,
    webphone_jwt_secret: WEBPHONE_JWT_SECRET
  });

  for (const module of [
    'dispatcher.so', 'dialog.so', 'outbound.so', 'rr.so', 'topoh.so', 'tm.so', 'tmx.so',
    'pike.so', 'htable.so', 'ipops.so', 'jsonrpcs.so', 'xhttp.so',
    'websocket.so', 'tls.so', 'xhttp_prom.so', 'jwt.so', 'jansson.so',
    'registrar.so', 'usrloc.so', 'path.so', 'dmq.so', 'dmq_usrloc.so'
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
  assert.match(rendered.kamailio_cfg, /\$dlg_var\(ivekit_cell_epoch\) = "7";/);
  assert.match(rendered.kamailio_cfg, /\$\(route_uri\{uri\.param,ivkpin\}\)/);
  assert.match(rendered.kamailio_cfg, /dlg_manage\(\)/);
  assert.doesNotMatch(rendered.kamailio_cfg, /sqlite|sip:rustpbx:5060/);
});

test('Kamailio renderer limits failover to transport, 408 and selected 5xx responses', () => {
  const cfg = render().kamailio_cfg;
  const inviteFailure = cfg.slice(
    cfg.indexOf('failure_route[RUSTPBX_FAILOVER]'),
    cfg.indexOf('failure_route[RUSTPBX_REGISTER_FAILOVER]')
  );
  const registerFailure = cfg.slice(
    cfg.indexOf('failure_route[RUSTPBX_REGISTER_FAILOVER]'),
    cfg.indexOf('onreply_route[REGISTER_REPLY]')
  );

  assert.match(cfg, /t_branch_timeout\(\)/);
  for (const failureRoute of [inviteFailure, registerFailure]) {
    const softOverload = failureRoute.slice(
      failureRoute.indexOf('if (t_check_status("503"))'),
      failureRoute.indexOf('if (!t_branch_timeout()')
    );
    assert.match(softOverload, /if \(t_check_status\("503"\)\)/);
    assert.match(softOverload, /ds_next_dst\(\)/);
    assert.doesNotMatch(softOverload, /ds_mark_dst\(/);
    assert.match(
      failureRoute,
      /if \(!t_branch_timeout\(\) && !t_check_status\("408\|500\|502\|504"\)\) exit;[\s\S]*?ds_mark_dst\("tp"\)/
    );
  }
  assert.match(cfg, /t_is_canceled\(\)/);
  assert.match(cfg, /remove_record_route\(\)/);
  assert.match(
    cfg,
    /failure_route\[RUSTPBX_FAILOVER\][\s\S]*?if \(!t_relay\(\)\) t_reply\("500", "Relay Failed"\)/
  );
  assert.match(
    cfg,
    /failure_route\[RUSTPBX_REGISTER_FAILOVER\][\s\S]*?if \(!t_relay\(\)\) t_reply\("500", "Relay Failed"\)/
  );
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
  assert.doesNotMatch(cfg, /!~/);
  assert.match(cfg, /\$sht\(ivekit_source_cps=>/);
  assert.match(cfg, /modparam\("htable", "htable", "ivekit_global_cps=>/);
  assert.match(cfg, /\$sht\(ivekit_global_cps=>second\) != \$Ts/);
  assert.match(cfg, /\$sht\(ivekit_global_cps=>count\) = 0/);
  assert.match(
    cfg,
    /\$sht\(ivekit_global_cps=>count\) =\s*\$sht\(ivekit_global_cps=>count\) \+ 1/
  );
  assert.match(
    cfg,
    /if \(\$sht\(ivekit_global_cps=>count\) > 5000\) \{[\s\S]*?sl_send_reply\("503", "Cell CPS Exceeded"\)/
  );
  assert.doesNotMatch(cfg, /ratelimit|rl_check_pipe|\$vn\(|sht_lock|sht_unlock/);
  assert.match(cfg, /\$ml > 65535/);
  assert.match(
    cfg,
    /if \(is_method\("CANCEL"\)\) \{\s*route\(AUTH\);\s*if \(t_check_trans\(\)\) route\(RELAY\);/
  );
  assert.doesNotMatch(cfg, /xlog\([^\n]*(Authorization|rpc-token|topology-mask)/i);
});

test('Kamailio renderer emits TLS and WSS configuration with strict transport bounds', () => {
  const rendered = render();

  assert.match(rendered.kamailio_cfg, /enable_tls=yes/);
  assert.match(rendered.kamailio_cfg, /listen=tls:0\.0\.0\.0:5061 advertise "sip\.cell-a\.example\.com":5061/);
  assert.match(rendered.kamailio_cfg, /listen=tls:0\.0\.0\.0:7443 advertise "wss\.cell-a\.example\.com":443/);
  assert.match(rendered.kamailio_cfg, /alias="sip\.cell-a\.example\.com"/);
  assert.match(rendered.kamailio_cfg, /alias="wss\.cell-a\.example\.com"/);
  assert.match(rendered.kamailio_cfg, /ws_handle_handshake\(\)/);
  assert.match(rendered.kamailio_cfg, /\$Rp == 7443/);
  assert.match(rendered.tls_cfg, /method = TLSv1\.2\+/);
  assert.match(rendered.tls_cfg, /private_key = \/run\/secrets\/kamailio-tls-key\.pem/);
  assert.match(rendered.tls_cfg, /certificate = \/run\/secrets\/kamailio-tls-cert\.pem/);
  assert.match(rendered.tls_cfg, /ca_list = \/run\/secrets\/kamailio-ca\.pem/);
  assert.doesNotMatch(rendered.kamailio_cfg, /ds_ping_fr_timer/);
});

test('Kamailio renderer closes WebPhone WSS authentication and registration routing', () => {
  const cfg = render().kamailio_cfg;

  assert.match(cfg, /\$\(hu\{url\.querystring\}\{param\.value,token,&\}\)/);
  assert.match(cfg, /modparam\("jwt", "key_mode", 1\)/);
  assert.match(cfg, /jwt_verify\("\/run\/secrets\/webphone-jwt-secret", "HS256",\s*"iss='ivekit';aud='rustpbx-webphone'"/);
  assert.match(cfg, /\$hdr\(Origin\) == "https:\/\/led\.example\.com"/);
  assert.match(cfg, /\$\(var\(webphone_token\)\{s\.select,1,\.\}\{s\.decode\.base64urlt\}\)/);
  assert.match(cfg, /jansson_get\("sub", "\$var\(webphone_claims\)", "\$var\(webphone_sub\)"\)/);
  assert.match(cfg, /\$sht\(ivekit_ws_sub=>\$conid\)/);
  assert.match(cfg, /event_route\[websocket:closed\]/);
  assert.doesNotMatch(cfg, /ivekit_ws_token/);
  assert.doesNotMatch(cfg, new RegExp(escapeRegExp(WEBPHONE_JWT_SECRET)));
  for (const metric of [
    'ivekit_webphone_auth_failures',
    'ivekit_webphone_assertion_failures',
    'ivekit_webphone_registrations',
    'ivekit_webphone_location_save_failures',
    'ivekit_webphone_delivery_misses',
    'ivekit_dmq_rejects'
  ]) assert.match(cfg, new RegExp(escapeRegExp(metric)));

  assert.match(cfg, /route\[WEBPHONE_REGISTER\]/);
  assert.match(cfg, /\$fU != \$var\(webphone_sub\)/);
  assert.match(cfg, /add_path_received\(\)/);
  assert.match(cfg, /t_on_reply\("REGISTER_REPLY"\)/);
  assert.match(cfg, /onreply_route\[REGISTER_REPLY\]/);
  assert.match(cfg, /t_check_status\("2\[0-9\]\[0-9\]"\)/);
  assert.match(cfg, /save\("location"/);
  assert.match(cfg, /update_stat\("ivekit_webphone_registrations", "\+1"\)/);
  assert.match(cfg, /update_stat\("ivekit_webphone_location_save_failures", "\+1"\)/);
  assert.match(cfg, /\$var\(webphone_assertion_exp\) = \$Ts \+ 30/);
  assert.match(cfg, /jwt_generate\("\/run\/secrets\/webphone-jwt-secret", "HS256"/);
  assert.match(cfg, /append_hf\("X-Auth-Token: \$jwt\(val\)/);
  assert.match(cfg, /update_stat\("ivekit_webphone_assertion_failures", "\+1"\)/);
  assert.match(cfg, /remove_hf\("X-Auth-Token"\)/);

  assert.match(cfg, /route\[WEBPHONE_DELIVERY\]/);
  assert.match(cfg, /\$var\(from_rustpbx\) == 1/);
  assert.match(cfg, /lookup\("location"\)/);
  assert.match(cfg, /record_route\(";ivkwp=1"\)/);
  assert.match(cfg, /check_route_param\("ivkwp=1"\)/);
  assert.match(cfg, /route\[WEBPHONE_DIALOG\]/);
  assert.match(
    cfg,
    /route\[PRELOADED_ROUTE\][\s\S]*?\$var\(from_rustpbx\) != 1/
  );
  assert.match(
    cfg,
    /route\[WEBPHONE_DIALOG\][\s\S]*?if \(\$var\(from_rustpbx\) == 1\) route\(WEBPHONE_RELAY\)/
  );
  assert.match(cfg, /route\[WEBPHONE_DIALOG\][\s\S]*?if \(\$proto == "WSS"\) route\(RELAY\)/);
  assert.match(cfg, /update_stat\("ivekit_webphone_delivery_misses", "\+1"\)/);
  assert.match(cfg, /is_in_subnet\("\$si", "10\.30\.0\.0\/16"\)/);
});

test('Kamailio renderer replicates only authenticated WebPhone locations across Edge nodes', () => {
  const cfg = render().kamailio_cfg;

  assert.match(cfg, /listen=udp:0\.0\.0\.0:5066/);
  assert.match(cfg, /modparam\("dmq", "server_address", "sip:10\.20\.0\.10:5066"\)/);
  assert.match(cfg, /modparam\("dmq", "server_socket", "udp:0\.0\.0\.0:5066"\)/);
  assert.match(cfg, /modparam\("dmq", "notification_address", "sip:ivekit-kamailio-0\.ivekit-kamailio-headless:5066"\)/);
  assert.match(cfg, /modparam\("dmq", "notification_address", "sip:ivekit-kamailio-1\.ivekit-kamailio-headless:5066"\)/);
  assert.match(cfg, /modparam\("dmq_usrloc", "enable", 1\)/);
  assert.match(cfg, /modparam\("dmq_usrloc", "sync", 1\)/);
  assert.match(cfg, /modparam\("dmq_usrloc", "replicate_socket_info", 1\)/);
  assert.match(cfg, /modparam\("usrloc", "db_mode", 0\)/);
  assert.match(cfg, /is_method\("KDMQ"\)/);
  assert.match(cfg, /\$Rp != 5066/);
  assert.match(cfg, /is_in_subnet\("\$si", "10\.20\.0\.0\/16"\)/);
  assert.match(cfg, /dmq_handle_message\(\)/);
  assert.match(cfg, /update_stat\("ivekit_dmq_rejects", "\+1"\)/);
  assert.doesNotMatch(cfg, /ivekit_ws_sub[^\n]*(dmq|replicat)/i);
});

test('Kamailio renderer does not initialize DMQ modules when replication is disabled', () => {
  const config = baseConfig();
  const cfg = renderKamailioConfig({
    ...config,
    dmq: {
      ...config.dmq,
      enabled: false
    }
  }, secrets()).kamailio_cfg;

  assert.doesNotMatch(cfg, /loadmodule "dmq\.so"/);
  assert.doesNotMatch(cfg, /loadmodule "dmq_usrloc\.so"/);
  assert.match(cfg, /sl_send_reply\("503", "DMQ Disabled"\)/);
});

test('Kamailio renderer mirrors SIP to an off-path HEPv3 collector without database writes', () => {
  const cfg = renderKamailioConfig({
    ...baseConfig(),
    sip_trace: {
      enabled: true,
      collector_host: 'homer-capture.observability.svc.cluster.local',
      collector_port: 9060,
      capture_id: 101,
      include_options: false,
      initial_mode: 'off'
    } as any
  }, secrets()).kamailio_cfg;

  assert.match(cfg, /loadmodule "siptrace\.so"/);
  assert.match(cfg, /modparam\("siptrace", "duplicate_uri", "sip:homer-capture\.observability\.svc\.cluster\.local:9060"\)/);
  assert.match(cfg, /modparam\("siptrace", "hep_mode_on", 1\)/);
  assert.match(cfg, /modparam\("siptrace", "hep_version", 3\)/);
  assert.match(cfg, /modparam\("siptrace", "hep_capture_id", 101\)/);
  assert.match(cfg, /modparam\("siptrace", "trace_init_mode", 1\)/);
  assert.match(cfg, /modparam\("siptrace", "trace_mode", 1\)/);
  assert.match(cfg, /modparam\("siptrace", "trace_to_database", 0\)/);
  assert.match(cfg, /loadmodule "cfgutils\.so"/);
  assert.match(cfg, /ivekit_hep_control=>size=2/);
  assert.match(cfg, /event_route\[htable:mod-init\]/);
  assert.match(cfg, /\$sht\(ivekit_hep_control=>mode\) = 0/);
  assert.match(cfg, /\$sht\(ivekit_hep_control=>sample_buckets\) = 102/);
  assert.match(cfg, /event_route\[siptrace:msg\][\s\S]*ivekit_hep_control=>mode\) == 0[\s\S]*drop\(\)/);
  assert.match(cfg, /core_hash\("\$ci", "", 10\)/);
  assert.match(cfg, /\$rc > \$sht\(ivekit_hep_control=>sample_buckets\)/);
  assert.match(cfg, /ivekit_hep_trace_events/);
  assert.match(cfg, /ivekit_hep_trace_dropped_control/);
  assert.match(cfg, /ivekit_hep_trace_sampled/);
  assert.match(cfg, /event_route\[siptrace:msg\][\s\S]*is_method\("OPTIONS\|KDMQ"\)[\s\S]*drop\(\)/);
  assert.doesNotMatch(cfg, /modparam\("siptrace", "db_url"/);
});

test('Kamailio renderer keeps HEP capture absent by default and rejects unsafe collectors', () => {
  assert.doesNotMatch(render().kamailio_cfg, /siptrace/);
  assert.throws(
    () => renderKamailioConfig({
      ...baseConfig(),
      sip_trace: {
        ...baseConfig().sip_trace,
        enabled: true,
        collector_host: '0.0.0.0'
      }
    }, secrets()),
    /collector/i
  );
  assert.throws(
    () => renderKamailioConfig({
      ...baseConfig(),
      sip_trace: {
        ...baseConfig().sip_trace,
        capture_id: 0
      }
    }, secrets()),
    /capture_id/i
  );
});

test('Kamailio renderer keeps disabled public WSS with no origins syntactically fail-closed', () => {
  const rendered = renderKamailioConfig({
    ...baseConfig(),
    allow_public_wss: false,
    webphone_auth: {
      ...baseConfig().webphone_auth,
      allowed_origins: []
    }
  }, secrets()).kamailio_cfg;

  assert.match(rendered, /if \(!\(0\)\)/);
  assert.doesNotMatch(rendered, /if \(!\(\)\)/);
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
      rpc_bearer_token: RPC_TOKEN,
      webphone_jwt_secret: WEBPHONE_JWT_SECRET
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
  assert.throws(
    () => renderKamailioConfig({
      ...baseConfig(),
      dmq: {
        ...baseConfig().dmq,
        notification_addresses: ['sip:ivekit-kamailio-0.ivekit-kamailio-headless:5066']
      }
    }, secrets()),
    /at least two/i
  );
  assert.throws(
    () => renderKamailioConfig({
      ...baseConfig(),
      dmq: {
        ...baseConfig().dmq,
        notification_addresses: [
          'sip:ivekit-kamailio-0.ivekit-kamailio-headless:5067',
          'sip:ivekit-kamailio-1.ivekit-kamailio-headless:5067'
        ]
      }
    }, secrets()),
    /server_port/i
  );
});

test('Kamailio runtime reads bounded secret files and writes generated configs atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-kamailio-render-'));
  const configFile = join(directory, 'config.json');
  const topohFile = join(directory, 'topoh-key');
  const rpcFile = join(directory, 'rpc-token');
  const outputFile = join(directory, 'kamailio.cfg');
  const tlsOutputFile = join(directory, 'tls.cfg');
  const webphoneJwtFile = join(directory, 'webphone-jwt-secret');
  await writeFile(configFile, JSON.stringify({
    ...baseConfig(),
    webphone_auth: {
      ...baseConfig().webphone_auth,
      jwt_secret_file: webphoneJwtFile
    },
    tls_config_file: tlsOutputFile
  }), { mode: 0o600 });
  await writeFile(topohFile, `${TOPOH_KEY}\n`, { mode: 0o600 });
  await writeFile(rpcFile, `${RPC_TOKEN}\n`, { mode: 0o600 });
  await writeFile(webphoneJwtFile, `${WEBPHONE_JWT_SECRET}\n`, { mode: 0o600 });

  const runtime = await loadKamailioConfigRuntime({
    CONVERACT_FABRIC_KAMAILIO_CONFIG_FILE: configFile,
    CONVERACT_FABRIC_KAMAILIO_TOPOH_KEY_FILE: topohFile,
    CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE: rpcFile,
    CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_SECRET_FILE: webphoneJwtFile,
    CONVERACT_FABRIC_KAMAILIO_OUTPUT_FILE: outputFile,
    CONVERACT_FABRIC_KAMAILIO_TLS_OUTPUT_FILE: tlsOutputFile
  });
  assert.equal(runtime.config.cell_id, 'cell-a');
  await writeKamailioConfigRuntime(runtime);

  assert.match(await readFile(outputFile, 'utf8'), /route\[NEW_INVITE\]/);
  assert.doesNotMatch(await readFile(outputFile, 'utf8'), new RegExp(escapeRegExp(WEBPHONE_JWT_SECRET)));
  assert.match(await readFile(tlsOutputFile, 'utf8'), /TLSv1\.2\+/);
  assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
  assert.equal((await stat(tlsOutputFile)).mode & 0o777, 0o600);

  await assert.rejects(
    () => loadKamailioConfigRuntime({
      CONVERACT_FABRIC_KAMAILIO_CONFIG_FILE: configFile,
      CONVERACT_FABRIC_KAMAILIO_TOPOH_KEY_FILE: topohFile,
      CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE: rpcFile,
      CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_SECRET_FILE: webphoneJwtFile,
      CONVERACT_FABRIC_KAMAILIO_OUTPUT_FILE: outputFile,
      CONVERACT_FABRIC_KAMAILIO_TLS_OUTPUT_FILE: tlsOutputFile,
      CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN: RPC_TOKEN,
      CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_SECRET: WEBPHONE_JWT_SECRET
    }),
    /inline.*secret/i
  );
});

test('Kamailio runtime supports host-side rendering into container runtime paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-kamailio-host-render-'));
  const configFile = join(directory, 'config.json');
  const topohFile = join(directory, 'topoh-key');
  const rpcFile = join(directory, 'rpc-token');
  const webphoneJwtFile = join(directory, 'webphone-jwt-secret');
  const outputFile = join(directory, 'kamailio.cfg');
  const tlsOutputFile = join(directory, 'tls.cfg');
  const webphoneRuntimeFile = '/run/secrets/kamailio-webphone-jwt-secret';
  const tlsRuntimeFile = '/etc/kamailio/tls.cfg';
  await writeFile(configFile, JSON.stringify({
    ...baseConfig(),
    webphone_auth: {
      ...baseConfig().webphone_auth,
      jwt_secret_file: webphoneRuntimeFile
    },
    tls_config_file: tlsRuntimeFile
  }), { mode: 0o600 });
  await writeFile(topohFile, `${TOPOH_KEY}\n`, { mode: 0o600 });
  await writeFile(rpcFile, `${RPC_TOKEN}\n`, { mode: 0o600 });
  await writeFile(webphoneJwtFile, `${WEBPHONE_JWT_SECRET}\n`, { mode: 0o600 });

  const runtime = await loadKamailioConfigRuntime({
    CONVERACT_FABRIC_KAMAILIO_CONFIG_FILE: configFile,
    CONVERACT_FABRIC_KAMAILIO_TOPOH_KEY_FILE: topohFile,
    CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE: rpcFile,
    CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_SECRET_FILE: webphoneJwtFile,
    CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_RUNTIME_FILE: webphoneRuntimeFile,
    CONVERACT_FABRIC_KAMAILIO_OUTPUT_FILE: outputFile,
    CONVERACT_FABRIC_KAMAILIO_TLS_OUTPUT_FILE: tlsOutputFile,
    CONVERACT_FABRIC_KAMAILIO_TLS_RUNTIME_FILE: tlsRuntimeFile
  });
  await writeKamailioConfigRuntime(runtime);

  assert.match(await readFile(outputFile, 'utf8'), /\/etc\/kamailio\/tls\.cfg/);
  assert.match(await readFile(outputFile, 'utf8'), /\/run\/secrets\/kamailio-webphone-jwt-secret/);
  assert.match(await readFile(tlsOutputFile, 'utf8'), /TLSv1\.2\+/);
});

test('Kamailio renderer has a file-only CLI and documented deployment contract', async () => {
  const [script, packageJson, envExample, referenceConfig, exampleJson] = await Promise.all([
    readFile(new URL('../scripts/render-kamailio-config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../infra/converact/env.example', import.meta.url), 'utf8'),
    readFile(new URL('../infra/config/kamailio.cfg', import.meta.url), 'utf8'),
    readFile(new URL('../infra/config/kamailio.runtime.example.json', import.meta.url), 'utf8')
  ]);
  assert.match(script, /loadKamailioConfigRuntime/);
  assert.match(script, /writeKamailioConfigRuntime/);
  assert.match(packageJson, /"ivekit:kamailio:render"/);
  for (const name of [
    'CONVERACT_FABRIC_KAMAILIO_CONFIG_FILE',
    'CONVERACT_FABRIC_KAMAILIO_TOPOH_KEY_FILE',
    'CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE',
    'CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_SECRET_FILE',
    'CONVERACT_FABRIC_KAMAILIO_OUTPUT_FILE',
    'CONVERACT_FABRIC_KAMAILIO_TLS_OUTPUT_FILE'
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
    rpc_bearer_token: RPC_TOKEN,
    webphone_jwt_secret: WEBPHONE_JWT_SECRET
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
    rustpbx_source_cidrs: ['10.30.0.0/16'],
    dmq_source_cidrs: ['10.20.0.0/16'],
    allow_public_wss: true,
    webphone_auth: {
      jwt_issuer: 'ivekit',
      jwt_audience: 'rustpbx-webphone',
      jwt_secret_file: '/run/secrets/webphone-jwt-secret',
      allowed_origins: ['https://led.example.com'],
      max_token_bytes: 4096,
      max_registration_expires_seconds: 300
    },
    dmq: {
      enabled: true,
      server_host: '10.20.0.10',
      server_port: 5066,
      notification_addresses: [
        'sip:ivekit-kamailio-0.ivekit-kamailio-headless:5066',
        'sip:ivekit-kamailio-1.ivekit-kamailio-headless:5066'
      ],
      num_workers: 4,
      ping_interval_seconds: 30,
      sync_batch_size: 4000,
      sync_batch_usleep: 1000,
      sync_message_contacts: 50
    },
    sip_trace: {
      enabled: false,
      collector_host: '127.0.0.1',
      collector_port: 9060,
      capture_id: 101,
      include_options: false,
      initial_mode: 'full' as const
    },
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
