import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const standaloneValues = readFileSync(
  'services/ivekit-service/helm/ivekit/values.yaml',
  'utf8'
);
const aiProfile = readFileSync(
  'services/ivekit-service/helm/ivekit/profiles/ai.values.yaml',
  'utf8'
);
const standaloneDeployment = readFileSync(
  'services/ivekit-service/helm/ivekit/templates/deployment.yaml',
  'utf8'
);
const standaloneService = readFileSync(
  'services/ivekit-service/helm/ivekit/templates/service.yaml',
  'utf8'
);
const standaloneNetworkPolicy = readFileSync(
  'services/ivekit-service/helm/ivekit/templates/realtime-audio-tap-network-policy.yaml',
  'utf8'
);
const standaloneRustPbx = readFileSync(
  'services/ivekit-service/helm/ivekit/templates/rustpbx-deployment.yaml',
  'utf8'
);
const platformValues = readFileSync('infra/k8s/values.yaml', 'utf8');
const platformDeployment = readFileSync(
  'infra/k8s/templates/opc-deployment.yaml',
  'utf8'
);
const platformNetworkPolicy = readFileSync(
  'infra/k8s/templates/realtime-audio-tap-network-policy.yaml',
  'utf8'
);
const platformRustPbx = readFileSync(
  'infra/k8s/templates/rustpbx-deployment.yaml',
  'utf8'
);
const standaloneVoiceCompose = readFileSync(
  'services/ivekit-service/docker-compose.voice.yml',
  'utf8'
);
const standaloneCompose = readFileSync(
  'services/ivekit-service/docker-compose.yml',
  'utf8'
);
const platformCompose = readFileSync(
  'infra/docker-compose.production.yml',
  'utf8'
);

test('standalone chart enables the tap only through the explicit AI profile', () => {
  assert.match(
    standaloneValues,
    /realtimeAudioTap:\n\s+enabled: false/
  );
  assert.match(aiProfile, /deploymentProfiles:\n[\s\S]*\s+ai: true/);
  assert.match(aiProfile, /realtimeAudioTap:\n\s+enabled: true/);
  assert.match(
    standaloneValues,
    /realtimeAudioTapHmacSecretKey: realtime-audio-tap-hmac-secret-b64/
  );
});

test('standalone chart binds one-time tokens to the issuing API Pod', () => {
  assertPodBoundGateway(standaloneDeployment, '%s-audio-tap.%s.svc');
  assertHeadlessAudioTapService(standaloneService);
  assertRestrictedAudioTapIngress(standaloneNetworkPolicy);
});

test('full platform chart preserves the same Pod-bound gateway contract', () => {
  assert.match(
    platformValues,
    /realtimeAudioTap:\n\s+enabled: false\n\s+hmacSecretB64: ""/
  );
  assertPodBoundGateway(platformDeployment, '%s-opc-audio-tap.%s.svc');
  assertHeadlessAudioTapService(platformDeployment);
  assertRestrictedAudioTapIngress(platformNetworkPolicy);
});

test('single-instance Compose keeps the gateway private to its service network', () => {
  assert.match(
    standaloneCompose,
    /OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL: \$\{OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL:-ws:\/\/ivekit:3010\/api\/ivekit\/realtime-audio-tap\/livekit\}/
  );
  assert.match(
    platformCompose,
    /OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL: \$\{OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL:-ws:\/\/opc:3010\/api\/ivekit\/realtime-audio-tap\/livekit\}/
  );
  assert.doesNotMatch(standaloneCompose, /3010:3010/);
  assert.doesNotMatch(platformCompose, /3010:3010/);
});

test('Compose mounts the same private UDS volume into RustPBX and the API gateway', () => {
  assertRustPbxComposeTap(standaloneVoiceCompose);
  assertRustPbxComposeTap(platformCompose);
});

test('Kubernetes co-locates a dedicated RustPBX gateway sidecar with the media process', () => {
  assertRustPbxSidecar(standaloneRustPbx);
  assertRustPbxSidecar(platformRustPbx);
  assert.match(
    standaloneDeployment,
    /OPC_IVEKIT_RUSTPBX_AUDIO_TAP_GATEWAY_ENABLED\n\s+value: "0"/
  );
  assert.match(
    platformDeployment,
    /OPC_IVEKIT_RUSTPBX_AUDIO_TAP_GATEWAY_ENABLED\n\s+value: "0"/
  );
});

test('deployment surfaces bounded realtime projection recovery controls', () => {
  for (const values of [standaloneValues, platformValues]) {
    assert.match(values, /projectionQueueMaxItems: "4096"/);
    assert.match(values, /projectionShutdownTimeoutMs: "1000"/);
  }
  for (const deployment of [
    standaloneDeployment,
    standaloneRustPbx,
    platformDeployment,
    platformRustPbx
  ]) {
    assert.match(
      deployment,
      /OPC_IVEKIT_REALTIME_PROJECTION_QUEUE_MAX_ITEMS[\s\S]*projectionQueueMaxItems/
    );
    assert.match(
      deployment,
      /OPC_IVEKIT_REALTIME_PROJECTION_SHUTDOWN_TIMEOUT_MS[\s\S]*projectionShutdownTimeoutMs/
    );
  }
  for (const compose of [standaloneCompose, platformCompose]) {
    assert.match(
      compose,
      /OPC_IVEKIT_REALTIME_PROJECTION_QUEUE_MAX_ITEMS: \$\{OPC_IVEKIT_REALTIME_PROJECTION_QUEUE_MAX_ITEMS:-4096\}/
    );
    assert.match(
      compose,
      /OPC_IVEKIT_REALTIME_PROJECTION_SHUTDOWN_TIMEOUT_MS: \$\{OPC_IVEKIT_REALTIME_PROJECTION_SHUTDOWN_TIMEOUT_MS:-1000\}/
    );
  }
});

function assertPodBoundGateway(source: string, headlessDnsPattern: string): void {
  assert.match(
    source,
    /- name: OPC_IVEKIT_LIVEKIT_AUDIO_TAP_INSTANCE_ID\n\s+valueFrom:\n\s+fieldRef:\n\s+fieldPath: metadata.name/
  );
  assert.match(
    source,
    new RegExp(
      `OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL[\\s\\S]*ws:\\/\\/\\$\\(POD_NAME\\)\\.${escapeRegex(headlessDnsPattern)}`
    )
  );
  assert.match(
    source,
    /OPC_IVEKIT_REALTIME_AUDIO_TAP_HMAC_SECRET_B64[\s\S]*secretKeyRef:/
  );
}

function assertHeadlessAudioTapService(source: string): void {
  assert.match(
    source,
    /kind: Service[\s\S]*audio-tap[\s\S]*clusterIP: None[\s\S]*targetPort: audio-tap/
  );
}

function assertRestrictedAudioTapIngress(source: string): void {
  assert.match(source, /kind: NetworkPolicy/);
  assert.match(
    source,
    /podSelector:[\s\S]*(?:ai-agent|realtimeAudioTap\.networkPolicy\.aiAgentPodSelector)/
  );
  assert.match(source, /port: audio-tap/);
  assert.doesNotMatch(source, /0\.0\.0\.0\/0/);
}

function assertRustPbxComposeTap(source: string): void {
  const rustPbx = source.match(
    /^  rustpbx:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|^volumes:)/m
  )?.[0] || '';
  assert.match(
    source,
    /RUSTPBX_REALTIME_AUDIO_TAP_SOCKET_PATH: \/run\/ivekit\/realtime-audio-tap\.sock/
  );
  assert.match(rustPbx, /realtime_audio_tap:\/run\/ivekit/);
}

function assertRustPbxSidecar(source: string): void {
  assert.match(source, /- name: realtime-audio-tap-gateway/);
  assert.match(
    source,
    /command: \["node", (?:"dist\/ivekit-realtime-audio-tap-worker\.js"|"--import", "tsx", "src\/ivekit-realtime-audio-tap-worker\.ts")\]/
  );
  assert.match(
    source,
    /OPC_IVEKIT_RUSTPBX_AUDIO_TAP_GATEWAY_ENABLED\n\s+value: "1"/
  );
  assert.match(
    source,
    /OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_ENABLED\n\s+value: "0"/
  );
  const mounts = source.match(/name: realtime-audio-tap/g) || [];
  assert.ok(mounts.length >= 3, 'RustPBX, gateway, and Pod must share the UDS volume');
  assert.match(
    source,
    /name: realtime-audio-tap\n\s+emptyDir:\n\s+medium: Memory/
  );
  assert.match(
    source,
    /readinessProbe:\n\s+exec:\n\s+command:[\s\S]*test[\s\S]*-S[\s\S]*realtime-audio-tap\.sock/
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
