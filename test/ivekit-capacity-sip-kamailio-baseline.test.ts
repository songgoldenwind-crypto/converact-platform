import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

const ROOT = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('RustPBX capacity baseline drives SIP through the real Kamailio edge', async () => {
  const compose = YAML.parse(await source(
    'infra/capacity/rustpbx-baseline/docker-compose.yml'
  )) as {
    services: Record<string, Record<string, unknown>>;
  };
  const kamailio = compose.services.kamailio;

  assert.ok(kamailio);
  assert.match(String(kamailio.image), /KAMAILIO_IMAGE/);
  assert.equal(kamailio.read_only, true);
  assert.deepEqual(kamailio.cap_drop, ['ALL']);
  assert.deepEqual(kamailio.security_opt, ['no-new-privileges:true']);
  assert.equal(
    ((kamailio.networks as Record<string, { ipv4_address: string }>).baseline).ipv4_address,
    '172.30.44.9'
  );
  assert.match(JSON.stringify(kamailio.volumes), /kamailio\.cfg/);
  assert.match(JSON.stringify(kamailio.volumes), /dispatcher\.list/);
  assert.deepEqual(kamailio.command, [
    '-DD',
    '-E',
    '-x',
    '${KAMAILIO_SHM_ALLOCATOR:?KAMAILIO_SHM_ALLOCATOR is required}',
    '-m',
    '${KAMAILIO_SHM_MEMORY_MB:?KAMAILIO_SHM_MEMORY_MB is required}',
    '-M',
    '${KAMAILIO_PKG_MEMORY_MB:?KAMAILIO_PKG_MEMORY_MB is required}',
    '-f',
    '/etc/kamailio/kamailio.cfg'
  ]);

  const bootstrap = compose.services.bootstrap;
  assert.equal(
    (bootstrap.environment as Record<string, string>).RUSTPBX_ACCEPTANCE_UAC_IP,
    '${RUSTPBX_ACCEPTANCE_TRUNK_IP:-172.30.44.20}'
  );
});

test('capacity runtime preparation pins Kamailio and creates file-backed secrets only', async () => {
  const prepare = await source('infra/capacity/rustpbx-baseline/prepare.py');

  assert.match(prepare, /"KAMAILIO_IMAGE": required_image\("KAMAILIO_IMAGE", False\)/);
  assert.match(prepare, /KAMAILIO_TOPOH_KEY_FILE/);
  assert.match(prepare, /KAMAILIO_RPC_TOKEN_FILE/);
  assert.match(prepare, /KAMAILIO_WEBPHONE_JWT_SECRET_FILE/);
  assert.match(prepare, /KAMAILIO_TLS_KEY_FILE/);
  assert.match(prepare, /KAMAILIO_TLS_CERT_FILE/);
  assert.match(prepare, /KAMAILIO_TLS_CA_FILE/);
  assert.match(prepare, /KAMAILIO_SHM_MEMORY_MB/);
  assert.match(prepare, /KAMAILIO_PKG_MEMORY_MB/);
  assert.match(prepare, /KAMAILIO_SHM_ALLOCATOR/);
  assert.match(prepare, /\{"fm", "qm", "tlsf"\}/);
  assert.match(prepare, /bounded_integer/);
  assert.doesNotMatch(prepare, /KAMAILIO_TOPOH_KEY=/);
  assert.doesNotMatch(prepare, /KAMAILIO_RPC_TOKEN=/);
  assert.doesNotMatch(prepare, /KAMAILIO_WEBPHONE_JWT_SECRET=/);
});

test('capacity runner renders Kamailio, targets the edge and records RTT plus core metrics', async () => {
  const runner = await source('infra/capacity/rustpbx-baseline/run.sh');

  assert.match(runner, /IVEKIT_CAPACITY_INCLUDE_KAMAILIO/);
  assert.match(runner, /IVEKIT_CAPACITY_RUN_ID/);
  assert.match(runner, /IVEKIT_SIP_TARGET_IP/);
  assert.match(runner, /src\/ivekit-kamailio-compose-config\.ts/);
  assert.match(runner, /scripts\/render-kamailio-config\.ts/);
  assert.match(runner, /wait_for_sip_route/);
  assert.match(runner, /-cid_str/);
  assert.match(runner, /-trace_rtt/);
  assert.match(runner, /kamailio-metrics-before\.txt/);
  assert.match(runner, /kamailio-metrics-after\.txt/);
  assert.match(runner, /kamailio_script_ivekit_new_invites/);
  assert.match(runner, /kamailio_error_log_lines/);
  assert.match(runner, /sip_route_p95_ms/);
  assert.match(runner, /sip_route_p99_ms/);
});

test('capacity rejection scenario emits one timer and transaction-correct non-2xx ACK per call', async () => {
  const scenario = await source(
    'services/ivekit-service/acceptance/sipp/inbound-reject-486-uac.xml'
  );

  assert.match(scenario, /start_rtd="sip_route"/);
  assert.match(scenario, /rtd="sip_route"/);
  assert.match(scenario, /<send retrans="500" start_rtd="sip_route" start_txn="invite">/);
  assert.match(scenario, /<recv response="100" optional="true" response_txn="invite" \/>/);
  assert.match(scenario, /<recv response="486" rtd="sip_route" response_txn="invite" \/>/);
  assert.match(
    scenario,
    /<send retrans="500" ack_txn="invite">[\s\S]*?branch=\[branch-3\][\s\S]*?CSeq: 1 ACK/
  );
  assert.match(scenario, /start_txn="invite"[\s\S]*?branch=\[branch\][\s\S]*?CSeq: 1 INVITE/);
  assert.doesNotMatch(scenario, /branch=z9hG4bK-ivekit-\[pid\]-\[call_number\]/);
});
