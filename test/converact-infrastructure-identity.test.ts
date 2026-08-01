import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const workflowDir = '.github/workflows';

test('active workflows and named infrastructure files use Converact identities', () => {
  const workflowNames = readdirSync(workflowDir).sort();
  assert.equal(workflowNames.some((name) => name.startsWith('ivekit-')), false);
  for (const expected of [
    'converact-capacity-ci.yml',
    'converact-core-images.yml',
    'converact-oci-release-gate.yml',
    'converact-stage2-ci.yml'
  ]) {
    assert.equal(workflowNames.includes(expected), true, `missing ${expected}`);
  }

  for (const path of [
    'config/grafana/provisioning/dashboards/converact.yml',
    'config/ivr/converact_m1.toml',
    'infra/k8s/templates/converact-deployment.yaml',
    'integrations/n8n/converact-manifest.json',
    'public/widget/converact-chat-widget.js'
  ]) {
    assert.equal(existsSync(path), true, `missing ${path}`);
  }

  for (const path of [
    'config/grafana/provisioning/dashboards/opc.yml',
    'config/ivr/opc_m1.toml',
    'infra/k8s/templates/opc-deployment.yaml',
    'integrations/n8n/opc-manifest.json',
    'public/widget/opc-chat-widget.js'
  ]) {
    assert.equal(existsSync(path), false, `legacy active path remains: ${path}`);
  }
});

test('Helm and new OCI metadata use Converact product and repository names', () => {
  const chart = readFileSync('infra/k8s/Chart.yaml', 'utf8');
  const values = readFileSync('infra/k8s/values.yaml', 'utf8');
  const helpers = readFileSync('infra/k8s/templates/_helpers.tpl', 'utf8');
  const deployment = readFileSync(
    'infra/k8s/templates/converact-deployment.yaml',
    'utf8'
  );

  assert.match(chart, /^name: converact-platform$/m);
  assert.match(chart, /Converact Platform/);
  assert.match(values, /^converact:$/m);
  assert.doesNotMatch(values, /^opc:$/m);
  assert.match(values, /ghcr\.io\/songgoldenwind-crypto\/converact-/);
  assert.doesNotMatch(values, /ghcr\.io\/songgoldenwind-crypto\/opc-/);
  assert.match(helpers, /define "converact\.platformImage"/);
  assert.doesNotMatch(helpers, /define "opc\./);
  assert.match(deployment, /app\.kubernetes\.io\/name: converact/);
  assert.match(deployment, /include "converact\.platformImage"/);
});

test('public integration artifacts expose the Converact brand', () => {
  const dashboard = readFileSync(
    'config/grafana/provisioning/dashboards/converact.yml',
    'utf8'
  );
  const ivr = readFileSync('config/ivr/converact_m1.toml', 'utf8');
  const manifest = readFileSync('integrations/n8n/converact-manifest.json', 'utf8');
  const widget = readFileSync('public/widget/converact-chat-widget.js', 'utf8');

  assert.match(dashboard, /Converact/);
  assert.match(ivr, /Converact/);
  assert.match(manifest, /Converact/);
  assert.match(widget, /Converact/);
});
