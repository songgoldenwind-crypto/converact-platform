import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const chartRoot = 'services/ivekit-service/helm/ivekit';

test('iveKit Prometheus rules cover shared foundation failure domains with unique alerts', () => {
  const document = parse(readFileSync(`${chartRoot}/files/prometheus-rules.yaml`, 'utf8')) as {
    groups: Array<{ name: string; rules: Array<{ alert: string; expr: string; for: string }> }>;
  };
  const rules = document.groups.flatMap((group) => group.rules);
  const names = rules.map((rule) => rule.alert);
  assert.equal(new Set(names).size, names.length);
  for (const required of [
    'IveKitApiUnavailable',
    'IveKitNotificationQueueStalled',
    'IveKitEventWebhookLag',
    'IveKitEventWebhookFailures',
    'IveKitNotificationDeadLetters',
    'IveKitNotificationProviderUnhealthy',
    'IveKitTinodeDeliveryLag',
    'IveKitIntelligenceRouteExhausted',
    'IveKitMediaPacketLossHigh',
    'IveKitVoiceCommandUncertain',
    'IveKitRealtimeAudioTapFailure',
    'IveKitRealtimeAudioTapDroppingAudio',
    'IveKitRealtimeAudioTapReplayAttempt',
    'IveKitRetentionFailure'
  ]) assert.equal(names.includes(required), true, required);
  assert.equal(rules.every((rule) => Boolean(rule.expr) && Boolean(rule.for)), true);
});

test('iveKit Grafana dashboard is importable and uses only bounded shared metrics', () => {
  const dashboard = JSON.parse(
    readFileSync(`${chartRoot}/files/grafana-dashboard.json`, 'utf8')
  ) as {
    uid: string;
    title: string;
    panels: Array<{ title: string; targets?: Array<{ expr?: string }> }>;
  };
  assert.equal(dashboard.uid, 'ivekit-shared-foundation');
  assert.match(dashboard.title, /iveKit Shared Foundation/);
  assert.equal(dashboard.panels.length >= 10, true);
  const expressions = dashboard.panels.flatMap((panel) =>
    (panel.targets || []).map((target) => String(target.expr || ''))
  ).join('\n');
  for (const metric of [
    'opc_http_requests_total',
    'opc_ivekit_notification_queue_depth',
    'opc_ivekit_tinode_delivery_queue_lag_seconds',
    'opc_ivekit_media_qos_packet_loss_ratio_bucket',
    'opc_ivekit_voice_uncertain_commands_total',
    'opc_ivekit_voice_audio_tap_events_total',
    'opc_ivekit_voice_audio_tap_dropped_seconds_total',
    'opc_ivekit_event_webhook_oldest_event_age_seconds',
    'ivekit_kamailio_snapshot_valid',
    'ivekit_kamailio_new_call_nodes',
    'ivekit_kamailio_core_metrics_up',
    'kamailio_core_ivekit_dispatch_failures',
    'kamailio_core_ivekit_pin_failures'
  ]) assert.match(expressions, new RegExp(metric));
  assert.doesNotMatch(expressions, /tenant_id|notification_id|session_id|user_id/);
});

test('Helm monitoring resources are opt-in and scrape the authenticated-neutral metrics path', () => {
  const values = parse(readFileSync(`${chartRoot}/values.yaml`, 'utf8')) as any;
  const serviceMonitor = readFileSync(`${chartRoot}/templates/service-monitor.yaml`, 'utf8');
  const service = readFileSync(`${chartRoot}/templates/service.yaml`, 'utf8');
  const prometheusRule = readFileSync(`${chartRoot}/templates/prometheus-rule.yaml`, 'utf8');
  const dashboard = readFileSync(`${chartRoot}/templates/grafana-dashboard.yaml`, 'utf8');

  assert.equal(values.monitoring.serviceMonitor.enabled, false);
  assert.equal(values.monitoring.prometheusRule.enabled, false);
  assert.equal(values.monitoring.grafanaDashboard.enabled, false);
  assert.match(serviceMonitor, /path: \/metrics/);
  assert.match(serviceMonitor, /\.Values\.monitoring\.serviceMonitor\.enabled/);
  const serviceMetadata = service.slice(service.indexOf('metadata:'), service.indexOf('spec:'));
  assert.match(serviceMetadata, /app\.kubernetes\.io\/component: api/);
  assert.match(prometheusRule, /\.Files\.Get "files\/prometheus-rules\.yaml"/);
  assert.match(dashboard, /\.Files\.Get "files\/grafana-dashboard\.json"/);
});
