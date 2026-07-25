import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const dockerfile = readFileSync(
  'infra/ivekit/media-control/Dockerfile',
  'utf8'
);
const entrypoint = readFileSync(
  'scripts/ivekit-media-control-agent.ts',
  'utf8'
);
const compose = parse(
  readFileSync('infra/ivekit/docker-compose.voice.yml', 'utf8')
) as Record<string, any>;

describe('iveKit media control deployment', () => {
  it('runs as non-root with a pinned base and deterministic entrypoint', () => {
    assert.match(dockerfile, /^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/m);
    assert.match(dockerfile, /^USER node:node$/m);
    assert.match(
      dockerfile,
      /LABEL org\.opencontainers\.image\.revision="\$\{OPC_SOURCE_COMMIT\}"/
    );
    assert.equal(
      compose.services['media-control'].build.args.OPC_SOURCE_COMMIT,
      '${OPC_SOURCE_COMMIT:-unknown}'
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
      /\/livez/
    );
    assert.doesNotMatch(
      compose.services['rustpbx-component-node'].healthcheck.test.join(' '),
      /\/readyz/
    );
  });

  it('makes simulator acceptance explicit and rejects simulator production startup', () => {
    const service = compose.services['media-control'];
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_PRODUCTION,
      'false'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_TRANSPORT,
      'simulator'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_REQUIRE_MTLS,
      'false'
    );
    assert.equal(
      service.environment.IVEKIT_MEDIA_CONTROL_ADMISSION_REQUIRE_MTLS,
      'false'
    );
    assert.equal(
      compose.services['rustpbx-component-node']
        .environment.OPC_IVEKIT_COMPONENT_NODE_REQUIRE_MTLS,
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
      /state\.lease_fresh[\s\S]*!state\.recovery_pending/
    );
  });

  it('enables the complete RustPBX dependency chain for the media-control profile', () => {
    for (const serviceName of [
      'rustpbx-config-render',
      'rustpbx-route-snapshot',
      'rustpbx',
      'rustpbx-component-node',
      'media-control'
    ]) {
      assert.ok(
        compose.services[serviceName].profiles.includes('voice-media-control'),
        `${serviceName} must join the voice-media-control profile`
      );
    }
  });
});
