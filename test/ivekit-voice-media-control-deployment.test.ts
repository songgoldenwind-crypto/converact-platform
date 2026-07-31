import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const dockerfile = readFileSync(
  'infra/converact/media-control/Dockerfile',
  'utf8'
);
const voiceMediaDockerfile = readFileSync(
  'infra/converact/voice-media/Dockerfile',
  'utf8'
);
const entrypoint = readFileSync(
  'scripts/ivekit-media-control-agent.ts',
  'utf8'
);
const compose = parse(
  readFileSync('infra/converact/docker-compose.voice.yml', 'utf8')
) as Record<string, any>;

describe('iveKit media control deployment', () => {
  it('runs as non-root with a pinned base and deterministic entrypoint', () => {
    assert.match(dockerfile, /^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/m);
    assert.match(dockerfile, /^USER node:node$/m);
    assert.match(
      dockerfile,
      /LABEL org\.opencontainers\.image\.revision="\$\{CONVERACT_SOURCE_COMMIT\}"/
    );
    assert.equal(
      compose.services['media-control'].build.args.CONVERACT_SOURCE_COMMIT,
      '${CONVERACT_SOURCE_COMMIT:-unknown}'
    );
    assert.match(
      dockerfile,
      /ENTRYPOINT \["node", "--import", "tsx", "scripts\/ivekit-media-control-agent\.ts"\]/
    );
    assert.doesNotMatch(dockerfile, /\b(latest|curl|wget)\b/);
  });

  it('keeps the service private, read-only, capability-free, and health checked', () => {
    const service = compose.services['media-control'];
    assert.ok(service);
    assert.deepEqual(service.profiles, ['voice-media-control']);
    assert.equal(service.network_mode, 'service:rustpbx');
    assert.equal(service.read_only, true);
    assert.equal(service.user, 'node');
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
    assert.equal(service.ports, undefined);
    assert.ok(service.healthcheck);
    assert.match(
      compose.services['rustpbx-component-node'].healthcheck.test.join(' '),
      /\/operationalz/
    );
    assert.doesNotMatch(
      compose.services['rustpbx-component-node'].healthcheck.test.join(' '),
      /\/readyz|\/livez/
    );
  });

  it('builds the processing pool from a locked Rust graph and runs it unprivileged', () => {
    const service = compose.services['voice-media-processing'];
    assert.match(
      voiceMediaDockerfile,
      /^FROM rust:1\.94-bookworm@sha256:[a-f0-9]{64} AS builder$/m
    );
    assert.match(voiceMediaDockerfile, /cargo build --locked --release/);
    assert.match(
      voiceMediaDockerfile,
      /^FROM debian:bookworm-slim@sha256:[a-f0-9]{64}$/m
    );
    assert.match(voiceMediaDockerfile, /^USER 10001:10001$/m);
    assert.equal(service.network_mode, 'service:rustpbx');
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
    assert.equal(service.ports, undefined);
    assert.ok(service.healthcheck);
    assert.ok(service.deploy.resources.limits.cpus);
    assert.ok(service.deploy.resources.limits.memory);
    assert.equal(
      service.environment.VOICE_MEDIA_RTP_PORT_START,
      '${IVEKIT_PROCESSING_MEDIA_RTP_PORT_START:-40000}'
    );
    assert.equal(
      service.environment.VOICE_MEDIA_RTP_PORT_END,
      '${IVEKIT_PROCESSING_MEDIA_RTP_PORT_END:-59998}'
    );
  });

  it('keeps component leases alive through the Cell admission leader', () => {
    const service = compose.services['cell-admission'];
    assert.ok(service);
    assert.deepEqual(
      service.profiles,
      ['voice-capacity', 'voice-media-control', 'voice-t1']
    );
    assert.deepEqual(service.command, [
      'node',
      '--import',
      'tsx',
      'scripts/ivekit-cell-admission.ts'
    ]);
    assert.equal(service.user, 'node');
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
    assert.equal(service.ports, undefined);
    assert.deepEqual(service.expose, ['3200']);
    assert.equal(
      service.environment.CONVERACT_FABRIC_CELL_NODES_JSON,
      '${IVEKIT_CELL_NODES_JSON:-${RUSTPBX_CELL_NODES_JSON:?RUSTPBX_CELL_NODES_JSON is required}}'
    );
    assert.equal(
      service.environment.CONVERACT_FABRIC_COMPONENT_NODE_TOKEN,
      '${CONVERACT_FABRIC_COMPONENT_NODE_TOKEN:?CONVERACT_FABRIC_COMPONENT_NODE_TOKEN is required}'
    );
    assert.match(service.healthcheck.test.join(' '), /\/readyz/);
    assert.equal(
      service.depends_on['rustpbx-component-node'].condition,
      'service_started'
    );
    assert.equal(
      compose.services['media-control'].depends_on['cell-admission'].condition,
      'service_started'
    );
  });

  it('uses the production hybrid media router with mTLS and loopback internals', () => {
    const service = compose.services['media-control'];
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_PRODUCTION,
      'true'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_TRANSPORT,
      'hybrid'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_REQUIRE_MTLS,
      'true'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_ADMISSION_REQUIRE_MTLS,
      'false'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_ADMISSION_ENDPOINT,
      'http://127.0.0.1:3210'
    );
    assert.equal(
      compose.services['rustpbx-component-node']
        .environment.CONVERACT_FABRIC_COMPONENT_NODE_REQUIRE_MTLS,
      'false'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_REQUIRE_PRODUCTION_TRANSPORT,
      undefined
    );
    assert.match(
      entrypoint,
      /simulator is not production eligible/
    );
    assert.match(
      entrypoint,
      /if \(production && transportMode === 'simulator'\)/
    );
    assert.doesNotMatch(
      entrypoint,
      /IVEKIT_MEDIA_CONTROL_REQUIRE_PRODUCTION_TRANSPORT/
    );
    assert.match(
      entrypoint,
      /IVEKIT_MEDIA_CONTROL_TLS_KEY_FILE/
    );
    assert.match(
      entrypoint,
      /IVEKIT_MEDIA_CONTROL_TLS_CERT_FILE/
    );
    assert.match(
      entrypoint,
      /IVEKIT_MEDIA_CONTROL_TLS_CA_FILE/
    );
    assert.match(
      entrypoint,
      /IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_CA_FILE/
    );
    assert.match(
      entrypoint,
      /production admission without mTLS must use loopback HTTP/
    );
    assert.match(entrypoint, /isLoopbackHttpEndpoint/);
    assert.match(
      entrypoint,
      /mediaControlAdmissionReady\(state\)/
    );
    assert.doesNotMatch(
      entrypoint,
      /state\.state === '(?:accepting|degraded)'/
    );
  });

  it('enables the complete RustPBX dependency chain for the media-control profile', () => {
    for (const serviceName of [
      'rustpbx-config-render',
      'rustpbx-route-snapshot',
      'rustpbx',
      'rustpbx-component-node',
      'cell-admission',
      'rtpengine',
      'voice-media-processing',
      'media-control'
    ]) {
      assert.ok(
        compose.services[serviceName].profiles.includes('voice-media-control'),
        `${serviceName} must join the voice-media-control profile`
      );
    }
  });
});
