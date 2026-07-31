import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = 'services/converact-service/acceptance/realtime-recovery';
const FILES = {
  compose: `${ROOT}/docker-compose.yml`,
  shell: `${ROOT}/accept.sh`,
  probe: `${ROOT}/probe.ts`,
  gateway: `${ROOT}/gateway-child.ts`,
  transport: `${ROOT}/transport_probe.py`
};

test('realtime recovery acceptance is a declared reproducible entrypoint', () => {
  for (const file of Object.values(FILES)) {
    assert.equal(existsSync(file), true, `missing realtime recovery artifact: ${file}`);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts['ivekit:realtime-recovery-acceptance'],
    'sh services/converact-service/acceptance/realtime-recovery/accept.sh'
  );
});

test('realtime recovery PostgreSQL topology is isolated and immutable', () => {
  const compose = read(FILES.compose);
  assert.match(compose, /POSTGRES_IMAGE immutable digest reference is required/);
  assert.match(compose, /127\.0\.0\.1:\$\{POSTGRES_HOST_PORT/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /name: \$\{COMPOSE_PROJECT_NAME:-ivekit-realtime-recovery\}-network/);
  assert.match(compose, /name: \$\{COMPOSE_PROJECT_NAME:-ivekit-realtime-recovery\}-data/);
  assert.doesNotMatch(compose, /led-platform|external:\s*true/);
});

test('recovery probes exercise production projection, gateway, and transport code', () => {
  const probe = read(FILES.probe);
  const gateway = read(FILES.gateway);
  const transport = read(FILES.transport);

  assert.match(probe, /RealtimeSpeechStore/);
  assert.match(probe, /RealtimeSpeechProjection/);
  assert.match(probe, /RealtimeSpeechProjectionDispatcher/);
  assert.match(probe, /initPostgres/);
  assert.match(probe, /closePostgres/);
  assert.doesNotMatch(probe, /from ['"]pg['"]/);
  assert.match(probe, /projection\.retrying/);
  assert.match(probe, /actual_postgresql_process_outage: true/);
  assert.match(probe, /validation_resources_remaining/);
  assert.match(probe, /led_containers_unchanged/);
  assert.match(probe, /transport_network_internal/);
  assert.match(probe, /EXPECTED_LED_CONTAINER_COUNT/);
  assert.match(probe, /readResourceReport/);
  assert.doesNotMatch(probe, /validation_resources_remaining: 0/);

  assert.match(gateway, /LiveKitRealtimeAudioTapGateway/);
  assert.match(gateway, /createLiveKitRealtimeAudioTapTokenCodec/);
  assert.match(gateway, /process\.pid/);
  assert.match(gateway, /isIP/);
  assert.match(gateway, /mode: 0o600/);
  assert.match(gateway, /RUN_ID/);
  assert.match(gateway, /GATEWAY_READY_FILE/);
  assert.match(gateway, /GATEWAY_HOST/);

  assert.match(transport, /create_livekit_audio_tap_sink_factory/);
  assert.match(transport, /authorize_livekit_audio_tap/);
  assert.match(transport, /gateway_process_restarted/);
  assert.match(transport, /actual_gateway_process_restart/);
  assert.match(transport, /transport_module_path/);
  assert.match(transport, /transport_source_sha256/);
  assert.match(transport, /EXPECTED_TRANSPORT_SHA256/);
});

test('server acceptance injects both process outages and always removes resources', () => {
  const shell = read(FILES.shell);
  assert.match(shell, /^#!\/bin\/sh\nset -eu/);
  assert.match(shell, /trap cleanup EXIT HUP INT TERM/);
  assert.match(shell, /wait_pid_bounded/);
  assert.match(shell, /kill -KILL/);
  assert.match(shell, /tail --pid/);
  assert.doesNotMatch(shell, /watchdog=/);
  assert.match(shell, /timeout -k/);
  assert.match(shell, /node_bounded/);
  assert.match(shell, /AbortSignal\.timeout/);
  assert.match(shell, /compose stop postgres/);
  assert.match(shell, /wait_postgres_host/);
  assert.match(shell, /SELECT 1/);
  assert.match(shell, /POSTGRES_RETRY_MARKER/);
  assert.match(shell, /wait_file_or_process/);
  assert.match(shell, /postgres-probe\.log/);
  assert.match(shell, /kill_gateway/);
  assert.match(shell, /GATEWAY_RETRY_MARKER/);
  assert.match(shell, /docker run --rm/);
  assert.doesNotMatch(shell, /--network host/);
  assert.match(shell, /network create --internal/);
  assert.match(shell, /\.Internal/);
  assert.match(shell, /--network "\$VALIDATION_NETWORK"/);
  assert.match(shell, /--workdir \/workspace/);
  assert.match(shell, /PYTHONPATH=\/workspace:\/test-deps/);
  assert.match(shell, /EXPECTED_TRANSPORT_SHA256/);
  assert.match(shell, /--read-only/);
  assert.match(shell, /chmod 0711/);
  assert.match(shell, /chown 10001:10001/);
  assert.doesNotMatch(shell, /chmod 0777/);
  assert.match(shell, /HOST_STATE_DIR/);
  assert.match(shell, /TRANSPORT_STATE_DIR/);
  assert.match(shell, /GATEWAY_SHARED_DIR/);
  assert.match(shell, /CONTROL_DIR/);
  assert.match(shell, /\/gateway-evidence:ro/);
  assert.match(shell, /\/control:ro/);
  assert.match(shell, /POSTGRES_HOST_PORT=\$\{POSTGRES_HOST_PORT:-\}/);
  assert.match(shell, /reserve_loopback_port/);
  assert.match(shell, /MAX_PORT_BIND_ATTEMPTS=3/);
  assert.match(shell, /POSTGRES_PUBLISHED_PORT=/);
  assert.doesNotMatch(shell, /^POSTGRES_HOST_PORT=\$\(compose port/m);
  assert.match(shell, /PostgreSQL published port changed across restart/);
  assert.match(shell, /GATEWAY_PORT=\$\{GATEWAY_PORT:-0\}/);
  assert.match(shell, /snapshot_led/);
  assert.match(shell, /validation-resources/);
  assert.match(shell, /compose down --volumes --remove-orphans/);
  assert.match(shell, /verification_scope=controlled_server_process_recovery/);
  assert.doesNotMatch(shell, /docker (?:stop|kill|rm)[^\n]*led-platform/);
});

function read(path: string): string {
  return readFileSync(path, 'utf8');
}
