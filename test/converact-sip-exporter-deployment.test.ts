import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const chartRoot = 'services/converact-service/helm/converact';

test('SIP exporter is an opt-in off-path node observer with bounded labels', () => {
  const values = parse(readFileSync(`${chartRoot}/values.yaml`, 'utf8')) as any;
  const template = readFileSync(`${chartRoot}/templates/sip-exporter.yaml`, 'utf8');

  assert.equal(values.monitoring.sipExporter.enabled, false);
  assert.equal(values.monitoring.sipExporter.rtpCapture, true);
  assert.equal(values.monitoring.sipExporter.hostLabels, false);
  assert.equal(values.monitoring.sipExporter.telemetry, false);
  assert.equal(values.monitoring.sipExporter.image.digest, '');
  assert.match(template, /kind: DaemonSet/);
  assert.match(template, /hostNetwork: true/);
  assert.match(template, /SIP_EXPORTER_RTP_CAPTURE/);
  assert.match(template, /SIP_EXPORTER_HOST_LABELS/);
  assert.match(template, /SIP_EXPORTER_TELEMETRY/);
  assert.match(template, /capabilities:[\s\S]*BPF[\s\S]*NET_ADMIN[\s\S]*NET_RAW/);
  assert.doesNotMatch(template, /privileged: true/);
});

test('SIP exporter chart requires an immutable image, interface, and node scope', () => {
  const helpers = readFileSync(`${chartRoot}/templates/_helpers.tpl`, 'utf8');
  const template = readFileSync(`${chartRoot}/templates/sip-exporter.yaml`, 'utf8');

  assert.match(helpers, /define "converact\.sipExporterImage"/);
  assert.match(helpers, /monitoring\.sipExporter\.image\.digest must be an immutable sha256 digest/);
  assert.match(template, /monitoring\.sipExporter\.interface is required/);
  assert.match(template, /monitoring\.sipExporter\.nodeSelector must select only voice nodes/);
  assert.match(template, /app\.kubernetes\.io\/component: sip-exporter/);
});
