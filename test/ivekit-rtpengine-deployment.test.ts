import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

const chartRoot = 'infra/ivekit/helm/rtpengine';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

test('media-control selects RTPengine explicitly and bounds every durable input', () => {
  const runtime = read('scripts/ivekit-media-control-agent.ts');
  const dockerfile = read('infra/ivekit/media-control/Dockerfile');

  assert.match(runtime, /openTransportRuntime\(transportMode, events\)/);
  assert.match(runtime, /mode !== 'rtpengine'/);
  assert.match(runtime, /RtpengineNgClient/);
  assert.match(runtime, /RtpengineMediaTransport\.open/);
  assert.match(runtime, /MediaCommandJournal\.open/);
  for (const name of [
    'IVEKIT_RTPENGINE_NG_ENDPOINT',
    'IVEKIT_RTPENGINE_RUNTIME_MODE',
    'IVEKIT_RTPENGINE_MAX_CONNECTIONS',
    'IVEKIT_RTPENGINE_MAX_IN_FLIGHT',
    'IVEKIT_RTPENGINE_MAX_REQUEST_BYTES',
    'IVEKIT_RTPENGINE_MAX_RESPONSE_BYTES',
    'IVEKIT_RTPENGINE_MAX_QUEUED_BYTES',
    'IVEKIT_MEDIA_CONTROL_WAL_DIRECTORY',
    'IVEKIT_MEDIA_CONTROL_WAL_MAX_RECORDS',
    'IVEKIT_MEDIA_CONTROL_WAL_MAX_BYTES',
    'IVEKIT_MEDIA_CONTROL_WAL_MAX_RECORD_BYTES'
  ]) {
    assert.match(runtime, new RegExp(name));
  }
  assert.match(runtime, /simulator is not production eligible/);
  assert.match(runtime, /await transportRuntime\.close/);
  assert.match(dockerfile, /\/var\/lib\/ivekit-media-control/);
  assert.match(dockerfile, /chown|--chown/);
});

test('Compose runs an independent bounded RTPengine and persistent media-control WAL', () => {
  const compose = parse(
    read('infra/ivekit/docker-compose.voice.yml')
  ) as Record<string, any>;
  const rtpengine = compose.services.rtpengine;
  const validator = compose.services['rtpengine-config-validate'];
  const mediaControl = compose.services['media-control'];

  assert.ok(rtpengine);
  assert.ok(validator);
  assert.equal(validator.user, 'node');
  assert.equal(validator.read_only, true);
  assert.deepEqual(
    validator.tmpfs,
    ['/tmp:size=16m,uid=1000,gid=1000,mode=0700'],
    'the read-only Node preflight needs a writable /tmp for tsx'
  );
  assert.equal(
    rtpengine.depends_on['rtpengine-config-validate'].condition,
    'service_completed_successfully'
  );
  assert.match(rtpengine.image, /\$\{IVEKIT_RTPENGINE_IMAGE:\?/);
  assert.doesNotMatch(rtpengine.image, /:latest\b/);
  assert.deepEqual(rtpengine.profiles, ['voice-media-control']);
  assert.equal(rtpengine.read_only, true);
  assert.deepEqual(rtpengine.cap_drop, ['ALL']);
  assert.equal(rtpengine.ports.length, 1);
  assert.match(rtpengine.ports[0], /\/udp$/);
  assert.doesNotMatch(rtpengine.ports.join(' '), /22222|8080/);
  assert.ok(rtpengine.expose.includes('22222'));
  assert.ok(rtpengine.expose.includes('8080'));
  assert.ok(rtpengine.deploy.resources.limits.cpus);
  assert.ok(rtpengine.deploy.resources.limits.memory);
  assert.ok(rtpengine.deploy.resources.reservations.cpus);
  assert.ok(rtpengine.deploy.resources.reservations.memory);
  assert.equal(
    rtpengine.environment.IVEKIT_RTPENGINE_LISTEN_NG,
    '0.0.0.0:22222'
  );
  assert.equal(
    rtpengine.environment.IVEKIT_RTPENGINE_LISTEN_TCP_NG,
    '0.0.0.0:22222'
  );
  assert.equal(
    rtpengine.environment.IVEKIT_RTPENGINE_MAX_ACTIVE_CALLS,
    '${IVEKIT_RTPENGINE_MAX_ACTIVE_CALLS:-100000}'
  );
  assert.equal(
    rtpengine.environment.IVEKIT_RTPENGINE_GUARD_MAX_ENTRIES,
    '${IVEKIT_RTPENGINE_GUARD_MAX_ENTRIES:-1600000}'
  );
  assert.equal(
    rtpengine.environment.IVEKIT_RTPENGINE_REPLAY_SDP_MAX_BYTES,
    '${IVEKIT_RTPENGINE_REPLAY_SDP_MAX_BYTES:-268435456}'
  );
  assert.equal(
    rtpengine.environment.IVEKIT_RTPENGINE_ACTIVE_CALL_LIMIT,
    undefined
  );
  assert.ok(rtpengine.healthcheck);

  assert.equal(
    mediaControl.environment.IVEKIT_MEDIA_CONTROL_TRANSPORT,
    'rtpengine'
  );
  assert.equal(
    mediaControl.environment.IVEKIT_RTPENGINE_NG_ENDPOINT,
    'tcp://rtpengine:22222'
  );
  assert.equal(
    mediaControl.environment.IVEKIT_MEDIA_CONTROL_WAL_DIRECTORY,
    '/var/lib/ivekit-media-control'
  );
  assert.ok(
    mediaControl.volumes.includes(
      'media-control-wal:/var/lib/ivekit-media-control'
    )
  );
  assert.equal(
    mediaControl.depends_on.rtpengine.condition,
    'service_healthy'
  );
  assert.equal(
    compose.secrets['component-node-token'].file,
    '${OPC_IVEKIT_COMPONENT_NODE_TOKEN_FILE:?OPC_IVEKIT_COMPONENT_NODE_TOKEN_FILE is required}'
  );
  assert.equal(
    compose.secrets['component-node-token'].environment,
    undefined
  );
  assert.match(
    read('infra/ivekit/env.example'),
    /^OPC_IVEKIT_COMPONENT_NODE_TOKEN_FILE=\.\/secrets\/component-node-token$/m
  );
  assert.ok(compose.volumes['media-control-wal']);
  assert.equal(mediaControl.read_only, true);
  assert.equal(mediaControl.ports, undefined);
});

test('Compose preflight rejects mutable images and invalid media ranges', () => {
  const script = 'scripts/ivekit-rtpengine-deployment-preflight.ts';
  const baseEnvironment = {
    ...process.env,
    IVEKIT_RTPENGINE_RUNTIME_MODE: 'userspace',
    IVEKIT_RTPENGINE_INTERFACE: 'public/203.0.113.10',
    IVEKIT_RTPENGINE_PORT_MIN: '23000',
    IVEKIT_RTPENGINE_PORT_MAX: '32768'
  };
  const mutable = spawnSync(
    process.execPath,
    ['--import', 'tsx', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...baseEnvironment,
        IVEKIT_RTPENGINE_IMAGE: 'example/rtpengine:latest'
      }
    }
  );
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /immutable sha256 digest/);

  const reversedRange = spawnSync(
    process.execPath,
    ['--import', 'tsx', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...baseEnvironment,
        IVEKIT_RTPENGINE_IMAGE:
          `example/rtpengine@sha256:${'a'.repeat(64)}`,
        IVEKIT_RTPENGINE_PORT_MIN: '32768',
        IVEKIT_RTPENGINE_PORT_MAX: '23000'
      }
    }
  );
  assert.notEqual(reversedRange.status, 0);
  assert.match(reversedRange.stderr, /media port range/);

  const valid = spawnSync(
    process.execPath,
    ['--import', 'tsx', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...baseEnvironment,
        IVEKIT_RTPENGINE_IMAGE:
          `example/rtpengine@sha256:${'b'.repeat(64)}`
      }
    }
  );
  assert.equal(valid.status, 0, valid.stderr);
});

test('Helm chart deploys digest-only userspace media nodes with private NG control', () => {
  for (const path of [
    'Chart.yaml',
    'values.yaml',
    'values-userspace.yaml',
    'templates/daemonset.yaml',
    'templates/service.yaml',
    'templates/servicemonitor.yaml',
    'templates/pdb.yaml'
  ]) {
    assert.equal(existsSync(`${chartRoot}/${path}`), true, `${path} missing`);
  }
  const values = parse(read(`${chartRoot}/values.yaml`)) as Record<string, any>;
  const userspace = parse(
    read(`${chartRoot}/values-userspace.yaml`)
  ) as Record<string, any>;
  const daemonset = read(`${chartRoot}/templates/daemonset.yaml`);
  const service = read(`${chartRoot}/templates/service.yaml`);

  assert.equal(userspace.runtimeMode, 'userspace');
  assert.ok(values.rtpengine.image.repository);
  assert.equal(values.rtpengine.image.digest, '');
  assert.equal(values.rtpengine.interfaceFromHostIP, true);
  assert.ok(values.mediaControl.image.repository);
  assert.equal(values.mediaControl.image.digest, '');
  assert.ok(Object.keys(values.nodeSelector).length > 0);
  assert.ok(values.tolerations.length > 0);
  assert.ok(values.rtpengine.mediaPorts.minimum >= 1024);
  assert.ok(
    values.rtpengine.mediaPorts.maximum >
      values.rtpengine.mediaPorts.minimum
  );
  assert.ok(values.mediaControl.wal.maxBytes > 0);
  assert.ok(values.mediaControl.wal.hostPath.startsWith('/'));

  assert.match(daemonset, /kind: DaemonSet/);
  assert.match(daemonset, /hostNetwork: true/);
  assert.match(daemonset, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(daemonset, /IVEKIT_RTPENGINE_LISTEN_NG[\s\S]*127\.0\.0\.1:22222/);
  assert.match(
    daemonset,
    /IVEKIT_RTPENGINE_LISTEN_TCP_NG[\s\S]*127\.0\.0\.1:22222/
  );
  assert.match(daemonset, /fieldPath: status\.hostIP/);
  assert.match(daemonset, /IVEKIT_RTPENGINE_PORT_MIN/);
  assert.match(daemonset, /IVEKIT_RTPENGINE_PORT_MAX/);
  assert.match(daemonset, /IVEKIT_MEDIA_CONTROL_WAL_MAX_BYTES/);
  assert.match(daemonset, /readOnlyRootFilesystem: true/);
  assert.match(daemonset, /capabilities:[\s\S]*drop:[\s\S]*ALL/);
  assert.match(daemonset, /preStop:[\s\S]*ivekit-rtpengine-drain/);
  assert.match(daemonset, /hostPath:[\s\S]*media-control-wal/);
  assert.match(daemonset, /terminationGracePeriodSeconds/);
  assert.match(daemonset, /maxUnavailable: 1/);

  assert.match(service, /type: ClusterIP/);
  assert.match(service, /clusterIP: None/);
  assert.doesNotMatch(service, /name: ng|port:\s*22222/);
  assert.match(service, /name: metrics[\s\S]*targetPort: metrics/);
  assert.match(service, /name: media-control[\s\S]*targetPort: media-control/);
});

test('kernel profile fails closed without exact node scope mounts and capabilities', () => {
  const kernel = parse(
    read(`${chartRoot}/values-kernel.yaml`)
  ) as Record<string, any>;
  const daemonset = read(`${chartRoot}/templates/daemonset.yaml`);

  assert.equal(kernel.runtimeMode, 'kernel');
  assert.equal(
    kernel.nodeSelector['ivekit.io/rtpengine-kernel-ready'],
    'true'
  );
  assert.equal(kernel.kernel.hostMounts, true);
  assert.match(daemonset, /runtimeMode must be userspace or kernel/);
  assert.match(daemonset, /kernel mode requires kernel\.hostMounts=true/);
  assert.match(daemonset, /name: host-sys[\s\S]*hostPath:[\s\S]*path: \/sys/);
  assert.match(
    daemonset,
    /name: host-modules[\s\S]*hostPath:[\s\S]*path: \/lib\/modules/
  );
  assert.match(daemonset, /add:[\s\S]*NET_ADMIN/);
  assert.doesNotMatch(daemonset, /privileged: true/);
});

test('Helm disruption and monitoring resources are bounded', () => {
  const pdb = read(`${chartRoot}/templates/pdb.yaml`);
  const monitor = read(`${chartRoot}/templates/servicemonitor.yaml`);

  assert.match(pdb, /kind: PodDisruptionBudget/);
  assert.match(pdb, /maxUnavailable:/);
  assert.match(monitor, /kind: ServiceMonitor/);
  assert.match(monitor, /port: metrics/);
  assert.match(monitor, /interval:/);
  assert.match(monitor, /scrapeTimeout:/);
});
