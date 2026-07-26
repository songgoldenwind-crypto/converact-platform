import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderKamailioConfig,
  type KamailioConfig
} from '../src/agent-runtime/ivekit/voice/kamailio-config.js';

const SECRETS = {
  topoh_mask_key: 'ivekit-topology-mask-key-1234567890abcdef',
  rpc_bearer_token: 'ivekit-kamailio-rpc-token-1234567890abcdef',
  webphone_jwt_secret: 'ivekit-webphone-jwt-secret-1234567890abcdef'
};

test('in-dialog routing uses original owner first and deterministic recovery set on outage', () => {
  const route = withinDialog(renderKamailioConfig(config(), SECRETS).kamailio_cfg);

  assert.match(route, /\$var\(previous_pinset\) = \$var\(pinset\)/);
  assert.match(route, /ds_select_dst\("\$var\(pinset\)", "0", "1"\)/);
  assert.match(
    route,
    /\$var\(recoveryset\) = \$var\(previous_pinset\) \+ 1000000000/
  );
  assert.match(route, /ds_select_dst\("\$var\(recoveryset\)", "0", "3"\)/);
  assert.match(route, /X-IveKit-Recovery: 1/);
  assert.match(route, /X-IveKit-Previous-Pin-Set: \$var\(previous_pinset\)/);
  assert.match(route, /X-IveKit-Previous-Cell-Epoch: \$var\(pin_epoch\)/);
  assert.match(route, /X-IveKit-Recovery-Set: \$var\(recoveryset\)/);
  assert.match(route, /\$avp\(ivekit_recovery_attempt\) = 1/);
  assert.match(route, /t_on_failure\("DIALOG_RECOVERY_FAILOVER"\)/);
  assert.match(route, /sl_send_reply\("503", "Dialog Recovery Unavailable"\)/);
});

test('dialog recovery retries only bounded transient failures and preserves recovery identity', () => {
  const cfg = renderKamailioConfig(config(), SECRETS).kamailio_cfg;
  const route = failureRoute(cfg, 'DIALOG_RECOVERY_FAILOVER');

  assert.match(route, /t_is_canceled\(\)/);
  assert.match(route, /t_check_status\("408\|500\|502\|503\|504"\)/);
  assert.match(route, /\$avp\(ivekit_recovery_attempt\) >= 3/);
  assert.match(route, /ds_next_dst\(\)/);
  assert.match(route, /\$avp\(ivekit_recovery_attempt\) = \$avp\(ivekit_recovery_attempt\) \+ 1/);
  assert.match(route, /route\(READ_DISPATCHER_OWNER\)/);
  assert.match(route, /route\(INTERNAL_HEADERS\)/);
  assert.match(route, /t_on_failure\("DIALOG_RECOVERY_FAILOVER"\)/);
  assert.match(route, /t_reply\("503", "Dialog Recovery Unavailable"\)/);
  assert.doesNotMatch(route, /remove_hf\("X-IveKit-Recovery"\)/);
  assert.doesNotMatch(route, /481/);
});

test('epoch routing never maps owner outage or old epoch directly to 481', () => {
  const cfg = renderKamailioConfig(config(), SECRETS).kamailio_cfg;
  const route = withinDialog(cfg);

  assert.match(route, /\$var\(pin_epoch\) > 7/);
  assert.match(route, /sl_send_reply\("503", "Dialog Epoch Coordinator Stale"\)/);
  assert.match(
    route,
    /\$var\(pin_epoch\) == 7[\s\S]*?route\(RELAY\);[\s\S]*?\$var\(recoveryset\) =/
  );
  assert.doesNotMatch(route, /481", "Invalid Dialog Owner/);
  assert.doesNotMatch(route, /481", "Dialog Owner Unavailable/);
  assert.equal(
    [...route.matchAll(/sl_send_reply\("481"/g)].length,
    1,
    'only a structurally missing dialog route may be rejected before recovery'
  );
});

test('external recovery headers are stripped before trusted headers are recreated', () => {
  const cfg = renderKamailioConfig(config(), SECRETS).kamailio_cfg;

  for (const header of [
    'X-IveKit-Recovery',
    'X-IveKit-Previous-Pin-Set',
    'X-IveKit-Previous-Cell-Epoch',
    'X-IveKit-Recovery-Set'
  ]) {
    assert.match(cfg, new RegExp(`remove_hf\\("${header}"\\)`));
  }
});

function withinDialog(cfg: string): string {
  return cfg.slice(
    cfg.indexOf('route[WITHINDLG]'),
    cfg.indexOf('route[PRELOADED_ROUTE]')
  );
}

function failureRoute(cfg: string, name: string): string {
  const start = cfg.indexOf(`failure_route[${name}]`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = cfg.indexOf('\nfailure_route[', start + 1);
  return cfg.slice(start, next === -1 ? cfg.length : next);
}

function config(): KamailioConfig {
  return {
    schema_version: '1.0.0',
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
    trusted_source_cidrs: ['10.20.0.0/16'],
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
      sync_batch_size: 4_000,
      sync_batch_usleep: 1_000,
      sync_message_contacts: 50
    },
    sip_trace: {
      enabled: false,
      collector_host: '127.0.0.1',
      collector_port: 9060,
      capture_id: 101,
      include_options: false,
      initial_mode: 'full'
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
