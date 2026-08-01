import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error('identity_output_required');
const output = resolve(outputArgument);
const imageDigests = JSON.parse(requiredText('CONVERACT_G02_IMAGE_DIGESTS_JSON'));
if (!Array.isArray(imageDigests) || imageDigests.length < 1 || imageDigests.length > 32
  || !imageDigests.every((item) => IMAGE.test(String(item)))) {
  throw new Error('identity_image_digests_invalid');
}
const identity = {
  goal_id: 'G02',
  goal_sha256: '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9',
  source_commit: required('CONVERACT_G02_SOURCE_COMMIT', COMMIT),
  config_sha256: required('CONVERACT_G02_CONFIG_SHA256', SHA256),
  raw_output_sha256: required('CONVERACT_G02_RAW_OUTPUT_SHA256', SHA256),
  image_digests: imageDigests,
  node_binary_sha256: required('CONVERACT_G02_NODE_BINARY_SHA256', SHA256),
  node_version: required('CONVERACT_G02_NODE_VERSION', /^v24\.\d+\.\d+$/u),
  host: required('CONVERACT_G02_HOST', TOKEN),
  hardware: requiredText('CONVERACT_G02_HARDWARE'),
  clock: requiredText('CONVERACT_G02_CLOCK'),
  workload: requiredText('CONVERACT_G02_WORKLOAD'),
  seed: required('CONVERACT_G02_SEED', TOKEN),
  started_at: requiredTimestamp('CONVERACT_G02_STARTED_AT'),
  completed_at: new Date().toISOString()
};
writeFileSync(output, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

function required(name, pattern) {
  const value = requiredText(name);
  if (!pattern.test(value)) throw new Error(`${name.toLowerCase()}_invalid`);
  return value;
}

function requiredText(name) {
  const value = String(process.env[name] || '');
  if (value.length < 1 || value.length > 2048 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name.toLowerCase()}_invalid`);
  return value;
}

function requiredTimestamp(name) {
  const value = requiredText(name);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${name.toLowerCase()}_invalid`);
  }
  return value;
}
