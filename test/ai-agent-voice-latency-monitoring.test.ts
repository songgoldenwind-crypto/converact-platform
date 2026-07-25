import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(path, 'utf8');

test('AI Agent exposes bounded fail-open voice latency metrics', () => {
  const handler = source('services/ai-agent-py/session_handler.py');
  const metrics = source('services/ai-agent-py/voice_latency_metrics.py');
  const dockerfile = source('services/ai-agent-py/Dockerfile');
  const deployment = source('infra/k8s/templates/ai-agent-deployment.yaml');
  const values = source('infra/k8s/values.yaml');

  assert.match(handler, /extract_voice_latency_observations/);
  assert.match(handler, /record_voice_latency_observations/);
  assert.match(handler, /start_voice_latency_metrics_server/);
  assert.match(handler, /prometheus_port=prometheus_port\(\)/);
  assert.doesNotMatch(handler, /prometheus_multiproc_dir/);

  assert.match(metrics, /opc_ai_voice_stage_latency_seconds/);
  assert.match(metrics, /opc_ai_voice_latency_budget_exceeded_total/);
  assert.doesNotMatch(metrics, /tenant_id|call_session_id|speech_id|room_name/);

  assert.match(deployment, /name: AI_AGENT_VOICE_METRICS_UDP_HOST/);
  assert.match(deployment, /name: AI_AGENT_VOICE_METRICS_UDP_PORT/);
  assert.match(deployment, /name: metrics[\s\S]*containerPort:/);
  assert.doesNotMatch(deployment, /PROMETHEUS_MULTIPROC_DIR|prometheus-multiprocess/);
  assert.match(deployment, /kind: Service[\s\S]*name: metrics/);
  assert.match(deployment, /kind: ServiceMonitor[\s\S]*path: \/metrics/);
  assert.match(values, /^    port: 9090$/m);
  assert.match(values, /^    udpPort: 9125$/m);
  assert.match(values, /^      enabled: false$/m);

  assert.match(dockerfile, /^USER ai-agent$/m);
  assert.match(deployment, /runAsNonRoot: true/);
  assert.match(deployment, /runAsUser: 10001/);
  assert.match(deployment, /readOnlyRootFilesystem: true/);
  assert.match(deployment, /allowPrivilegeEscalation: false/);
});

test('AI Agent monitoring defines the five latency budget alerts', () => {
  const deployment = source('infra/k8s/templates/ai-agent-deployment.yaml');
  const values = source('infra/k8s/values.yaml');

  for (const stage of [
    'asr_final',
    'end_of_turn',
    'llm_first_token',
    'tts_first_audio',
    'speech_to_speech'
  ]) {
    assert.match(values, new RegExp(`^      ${stage}:`, 'm'));
  }
  assert.match(deployment, /kind: PrometheusRule/);
  assert.match(deployment, /range \$stage, \$budget := \.Values\.aiAgent\.metrics\.latencyBudgetsSeconds/);
  assert.match(deployment, /stage="{{ \$stage }}"/);
  assert.match(deployment, /opc_ai_voice_stage_latency_seconds_bucket/);
});

test('Compose monitoring scrapes AI Agent metrics without publishing another host port', () => {
  const compose = source('docker-compose.callcenter.yml');
  const production = source('infra/docker-compose.production.yml');
  const prometheus = source('config/prometheus.yml');
  const alerts = source('config/alert-rules.yml');

  for (const manifest of [compose, production]) {
    assert.match(manifest, /AI_AGENT_PROMETHEUS_PORT: \$\{AI_AGENT_PROMETHEUS_PORT:-9090\}/);
    assert.match(manifest, /AI_AGENT_VOICE_METRICS_UDP_HOST: 127\.0\.0\.1/);
    assert.match(manifest, /AI_AGENT_VOICE_METRICS_UDP_PORT: \$\{AI_AGENT_VOICE_METRICS_UDP_PORT:-9125\}/);
    assert.doesNotMatch(manifest, /PROMETHEUS_MULTIPROC_DIR/);
  }
  assert.match(prometheus, /job_name: 'ai-agent'[\s\S]*ai-agent:9090/);
  assert.match(alerts, /opc_ai_voice_stage_latency_seconds_bucket/);
});

test('AI Agent provider fallback policy is deployed and observable', () => {
  const handler = source('services/ai-agent-py/session_handler.py');
  const metrics = source('services/ai-agent-py/voice_latency_metrics.py');
  const compose = source('docker-compose.callcenter.yml');
  const production = source('infra/docker-compose.production.yml');
  const deployment = source('infra/k8s/templates/ai-agent-deployment.yaml');
  const values = source('infra/k8s/values.yaml');
  const alerts = source('config/alert-rules.yml');

  assert.match(handler, /conn_options=build_session_connect_options\(\)/);
  assert.match(metrics, /opc_ai_voice_provider_transitions_total/);

  for (const manifest of [compose, production]) {
    for (const name of [
      'LLM_FALLBACK_PROVIDERS',
      'SPEECH_ASR_FALLBACK_PROVIDERS',
      'SPEECH_TTS_FALLBACK_PROVIDERS',
      'AI_AGENT_STT_ATTEMPT_TIMEOUT_MS',
      'AI_AGENT_LLM_ATTEMPT_TIMEOUT_MS',
      'AI_AGENT_TTS_ATTEMPT_TIMEOUT_MS',
      'AI_AGENT_MAX_UNRECOVERABLE_PROVIDER_ERRORS'
    ]) {
      assert.match(manifest, new RegExp(`${name}:`));
    }
  }

  assert.match(values, /^  providerRuntime:$/m);
  assert.match(values, /^    llmFallbackProviders:/m);
  assert.match(values, /^    sttAttemptTimeoutMs: 2000$/m);
  assert.match(values, /^    llmAttemptTimeoutMs: 1200$/m);
  assert.match(values, /^    ttsAttemptTimeoutMs: 1500$/m);
  assert.match(deployment, /name: LLM_FALLBACK_PROVIDERS/);
  assert.match(deployment, /name: AI_AGENT_MAX_UNRECOVERABLE_PROVIDER_ERRORS/);
  assert.equal(
    (deployment.match(/optional: true/g) || []).length,
    5,
    'each Provider key must be independently optional'
  );

  assert.match(alerts, /opc_ai_voice_provider_transitions_total\{state="unavailable"\}/);
  assert.match(deployment, /opc_ai_voice_provider_transitions_total\{state="unavailable"\}/);
});
