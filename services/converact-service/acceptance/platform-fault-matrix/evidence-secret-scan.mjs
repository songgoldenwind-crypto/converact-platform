import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { assertEvidenceArtifactSafe } from './evidence-contract.mjs';

const MAX_ARTIFACTS = 128;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const [manifestPathInput, ...artifactPathInputs] = process.argv.slice(2);

if (!manifestPathInput || artifactPathInputs.length < 1 || artifactPathInputs.length > MAX_ARTIFACTS) {
  throw new Error('evidence_artifact_list_invalid');
}

const manifestPath = resolve(manifestPathInput);
const evidenceDirectory = dirname(manifestPath);
const artifacts = [];
let totalBytes = 0;
for (const artifactPathInput of artifactPathInputs) {
  const artifactPath = resolve(artifactPathInput);
  const name = basename(artifactPath);
  if (dirname(artifactPath) !== evidenceDirectory || artifactPath === manifestPath
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
    throw new Error('evidence_artifact_path_invalid');
  }
  const metadata = lstatSync(artifactPath);
  if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error('evidence_artifact_budget_exceeded');
  }
  totalBytes += metadata.size;
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('evidence_artifact_budget_exceeded');
  const bytes = readFileSync(artifactPath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('evidence_artifact_invalid');
  }
  assertEvidenceArtifactSafe(text);
  artifacts.push({
    name,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
}

artifacts.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
if (new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length) {
  throw new Error('evidence_artifact_list_invalid');
}
writeFileSync(
  manifestPath,
  artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join(''),
  { encoding: 'utf8', flag: 'wx', mode: 0o600 }
);
