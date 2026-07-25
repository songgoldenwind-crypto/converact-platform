import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

import { resolveTelemetryConfig } from '../src/telemetry.js';

test('OpenTelemetry is explicit, trace-only, bounded and secret-safe', () => {
  assert.deepEqual(resolveTelemetryConfig({}, 'ivekit-api'), {
    enabled: false,
    service_name: 'ivekit-api',
    endpoint: '',
    sample_ratio: 0.1,
    max_queue_size: 2048,
    max_export_batch_size: 256,
    scheduled_delay_ms: 5000,
    export_timeout_ms: 3000
  });

  assert.throws(() => resolveTelemetryConfig({
    OPC_OTEL_ENABLED: '1'
  }, 'ivekit-api'), /OPC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required/);
  assert.throws(() => resolveTelemetryConfig({
    OPC_OTEL_ENABLED: '1',
    OPC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://user:secret@example.com/v1/traces'
  }, 'ivekit-api'), /must not contain credentials/);
  assert.throws(() => resolveTelemetryConfig({
    OPC_OTEL_ENABLED: '1',
    OPC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel.example.com/v1/traces',
    OPC_OTEL_TRACE_SAMPLE_RATIO: '1.1'
  }, 'ivekit-api'), /between 0 and 1/);
  assert.throws(() => resolveTelemetryConfig({
    OPC_OTEL_ENABLED: '1',
    OPC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel.example.com/v1/traces',
    OPC_OTEL_MAX_QUEUE_SIZE: '128',
    OPC_OTEL_MAX_EXPORT_BATCH_SIZE: '256'
  }, 'ivekit-api'), /batch size must not exceed queue size/);

  const enabled = resolveTelemetryConfig({
    OPC_OTEL_ENABLED: '1',
    OPC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://ivekit-otel-collector:4318/v1/traces',
    OPC_OTEL_TRACE_SAMPLE_RATIO: '0.25',
    OPC_OTEL_MAX_QUEUE_SIZE: '4096',
    OPC_OTEL_MAX_EXPORT_BATCH_SIZE: '512',
    OPC_OTEL_EXPORT_TIMEOUT_MS: '2000'
  }, 'ivekit-worker');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.service_name, 'ivekit-worker');
  assert.equal(enabled.sample_ratio, 0.25);
  assert.equal(enabled.max_queue_size, 4096);
  assert.equal(enabled.max_export_batch_size, 512);
  assert.equal(enabled.export_timeout_ms, 2000);
});

test('OpenTelemetry dependencies are exact and limited to selected instrumentations', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.equal(root.dependencies['@opentelemetry/api'], '1.9.1');

  for (const path of ['package.json', 'services/ivekit-service/package.json']) {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@opentelemetry/sdk-node'], '0.220.0');
    assert.equal(pkg.dependencies['@opentelemetry/sdk-trace-base'], '2.9.0');
    assert.equal(pkg.dependencies['@opentelemetry/resources'], '2.9.0');
    assert.equal(pkg.dependencies['@opentelemetry/exporter-trace-otlp-http'], '0.220.0');
    assert.equal(pkg.dependencies['@opentelemetry/instrumentation-http'], '0.220.0');
    assert.equal(pkg.dependencies['@opentelemetry/instrumentation-pg'], '0.72.0');
    assert.equal(pkg.dependencies['@opentelemetry/instrumentation-undici'], '0.30.0');
    assert.equal(pkg.dependencies['@opentelemetry/auto-instrumentations-node'], undefined);
    assert.equal(pkg.dependencies['@opentelemetry/exporter-metrics-otlp-http'], undefined);
  }

  const service = JSON.parse(
    readFileSync('services/ivekit-service/package.json', 'utf8')
  ) as { dependencies: Record<string, string> };
  assert.equal(service.dependencies['@opentelemetry/api'], undefined);
});

test('iveKit workloads preload trace SDK only when telemetry is enabled', () => {
  const values = readFileSync('services/ivekit-service/helm/ivekit/values.yaml', 'utf8');
  const api = readFileSync(
    'services/ivekit-service/helm/ivekit/templates/deployment.yaml',
    'utf8'
  );
  const notification = readFileSync(
    'services/ivekit-service/helm/ivekit/templates/notification-worker.yaml',
    'utf8'
  );
  const pools = readFileSync(
    'services/ivekit-service/helm/ivekit/templates/async-worker-pools.yaml',
    'utf8'
  );

  assert.match(values, /telemetry:\n  enabled: false/);
  assert.match(values, /maxQueueSize: "2048"/);
  assert.match(values, /maxExportBatchSize: "256"/);
  for (const template of [api, notification, pools]) {
    assert.match(template, /--import/);
    assert.match(template, /dist\/telemetry\.js/);
    assert.match(template, /OPC_OTEL_ENABLED/);
    assert.match(template, /OPC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
    assert.doesNotMatch(template, /OTEL_METRICS_EXPORTER/);
  }
});

test('Collector gateway is bounded, trace-only and isolated from communication authority', () => {
  const root = 'infra/platform/observability/otel-collector';
  for (const file of [
    'kustomization.yaml', 'configmap.yaml', 'deployment.yaml', 'service.yaml',
    'pdb.yaml', 'network-policy.yaml', 'README.md'
  ]) {
    assert.equal(existsSync(`${root}/${file}`), true, `missing ${file}`);
  }
  const config = readFileSync(`${root}/configmap.yaml`, 'utf8');
  const deployment = readFileSync(`${root}/deployment.yaml`, 'utf8');
  const network = readFileSync(`${root}/network-policy.yaml`, 'utf8');
  const manifest = parse(config) as { data: { 'collector.yaml': string } };
  const collector = parse(manifest.data['collector.yaml']) as {
    service: { pipelines: Record<string, unknown> };
  };

  assert.match(config, /otlp:[\s\S]*grpc:[\s\S]*http:/);
  assert.match(config, /memory_limiter:/);
  assert.match(config, /attributes\/privacy:/);
  assert.match(config, /batch:/);
  assert.match(config, /sending_queue:[\s\S]*queue_size:/);
  assert.match(config, /retry_on_failure:[\s\S]*max_elapsed_time:/);
  assert.match(config, /traces:[\s\S]*receivers:[\s\S]*processors:[\s\S]*exporters:/);
  assert.deepEqual(Object.keys(collector.service.pipelines), ['traces']);
  assert.match(deployment, /replicas: 2/);
  assert.match(deployment, /opentelemetry-collector-contrib@sha256:[a-f0-9]{64}/);
  assert.match(deployment, /readOnlyRootFilesystem: true/);
  assert.match(deployment, /topologySpreadConstraints:/);
  assert.match(network, /kind: NetworkPolicy/);
  assert.doesNotMatch(deployment, /hostNetwork: true/);
});
