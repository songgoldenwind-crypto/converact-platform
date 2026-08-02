import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REPLAY_KEYS = [
  'schema_id',
  'schema_version',
  'wire_sha256',
  'wire_length_bytes',
  'parse_status',
  'message_kind',
  'method_or_status',
  'request_uri_sha256',
  'header_names',
  'header_value_sha256',
  'body_length_bytes',
  'body_sha256',
  'reserialized_sha256',
  'parser_error_class'
] as const;

export interface WireCorpusCase {
  readonly id: string;
  readonly file: string;
  readonly method_or_status: string;
  readonly expected_disposition: 'accept' | 'reject';
  readonly byte_length: number;
  readonly sha256: string;
}

export interface WireCorpusManifest {
  readonly contract_id: 'converact-wire-freeze-corpus-manifest-v1';
  readonly version: '1.0.0';
  readonly cases: readonly WireCorpusCase[];
}

export interface WireReplayRecord {
  readonly schema_id: 'converact-rsipstack-wire-replay-v1';
  readonly schema_version: '1.0.0';
  readonly wire_sha256: string;
  readonly wire_length_bytes: number;
  readonly parse_status: 'accept' | 'reject';
  readonly message_kind: 'request' | 'response' | null;
  readonly method_or_status: string | null;
  readonly request_uri_sha256: string | null;
  readonly header_names: readonly string[];
  readonly header_value_sha256: readonly string[];
  readonly body_length_bytes: number | null;
  readonly body_sha256: string | null;
  readonly reserialized_sha256: string | null;
  readonly parser_error_class: 'parse_error' | null;
}

export interface WireDifferentialIdentity {
  readonly generated_at: string;
  readonly source_commit: string;
  readonly rsipstack_commit: string;
  readonly baseline_patchset: string;
  readonly current_patchset: string;
  readonly baseline_binary_sha256: string;
  readonly current_binary_sha256: string;
  readonly patch_set_sha256: string;
}

export interface WireDifferentialReport {
  readonly schema_id: 'converact-g03-wire-differential-v1';
  readonly schema_version: '1.0.0';
  readonly status: 'passed';
  readonly identity: WireDifferentialIdentity;
  readonly compatibility_policy: {
    readonly accepted_semantics: 'must_be_identical';
    readonly malformed_tightening: 'explicit_versioned_decision_only';
    readonly security_decision_id: 'G03-WIRE-SECURITY-001';
    readonly target_rvoip_status: 'not_run';
  };
  readonly summary: {
    readonly total_cases: number;
    readonly current_matches_contract: number;
    readonly unchanged_accepted_semantics: number;
    readonly security_tightenings: number;
    readonly unexplained_differences: 0;
  };
  readonly cases: readonly {
    readonly id: string;
    readonly expected_disposition: 'accept' | 'reject';
    readonly baseline: WireReplayRecord;
    readonly current: WireReplayRecord;
    readonly compatibility_decision_id: 'G03-WIRE-SECURITY-001' | null;
  }[];
}

export function buildWireDifferential(input: {
  readonly manifest: WireCorpusManifest;
  readonly baseline_records: readonly WireReplayRecord[];
  readonly current_records: readonly WireReplayRecord[];
  readonly identity: WireDifferentialIdentity;
}): WireDifferentialReport {
  validateManifest(input.manifest);
  validateIdentity(input.identity);
  if (input.baseline_records.length !== input.manifest.cases.length ||
      input.current_records.length !== input.manifest.cases.length) {
    throw new Error('wire replay record count does not match the corpus');
  }

  let unchangedAcceptedSemantics = 0;
  let securityTightenings = 0;
  const cases = input.manifest.cases.map((corpusCase, index) => {
    const baseline = validateReplayRecord(input.baseline_records[index], corpusCase);
    const current = validateReplayRecord(input.current_records[index], corpusCase);
    assertCurrentContract(current, corpusCase);

    let compatibilityDecisionId: 'G03-WIRE-SECURITY-001' | null = null;
    if (corpusCase.expected_disposition === 'accept') {
      if (baseline.parse_status !== 'accept' || current.parse_status !== 'accept' ||
          !sameAcceptedSemantics(baseline, current)) {
        throw new Error(`accepted semantic drift for ${corpusCase.id}`);
      }
      unchangedAcceptedSemantics += 1;
    } else if (baseline.parse_status === 'accept' && current.parse_status === 'reject') {
      compatibilityDecisionId = 'G03-WIRE-SECURITY-001';
      securityTightenings += 1;
    } else if (baseline.parse_status !== current.parse_status) {
      throw new Error(`unexplained malformed differential for ${corpusCase.id}`);
    }

    return Object.freeze({
      id: corpusCase.id,
      expected_disposition: corpusCase.expected_disposition,
      baseline,
      current,
      compatibility_decision_id: compatibilityDecisionId
    });
  });

  return Object.freeze({
    schema_id: 'converact-g03-wire-differential-v1',
    schema_version: '1.0.0',
    status: 'passed',
    identity: Object.freeze({ ...input.identity }),
    compatibility_policy: Object.freeze({
      accepted_semantics: 'must_be_identical',
      malformed_tightening: 'explicit_versioned_decision_only',
      security_decision_id: 'G03-WIRE-SECURITY-001',
      target_rvoip_status: 'not_run'
    }),
    summary: Object.freeze({
      total_cases: cases.length,
      current_matches_contract: cases.length,
      unchanged_accepted_semantics: unchangedAcceptedSemantics,
      security_tightenings: securityTightenings,
      unexplained_differences: 0 as const
    }),
    cases: Object.freeze(cases)
  });
}

export function replayWireCorpus(
  manifest: WireCorpusManifest,
  manifestPath: string,
  binaryPath: string
): readonly WireReplayRecord[] {
  validateManifest(manifest);
  const corpusRoot = resolve(manifestPath, '..');
  return manifest.cases.map((corpusCase) => {
    const wirePath = resolve(corpusRoot, corpusCase.file);
    const pathFromRoot = relative(corpusRoot, wirePath);
    if (!pathFromRoot || pathFromRoot.startsWith('..') || resolve(wirePath) !== wirePath) {
      throw new Error(`wire corpus path escapes the manifest root: ${corpusCase.id}`);
    }
    const wire = readFileSync(wirePath);
    if (wire.byteLength !== corpusCase.byte_length || sha256(wire) !== corpusCase.sha256) {
      throw new Error(`wire corpus identity mismatch for ${corpusCase.id}`);
    }
    const run = spawnSync(binaryPath, [wirePath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      shell: false
    });
    if (run.status !== 0 || run.signal !== null || run.stderr !== '') {
      throw new Error(`wire replay binary failed for ${corpusCase.id}`);
    }
    const lines = run.stdout.trim().split('\n');
    if (lines.length !== 1 || lines[0] === '') {
      throw new Error(`wire replay binary emitted invalid output for ${corpusCase.id}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[0]!);
    } catch {
      throw new Error(`wire replay binary emitted invalid JSON for ${corpusCase.id}`);
    }
    return validateReplayRecord(parsed, corpusCase);
  });
}

function validateReplayRecord(
  value: unknown,
  corpusCase: WireCorpusCase
): WireReplayRecord {
  if (!isRecord(value) ||
      !sameKeys(value, REPLAY_KEYS) ||
      value.schema_id !== 'converact-rsipstack-wire-replay-v1' ||
      value.schema_version !== '1.0.0' ||
      value.wire_sha256 !== corpusCase.sha256 ||
      value.wire_length_bytes !== corpusCase.byte_length ||
      !['accept', 'reject'].includes(String(value.parse_status)) ||
      !Array.isArray(value.header_names) ||
      !value.header_names.every((name) =>
        typeof name === 'string' && /^[a-z0-9.!%*+_`'~-]+$/.test(name)
      ) ||
      !Array.isArray(value.header_value_sha256) ||
      !value.header_value_sha256.every(isSha256) ||
      value.header_names.length !== value.header_value_sha256.length) {
    throw new Error(`invalid wire replay record for ${corpusCase.id}`);
  }
  if (value.parse_status === 'accept') {
    if (!['request', 'response'].includes(String(value.message_kind)) ||
        typeof value.method_or_status !== 'string' ||
        value.method_or_status.length < 1 ||
        (value.request_uri_sha256 !== null && !isSha256(value.request_uri_sha256)) ||
        !Number.isSafeInteger(value.body_length_bytes) || Number(value.body_length_bytes) < 0 ||
        !isSha256(value.body_sha256) ||
        !isSha256(value.reserialized_sha256) ||
        value.parser_error_class !== null) {
      throw new Error(`invalid accepted replay record for ${corpusCase.id}`);
    }
  } else if (value.message_kind !== null ||
             value.method_or_status !== null ||
             value.request_uri_sha256 !== null ||
             value.header_names.length !== 0 ||
             value.body_length_bytes !== null ||
             value.body_sha256 !== null ||
             value.reserialized_sha256 !== null ||
             value.parser_error_class !== 'parse_error') {
    throw new Error(`invalid rejected replay record for ${corpusCase.id}`);
  }
  return Object.freeze(value as unknown as WireReplayRecord);
}

function assertCurrentContract(record: WireReplayRecord, corpusCase: WireCorpusCase): void {
  if (record.parse_status !== corpusCase.expected_disposition) {
    throw new Error(`current adapter disposition mismatch for ${corpusCase.id}`);
  }
  if (record.parse_status === 'accept' &&
      record.method_or_status !== corpusCase.method_or_status) {
    throw new Error(`current adapter method/status mismatch for ${corpusCase.id}`);
  }
}

function sameAcceptedSemantics(left: WireReplayRecord, right: WireReplayRecord): boolean {
  const semanticKeys = [
    'message_kind',
    'method_or_status',
    'request_uri_sha256',
    'header_names',
    'header_value_sha256',
    'body_length_bytes',
    'body_sha256',
    'reserialized_sha256'
  ] as const;
  return semanticKeys.every((key) =>
    JSON.stringify(left[key]) === JSON.stringify(right[key])
  );
}

function validateManifest(manifest: WireCorpusManifest): void {
  if (manifest.contract_id !== 'converact-wire-freeze-corpus-manifest-v1' ||
      manifest.version !== '1.0.0' ||
      !Array.isArray(manifest.cases) || manifest.cases.length < 1) {
    throw new Error('wire corpus manifest is invalid');
  }
  const ids = new Set<string>();
  for (const corpusCase of manifest.cases) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(corpusCase.id) ||
        ids.has(corpusCase.id) ||
        !/^wire-corpus\/[a-z0-9][a-z0-9-]*\.sip$/.test(corpusCase.file) ||
        !['accept', 'reject'].includes(corpusCase.expected_disposition) ||
        !Number.isSafeInteger(corpusCase.byte_length) || corpusCase.byte_length < 1 ||
        !isSha256(corpusCase.sha256)) {
      throw new Error(`wire corpus case is invalid: ${corpusCase.id}`);
    }
    ids.add(corpusCase.id);
  }
}

function validateIdentity(identity: WireDifferentialIdentity): void {
  if (Number.isNaN(Date.parse(identity.generated_at)) ||
      !COMMIT_PATTERN.test(identity.source_commit) ||
      !COMMIT_PATTERN.test(identity.rsipstack_commit) ||
      identity.baseline_patchset !== 'ivekit.40' ||
      identity.current_patchset !== 'ivekit.42' ||
      !isSha256(identity.baseline_binary_sha256) ||
      !isSha256(identity.current_binary_sha256) ||
      !isSha256(identity.patch_set_sha256)) {
    throw new Error('wire differential identity is invalid');
  }
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(arguments_: readonly string[]): Record<string, string> {
  const expected = new Set([
    'manifest',
    'baseline-binary',
    'current-binary',
    'output',
    'generated-at',
    'source-commit',
    'rsipstack-commit',
    'patch-set-sha256'
  ]);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('wire differential arguments are invalid');
    }
    const name = flag.slice(2);
    if (!expected.has(name) || parsed[name] !== undefined) {
      throw new Error(`wire differential argument is invalid: ${flag}`);
    }
    parsed[name] = value;
  }
  if ([...expected].some((name) => parsed[name] === undefined)) {
    throw new Error('wire differential arguments are incomplete');
  }
  return parsed;
}

function runCli(): void {
  const arguments_ = parseArguments(process.argv.slice(2));
  const manifestPath = resolve(arguments_['manifest']!);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WireCorpusManifest;
  const baselineBinary = resolve(arguments_['baseline-binary']!);
  const currentBinary = resolve(arguments_['current-binary']!);
  const report = buildWireDifferential({
    manifest,
    baseline_records: replayWireCorpus(manifest, manifestPath, baselineBinary),
    current_records: replayWireCorpus(manifest, manifestPath, currentBinary),
    identity: {
      generated_at: arguments_['generated-at']!,
      source_commit: arguments_['source-commit']!,
      rsipstack_commit: arguments_['rsipstack-commit']!,
      baseline_patchset: 'ivekit.40',
      current_patchset: 'ivekit.42',
      baseline_binary_sha256: sha256(readFileSync(baselineBinary)),
      current_binary_sha256: sha256(readFileSync(currentBinary)),
      patch_set_sha256: arguments_['patch-set-sha256']!
    }
  });
  writeFileSync(resolve(arguments_['output']!), `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'wire differential failed');
    process.exitCode = 1;
  }
}
