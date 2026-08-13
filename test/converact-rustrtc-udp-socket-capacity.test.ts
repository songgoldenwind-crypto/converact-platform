import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const BUILD = 'infra/converact/rustpbx/build.sh';
const DEPENDENCY_PATCH =
  'infra/converact/rustpbx/patches/rustpbx-local-rustrtc.patch';
const SOCKET_PATCH =
  'infra/converact/rustpbx/patches/rustrtc-ivekit-udp-socket-capacity.patch';

test('RustPBX build pins and patches the rustrtc media transport source', () => {
  const build = readFileSync(BUILD, 'utf8');
  const dependencyPatch = readFileSync(DEPENDENCY_PATCH, 'utf8');
  const socketPatch = readFileSync(SOCKET_PATCH, 'utf8');

  assert.match(
    build,
    /RUSTRTC_COMMIT="166c6d22984429eb6b509920c14fcd69f974f0b3"/
  );
  assert.match(
    build,
    /git clone[\s\S]*https:\/\/github\.com\/restsend\/rustrtc\.git[\s\S]*"\$BUILD_ROOT\/rustrtc"/
  );
  assert.match(
    build,
    /clone_pinned_source \\\n+\s+rustrtc \\\n+\s+"\$RUSTRTC_COMMIT"/
  );
  assert.match(build, /checkout --detach "\$expected_commit"/);
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustrtc" apply --check "\$PATCH_DIR\/rustrtc-ivekit-udp-socket-capacity\.patch"/
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --check "\$PATCH_DIR\/rustpbx-local-rustrtc\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.76"/);

  assert.match(dependencyPatch, /\[patch\.crates-io\]/);
  assert.match(dependencyPatch, /rustrtc = \{ path = "\.\.\/rustrtc" \}/);
  assert.match(socketPatch, /socket2 = "=0\.6\.5"/);
  assert.match(socketPatch, /udp_receive_buffer_size/);
  assert.match(socketPatch, /udp_send_buffer_size/);
  assert.match(socketPatch, /set_recv_buffer_size/);
  assert.match(socketPatch, /set_send_buffer_size/);
  assert.match(socketPatch, /configured_udp_buffers_are_applied_to_rtp_sockets/);
});

test('RustPBX media documentation states socket-buffer memory and evidence limits', () => {
  const readme = readFileSync('infra/converact/rustpbx/README.md', 'utf8');

  assert.match(readme, /RUSTRTC_UDP_RECEIVE_BUFFER_BYTES/);
  assert.match(readme, /RUSTRTC_UDP_SEND_BUFFER_BYTES/);
  assert.match(readme, /not pre-allocated/i);
  assert.match(readme, /independent load generator/i);
});

test('Compose and Helm expose bounded rustrtc socket buffers to every RustPBX node', () => {
  for (const path of [
    'infra/capacity/rustpbx-baseline/docker-compose.yml',
    'infra/docker-compose.production.yml',
    'services/converact-service/docker-compose.voice.yml',
    'infra/k8s/templates/rustpbx-deployment.yaml',
    'services/converact-service/helm/converact/templates/rustpbx-deployment.yaml'
  ]) {
    const deployment = readFileSync(path, 'utf8');
    assert.match(deployment, /RUSTRTC_UDP_RECEIVE_BUFFER_BYTES/, path);
    assert.match(deployment, /RUSTRTC_UDP_SEND_BUFFER_BYTES/, path);
  }

  for (const path of [
    'infra/k8s/values.yaml',
    'services/converact-service/helm/converact/values.yaml'
  ]) {
    const values = readFileSync(path, 'utf8');
    assert.match(values, /udpReceiveBufferBytes: 1048576/, path);
    assert.match(values, /udpSendBufferBytes: 524288/, path);
  }
});
