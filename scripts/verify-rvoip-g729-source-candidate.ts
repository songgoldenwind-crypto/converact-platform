import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const SOURCE_PREFIX = 'crates/media/codec-core/src/codecs/g729/';
const TARGET_PREFIX = 'services/voice-media-rs/vendor/rvoip-g729/';
const SOURCE_SET_SHA256 = 'bbc645b365a3b0d86fd2c05881d7911d65b880b695b1483dba856903bae223ad';
const MAX_FILES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 24;
const MAX_RUST_TOKENS = 1_000_000;
const MAX_LEXICAL_DEPTH = 256;
const GATES = ['license_review', 'patent_legal_review', 'extraction', 'dependency_closure', 'annex_a', 'annex_b_vad_dtx_cng', 'annex_b_fmtp_negotiation', 'packetization_10ms', 'packetization_20ms', 'sid_no_data', 'plc', 'reference_vectors', 'g711_pairs', 'opus_pairs', 'interoperability', 'quality', 'allocation', 'latency', 'sessions_per_core', 'supply_chain', 'production_eligibility'] as const;
const RUNTIME_DEPENDENCY_ROOTS = [
  'crate::codecs::g729',
  'crate::error',
  'crate::types'
] as const;
const TEST_ONLY_DEPENDENCY_ROOTS = ['crate::codecs::CodecFactory'] as const;
const PINNED_TEST_ONLY_DEPENDENCIES = [
  { path: 'mod.rs', dependency: 'crate::codecs::CodecFactory' }
] as const;
const PINNED_BARE_PATH_OCCURRENCES_SHA256 =
  '4ac34daf963e064da862c640a5b3b3510582ba7d6411b31f317098f3cf2460b3';

type SourceEntry = { path: string; bytes: number; sha256: string; planned_target: string };
type SupportFile = { path: string; bytes: number; sha256: string };
type RustToken = {
  kind: 'identifier' | 'punctuation';
  value: string;
  offset: number;
  raw: boolean;
};
type TokenRange = { start: number; end: number };
type DependencyOccurrence = { path: string; dependency: string };
type BarePathOccurrence = DependencyOccurrence & { offset: number };
type ParsedUseDependency = {
  segments: string[];
  tokenIndex: number;
  rootTokenIndex: number;
  binding: string | null;
  absolute: boolean;
};
type RustScope = {
  parent: number | null;
  declared: Set<string>;
  genericCallables: Set<string>;
  imported: Set<string>;
};
type RustScopeMap = { scopes: RustScope[]; at: number[] };
type DependencyAudit = {
  testOnlyDependencies: DependencyOccurrence[];
  barePathOccurrences: BarePathOccurrence[];
};
type Candidate = Record<string, unknown> & {
  selected_sources?: SourceEntry[];
  source_set_sha256?: string;
  support_files?: SupportFile[];
};

export function computeRvoipG729SourceSetSha256(entries: SourceEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({ path, bytes, sha256, planned_target }) => [path, String(bytes), sha256, planned_target].join('\0'))
    .join('\n');
  return sha256(Buffer.from(canonical));
}

export function verifyRvoipG729SourceCandidate(input: unknown): void {
  const candidate = record(input, 'candidate');
  exactKeys(candidate, [
    'schema_version', 'candidate_id', 'revision', 'status', 'generated_at',
    'source', 'support_files', 'support_file_policy', 'candidate_source_root',
    'planned_codec_contract', 'selected_sources', 'source_set_sha256', 'dependency_authority',
    'forbidden_source_prefixes', 'reference_vectors', 'gates', 'claim',
    'non_claims'
  ], 'candidate');
  exact(candidate.schema_version, '1.0.0', 'schema version');
  exact(candidate.candidate_id, 'rvoip-g729-codec-core-v1', 'candidate ID');
  exact(candidate.revision, 1, 'revision');
  exact(candidate.status, 'candidate', 'status');
  requireDate(candidate.generated_at, 'generated at');
  verifySource(record(candidate.source, 'source'));
  verifySupportFiles(candidate.support_files);
  verifySupportFilePolicy(record(candidate.support_file_policy, 'support file policy'));
  exact(candidate.candidate_source_root, SOURCE_PREFIX.slice(0, -1), 'candidate source root');
  verifyPlannedCodecContract(
    record(candidate.planned_codec_contract, 'planned codec contract')
  );

  const entries = sourceEntries(candidate.selected_sources);
  if (entries.length !== 136) throw new Error('source entry count drift');
  assertSortedUnique(entries, 'source');
  const targets = new Set<string>();
  for (const entry of entries) {
    safeRelativePath(entry.path, 'source path');
    safeRelativePath(entry.planned_target, 'planned target');
    if (!entry.path.startsWith(SOURCE_PREFIX) || !entry.path.endsWith('.rs')) throw new Error('source path mapping drift');
    const tail = entry.path.slice(SOURCE_PREFIX.length);
    if (entry.planned_target !== `${TARGET_PREFIX}${tail}`) throw new Error('planned target mapping drift');
    if (!targets.add(entry.planned_target)) throw new Error('duplicate planned target');
    positiveInteger(entry.bytes, 'size');
    sha256Value(entry.sha256, 'source hash');
  }
  if (candidate.source_set_sha256 !== SOURCE_SET_SHA256) throw new Error('source-set hash drift');
  if (computeRvoipG729SourceSetSha256(entries) !== SOURCE_SET_SHA256) throw new Error('bad hash or source-set hash drift');
  verifyDependencyAuthority(record(candidate.dependency_authority, 'dependency authority'));
  exactArray(candidate.forbidden_source_prefixes, ['rtp', 'runtime', 'session', 'sip', 'webrtc'], 'forbidden source prefixes');
  verifyReferenceVectors(record(candidate.reference_vectors, 'reference vectors'));
  verifyGates(record(candidate.gates, 'gates'));
  verifyClaim(record(candidate.claim, 'claim'));
  verifyNonClaims(candidate.non_claims);
}

export function verifyRvoipG729SelectedSourceTree(entriesInput: unknown, sourceRoot: string): void {
  const entries = sourceEntries(entriesInput);
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error('source file count exceeds bound');
  assertSortedUnique(entries, 'source');
  const root = resolve(sourceRoot);
  assertSafeDirectory(root, 'source root');
  const expected = new Map<string, SourceEntry>();
  for (const entry of entries) {
    safeRelativePath(entry.path, 'source path');
    safeRelativePath(entry.planned_target, 'planned target');
    if (!entry.path.endsWith('.rs')) throw new Error('source path must name Rust source');
    if (expected.has(entry.path)) throw new Error('duplicate source path');
    expected.set(entry.path, entry);
  }
  let files = 0;
  let bytes = 0;
  const found = new Set<string>();
  const testOnlyDependencies: DependencyOccurrence[] = [];
  const barePathOccurrences: BarePathOccurrence[] = [];
  const pinnedTree = isPinnedRvoipG729SourceTree(entries);
  walk(root, 0, absolute => {
    const rel = relative(root, absolute).split(sep).join('/');
    const entry = expected.get(rel);
    if (!entry) throw new Error(`unexpected source file: ${rel}`);
    const body = readBounded(absolute, entry.bytes);
    files += 1;
    bytes += body.byteLength;
    if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error('source tree exceeds bound');
    if (body.byteLength !== entry.bytes) throw new Error(`source size mismatch: ${rel}`);
    if (sha256(body) !== entry.sha256) throw new Error(`source hash mismatch: ${rel}`);
    const dependencyAudit = auditDependencyRoots(
      body.toString('utf8'),
      rel,
      pinnedTree
    );
    testOnlyDependencies.push(...dependencyAudit.testOnlyDependencies);
    barePathOccurrences.push(...dependencyAudit.barePathOccurrences);
    found.add(rel);
  });
  for (const path of expected.keys()) if (!found.has(path)) throw new Error(`missing source file: ${path}`);
  if (pinnedTree) {
    exact(
      testOnlyDependencies.sort(compareDependencyOccurrence),
      [...PINNED_TEST_ONLY_DEPENDENCIES],
      'pinned test-only dependency occurrence'
    );
    const barePathDigest = computeBarePathOccurrenceSha256(barePathOccurrences);
    if (barePathDigest !== PINNED_BARE_PATH_OCCURRENCES_SHA256) {
      throw new Error(`pinned bare-path occurrence drift: ${barePathDigest}`);
    }
  }
}

function isPinnedRvoipG729SourceTree(entries: SourceEntry[]): boolean {
  if (entries.length !== 136) return false;
  const prefixedEntries = entries.map(entry => ({
    ...entry,
    path: `${SOURCE_PREFIX}${entry.path}`
  }));
  return computeRvoipG729SourceSetSha256(prefixedEntries) === SOURCE_SET_SHA256;
}

function verifySource(source: Record<string, unknown>): void {
  exactKeys(
    source,
    ['repository', 'commit', 'tree', 'commit_signature', 'archive'],
    'source'
  );
  exact(source.repository, 'https://github.com/eisenzopf/rvoip', 'source repository');
  exact(source.commit, '4ced02b7f6e73041c848f1765dc2bcf7588796f0', 'source commit');
  exact(source.tree, '74dabd314841d99e1a87dbdaca6050fc4e8ed923', 'source tree');
  exact(source.commit_signature, 'unsigned', 'source signature');
  const archive = record(source.archive, 'source archive');
  exactKeys(archive, ['sha256', 'bytes'], 'source archive');
  exact(archive, { sha256: '16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e', bytes: 8594565 }, 'source archive');
}

function verifySupportFiles(value: unknown): void {
  const expected: SupportFile[] = [
    { path: 'LICENSE', bytes: 1075, sha256: 'd689025d3da6610ea2ff966052e3709e2eb15fc7553e7f2ddf49866e62b24859' },
    { path: 'THIRD_PARTY_NOTICES.md', bytes: 1522, sha256: '172bdddc94e3e07e9c35c895380afdc85e78085a0ff4084f3d52fc85fc93ad12' },
    { path: 'crates/media/codec-core/Cargo.toml', bytes: 1268, sha256: 'ed53b56f67bb1ce3ae63145017893a7b0f003e4a6fd8b8b2b8d39573f1efc2d0' }
  ];
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error('support files drift');
  }
  value.forEach((entry, index) => {
    const file = record(entry, `support file ${index}`);
    exactKeys(file, ['path', 'bytes', 'sha256'], 'support file');
    exact(file, expected[index], `support file ${index}`);
  });
}

function verifySupportFilePolicy(policy: Record<string, unknown>): void {
  exactKeys(
    policy,
    ['cargo_toml', 'dependency_selection'],
    'support file policy'
  );
  exact(policy, {
    cargo_toml: 'provenance_only_not_adopted',
    dependency_selection: 'selected_sources_only'
  }, 'support file policy');
}

function verifyPlannedCodecContract(
  contract: Record<string, unknown>
): void {
  exact(contract, {
    modes: [
      {
        mode_id: 'G729A',
        annex_b_mode: false,
        codec_pairs: [
          'PCMU_TO_G729A', 'G729A_TO_PCMU',
          'PCMA_TO_G729A', 'G729A_TO_PCMA',
          'OPUS_TO_G729A', 'G729A_TO_OPUS'
        ],
        independent_peer: { status: 'not_run', identity: null },
        reference_vector_artifact: { status: 'not_run', artifact: null },
        quality_profile: { status: 'not_run', profile_id: null },
        performance_profile: { status: 'not_run', profile_id: null }
      },
      {
        mode_id: 'G729AB',
        annex_b_mode: true,
        codec_pairs: [
          'PCMU_TO_G729AB', 'G729AB_TO_PCMU',
          'PCMA_TO_G729AB', 'G729AB_TO_PCMA',
          'OPUS_TO_G729AB', 'G729AB_TO_OPUS'
        ],
        independent_peer: { status: 'not_run', identity: null },
        reference_vector_artifact: { status: 'not_run', artifact: null },
        quality_profile: { status: 'not_run', profile_id: null },
        performance_profile: { status: 'not_run', profile_id: null }
      }
    ],
    sample_rate_hz: 8000,
    frame_ms: 10,
    samples_per_frame: 80,
    packetization_ms: [10, 20],
    annex_b_fmtp_negotiation: {
      status: 'not_run',
      parameter: 'annexb',
      g729a_expected_value: 'no',
      g729ab_expected_value: 'yes'
    },
    legal_boundary: {
      status: 'not_run',
      blocks: [
        'production_distribution',
        'runtime_enablement',
        'production_eligibility'
      ],
      does_not_block: [
        'engineering_implementation',
        'source_extraction',
        'testing'
      ],
      external_legal_conclusion_required: true
    }
  }, 'planned codec contract');
}

function verifyDependencyAuthority(authority: Record<string, unknown>): void {
  exactKeys(authority, [
    'authority', 'closed', 'external_allowlist', 'internal_allowlist',
    'codec_adapter_allowlist', 'test_only_allowlist', 'unresolved'
  ], 'dependency authority');
  exact(authority.authority, 'codec_adapter_only', 'dependency authority');
  exact(authority.closed, true, 'dependency closure');
  exact(authority.external_allowlist, [], 'forbidden dependency');
  exact(authority.internal_allowlist, ['crate::codecs::g729'], 'internal dependency allowlist');
  exact(authority.codec_adapter_allowlist, ['crate::error', 'crate::types'], 'adapter dependency allowlist');
  exact(authority.test_only_allowlist, ['crate::codecs::CodecFactory'], 'test-only dependency allowlist');
  exact(authority.unresolved, [], 'unresolved dependency');
}

function verifyReferenceVectors(vectors: Record<string, unknown>): void {
  exactKeys(
    vectors,
    ['status', 'external_injection_required', 'artifacts'],
    'reference vectors'
  );
  exact(vectors, {
    status: 'not_run',
    external_injection_required: true,
    artifacts: []
  }, 'reference vectors');
}

function verifyGates(gates: Record<string, unknown>): void {
  exactKeys(gates, [...GATES], 'gate');
  for (const gate of GATES) if (gates[gate] !== 'not_run') throw new Error(`gate drift: ${gate}`);
}

function verifyClaim(claim: Record<string, unknown>): void {
  exactKeys(
    claim,
    ['capacity_claim', 'production_eligible', 'runtime_enabled'],
    'claim'
  );
  if (claim.capacity_claim !== 'none') throw new Error('capacity claim drift');
  if (claim.runtime_enabled !== false) throw new Error('runtime enabled drift');
  if (claim.production_eligible !== false) throw new Error('production eligible drift');
}

function verifyNonClaims(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(item => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error('non-claim records must be non-empty strings');
  }
}

function sourceEntries(value: unknown): SourceEntry[] {
  if (!Array.isArray(value)) throw new Error('source entries are required');
  return value.map((entry, index) => {
    const item = record(entry, `source entry ${index}`);
    exactKeys(
      item,
      ['path', 'bytes', 'sha256', 'planned_target'],
      'selected source'
    );
    return { path: string(item.path, 'source path'), bytes: number(item.bytes, 'source size'), sha256: string(item.sha256, 'source hash'), planned_target: string(item.planned_target, 'planned target') };
  });
}

function assertSortedUnique(entries: SourceEntry[], label: string): void {
  const seen = new Set<string>();
  let prior = '';
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate ${label} path`);
    if (prior && entry.path < prior) throw new Error(`unsorted ${label} entries`);
    seen.add(entry.path); prior = entry.path;
  }
}

function safeRelativePath(value: string, label: string): void {
  if (!value || value.startsWith('/')) throw new Error(`absolute path ${label}`);
  if (value.includes('\\')) throw new Error(`path traversal ${label}`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`control character ${label}`);
  if (value.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error(`path traversal ${label}`);
}

function walk(directory: string, depth: number, file: (path: string) => void): void {
  if (depth > MAX_DEPTH) throw new Error('source tree depth exceeds bound');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) throw new Error(`symlink outside source tree: ${path}`);
    if (status.isDirectory()) walk(path, depth + 1, file);
    else if (status.isFile()) file(path);
    else throw new Error(`unsafe source tree entry: ${path}`);
  }
}

function auditDependencyRoots(
  source: string,
  path: string,
  pinnedTree: boolean
): DependencyAudit {
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error(`Rust source exceeds bound: ${path}`);
  const tokens = tokenizeRust(source, path);
  const testRanges = cfgTestItemRanges(tokens, path);
  const moduleRanges = rustModuleRanges(tokens, path);
  const fileModuleDepth = rustFileModuleDepth(path);
  const scopeMap = buildRustScopeMap(tokens);
  const attributedBindingHeaders = attributedRustBindingHeaders(
    tokens,
    scopeMap,
    path
  );
  collectDeclaredRustBindings(tokens, scopeMap, attributedBindingHeaders);
  const useRanges: TokenRange[] = [];
  const testOnlyDependencies: DependencyOccurrence[] = [];
  const barePathOccurrences: BarePathOccurrence[] = [];
  const uses: Array<{
    tokenIndex: number;
    scope: number;
    dependencies: ParsedUseDependency[];
  }> = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (!isRustKeyword(tokens[index], 'use')) continue;
    const end = statementEnd(tokens, index + 1, path);
    const dependencies: ParsedUseDependency[] = [];
    const parsed = parseUseTree(
      tokens,
      index + 1,
      end,
      [],
      null,
      false,
      dependencies,
      path
    );
    if (parsed !== end) throw new Error(`malformed Rust use tree in ${path}`);
    const scope = scopeMap.at[index] ?? 0;
    uses.push({ tokenIndex: index, scope, dependencies });
    useRanges.push({ start: index, end: end + 1 });
    index = end;
  }

  for (const use of uses) {
    for (const dependency of use.dependencies) {
      validateUseDependency(
        dependency,
        tokens,
        scopeMap,
        moduleRanges,
        fileModuleDepth,
        testRanges,
        path,
        testOnlyDependencies,
        barePathOccurrences,
        pinnedTree
      );
      if (
        dependency.binding &&
        !attributedBindingHeaders.has(use.tokenIndex)
      ) {
        scopeMap.scopes[use.scope].imported.add(dependency.binding);
      }
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (
      isRustKeyword(tokens[index], 'extern') &&
      isRustKeyword(tokens[index + 1], 'crate')
    ) {
      const dependency = tokens[index + 2];
      if (!dependency || dependency.kind !== 'identifier') {
        throw new Error(`malformed extern crate in ${path}`);
      }
      if (
        dependency.raw ||
        !['std', 'core', 'alloc', 'self'].includes(dependency.value)
      ) {
        throw new Error(`undeclared external dependency in ${path}: ${dependency.value}`);
      }
    }
  }
  validateMaximalRustPaths({
    tokens,
    useRanges,
    scopeMap,
    moduleRanges,
    fileModuleDepth,
    testRanges,
    path,
    pinnedTree,
    testOnlyDependencies,
    barePathOccurrences
  });
  return { testOnlyDependencies, barePathOccurrences };
}

function tokenizeRust(source: string, path: string): RustToken[] {
  const tokens: RustToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      cursor = skipBlockComment(source, cursor, path);
      continue;
    }
    const rawEnd = rawStringEnd(source, cursor, path);
    if (rawEnd !== null) {
      cursor = rawEnd;
      continue;
    }
    if (character === '"' || ((character === 'b' || character === 'c') && source[cursor + 1] === '"')) {
      cursor = skipQuoted(source, character === '"' ? cursor : cursor + 1, '"', path);
      continue;
    }
    if (character === '\'' || (character === 'b' && source[cursor + 1] === '\'')) {
      const byteCharacter = character === 'b';
      const quote = character === '\'' ? cursor : cursor + 1;
      const charEnd = characterLiteralEnd(source, quote);
      if (charEnd !== null) {
        cursor = charEnd;
        continue;
      }
      const lifetime = source.slice(quote).match(/^'[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      const lifetimeEnd = lifetime ? quote + lifetime.length : quote;
      if (
        byteCharacter ||
        !lifetime ||
        !isPlausibleRustLifetime(tokens, source[lifetimeEnd])
      ) {
        throw new Error(`unterminated Rust char literal in ${path}`);
      }
      cursor = lifetimeEnd;
      continue;
    }
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      throw new Error(`non-ASCII Rust dependency identifier is unsupported in ${path}`);
    }
    if (source.startsWith('r#', cursor) && /[A-Za-z_]/.test(source[cursor + 2] ?? '')) {
      let end = cursor + 3;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      pushRustToken(tokens, {
        kind: 'identifier',
        value: source.slice(cursor + 2, end),
        offset: cursor,
        raw: true
      }, path);
      cursor = end;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      pushRustToken(tokens, {
        kind: 'identifier',
        value: source.slice(cursor, end),
        offset: cursor,
        raw: false
      }, path);
      cursor = end;
      continue;
    }
    const value = source.startsWith('::', cursor) ? '::' : character;
    pushRustToken(tokens, {
      kind: 'punctuation',
      value,
      offset: cursor,
      raw: false
    }, path);
    cursor += value.length;
  }
  validateRustTokenDelimiters(tokens, path);
  return tokens;
}

function skipBlockComment(source: string, start: number, path: string): number {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < source.length && depth > 0) {
    if (source.startsWith('/*', cursor)) {
      depth += 1;
      if (depth > MAX_LEXICAL_DEPTH) throw new Error(`Rust comment nesting exceeds bound: ${path}`);
      cursor += 2;
    } else if (source.startsWith('*/', cursor)) {
      depth -= 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  if (depth !== 0) throw new Error(`unterminated Rust block comment in ${path}`);
  return cursor;
}

function rawStringEnd(source: string, start: number, path: string): number | null {
  const prefixLength = source.startsWith('br', start) || source.startsWith('cr', start)
    ? 2
    : source[start] === 'r' ? 1 : 0;
  if (prefixLength === 0) return null;
  let cursor = start + prefixLength;
  let hashes = 0;
  while (source[cursor] === '#') {
    hashes += 1;
    if (hashes > 255) throw new Error(`Rust raw string delimiter exceeds bound: ${path}`);
    cursor += 1;
  }
  if (source[cursor] !== '"') return null;
  const delimiter = `"${'#'.repeat(hashes)}`;
  const end = source.indexOf(delimiter, cursor + 1);
  if (end < 0) throw new Error(`unterminated Rust raw string in ${path}`);
  return end + delimiter.length;
}

function skipQuoted(source: string, quote: number, delimiter: string, path: string): number {
  let cursor = quote + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === delimiter) return cursor + 1;
    cursor += 1;
  }
  throw new Error(`unterminated Rust string in ${path}`);
}

function characterLiteralEnd(source: string, quote: number): number | null {
  let cursor = quote + 1;
  if (cursor >= source.length || source[cursor] === '\n' || source[cursor] === '\r') return null;
  if (source[cursor] === '\\') {
    cursor += 1;
    if (source[cursor] === 'u' && source[cursor + 1] === '{') {
      const close = source.indexOf('}', cursor + 2);
      if (close < 0) return null;
      cursor = close + 1;
    } else if (source[cursor] === 'x') {
      cursor += 3;
    } else {
      cursor += 1;
    }
  } else {
    const codePoint = source.codePointAt(cursor);
    if (codePoint === undefined) return null;
    cursor += codePoint > 0xffff ? 2 : 1;
  }
  return source[cursor] === '\'' ? cursor + 1 : null;
}

function isPlausibleRustLifetime(
  tokens: RustToken[],
  nextCharacter: string | undefined
): boolean {
  const previous = tokens.at(-1);
  if (
    nextCharacter === ':' ||
    isRustKeyword(previous, 'break') ||
    isRustKeyword(previous, 'continue')
  ) {
    return true;
  }
  if (previous && ['&', '<', ':', '+'].includes(previous.value)) return true;
  return previous?.value === ',' && hasOpenRustAngle(tokens);
}

function hasOpenRustAngle(tokens: RustToken[]): boolean {
  let depth = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].value === '>') {
      depth += 1;
    } else if (tokens[index].value === '<') {
      if (depth === 0) return true;
      depth -= 1;
    } else if (
      depth === 0 &&
      [';', '{', '}', '='].includes(tokens[index].value)
    ) {
      return false;
    }
  }
  return false;
}

function pushRustToken(tokens: RustToken[], token: RustToken, path: string): void {
  tokens.push(token);
  if (tokens.length > MAX_RUST_TOKENS) throw new Error(`Rust token count exceeds bound: ${path}`);
}

function cfgTestItemRanges(tokens: RustToken[], path: string): TokenRange[] {
  const ranges: TokenRange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isCfgTestAttribute(tokens, index)) continue;
    let item = index + 7;
    while (tokens[item]?.value === '#' && tokens[item + 1]?.value === '[') {
      item = matchingToken(tokens, item + 1, '[', ']', path) + 1;
    }
    const end = rustItemEnd(tokens, item, path);
    ranges.push({ start: item, end });
    index = end - 1;
  }
  return ranges;
}

function isCfgTestAttribute(tokens: RustToken[], index: number): boolean {
  return tokens[index]?.value === '#' &&
    tokens[index + 1]?.value === '[' &&
    isRustKeyword(tokens[index + 2], 'cfg') &&
    tokens[index + 3]?.value === '(' &&
    isRustKeyword(tokens[index + 4], 'test') &&
    tokens[index + 5]?.value === ')' &&
    tokens[index + 6]?.value === ']';
}

function rustItemEnd(tokens: RustToken[], start: number, path: string): number {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === ';') return index + 1;
    if (tokens[index].value === '{') {
      return matchingToken(tokens, index, '{', '}', path) + 1;
    }
  }
  throw new Error(`unbounded cfg(test) item in ${path}`);
}

function matchingToken(
  tokens: RustToken[],
  start: number,
  open: string,
  close: string,
  path: string
): number {
  let depth = 1;
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === open) {
      depth += 1;
      if (depth > MAX_LEXICAL_DEPTH) throw new Error(`Rust syntax nesting exceeds bound: ${path}`);
    } else if (tokens[index].value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`unbalanced Rust ${open}${close} tokens in ${path}`);
}

function buildRustScopeMap(tokens: RustToken[]): RustScopeMap {
  const scopes: RustScope[] = [{
    parent: null,
    declared: new Set<string>(),
    genericCallables: new Set<string>(),
    imported: new Set<string>()
  }];
  const at = new Array<number>(tokens.length).fill(0);
  const stack = [0];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = stack.at(-1) ?? 0;
    at[index] = current;
    if (['(', '[', '{'].includes(tokens[index].value)) {
      scopes.push({
        parent: current,
        declared: new Set<string>(),
        genericCallables: new Set<string>(),
        imported: new Set<string>()
      });
      stack.push(scopes.length - 1);
    } else if ([')', ']', '}'].includes(tokens[index].value) && stack.length > 1) {
      stack.pop();
    }
  }
  return { scopes, at };
}

function collectDeclaredRustBindings(
  tokens: RustToken[],
  scopeMap: RustScopeMap,
  attributedBindingHeaders: Set<number>
): void {
  const declarations = new Set([
    'mod', 'struct', 'enum', 'trait', 'union', 'type'
  ]);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const name = tokens[index + 1];
    if (
      token.kind === 'identifier' &&
      !token.raw &&
      declarations.has(token.value) &&
      name.kind === 'identifier' &&
      !attributedBindingHeaders.has(index)
    ) {
      scopeMap.scopes[scopeMap.at[index] ?? 0].declared.add(name.value);
    }
    if (
      isRustKeyword(token, 'fn') &&
      name.kind === 'identifier' &&
      !attributedBindingHeaders.has(index)
    ) {
      scopeMap.scopes[scopeMap.at[index] ?? 0].genericCallables.add(name.value);
    }
  }
}

function attributedRustBindingHeaders(
  tokens: RustToken[],
  scopeMap: RustScopeMap,
  path: string
): Set<number> {
  const headers = new Set<number>();
  const bindingKeywords = new Set([
    'mod', 'struct', 'enum', 'trait', 'union', 'type', 'fn', 'use'
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== '#' || tokens[index + 1]?.value !== '[') {
      continue;
    }
    let item = index;
    while (tokens[item]?.value === '#' && tokens[item + 1]?.value === '[') {
      item = matchingToken(tokens, item + 1, '[', ']', path) + 1;
    }
    const itemScope = scopeMap.at[item] ?? 0;
    for (let cursor = item; cursor < tokens.length; cursor += 1) {
      if ((scopeMap.at[cursor] ?? 0) !== itemScope) continue;
      const token = tokens[cursor];
      if (
        token.kind === 'identifier' &&
        !token.raw &&
        bindingKeywords.has(token.value)
      ) {
        headers.add(cursor);
        break;
      }
      if ([';', '{', '}', ','].includes(token.value)) break;
    }
    index = item - 1;
  }
  return headers;
}

function isRustKeyword(token: RustToken | undefined, value: string): boolean {
  return token?.kind === 'identifier' && !token.raw && token.value === value;
}

function rustModuleRanges(tokens: RustToken[], path: string): TokenRange[] {
  const ranges: TokenRange[] = [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (
      !isRustKeyword(tokens[index], 'mod') ||
      tokens[index + 1].kind !== 'identifier' ||
      tokens[index + 2].value !== '{'
    ) {
      continue;
    }
    const end = matchingToken(tokens, index + 2, '{', '}', path);
    ranges.push({ start: index + 3, end });
  }
  return ranges;
}

function rustFileModuleDepth(path: string): number {
  const segments = path.split('/');
  return segments.at(-1) === 'mod.rs' ? segments.length - 1 : segments.length;
}

function validateRustTokenDelimiters(tokens: RustToken[], path: string): void {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const token of tokens) {
    if (['(', '[', '{'].includes(token.value)) {
      stack.push(token.value);
      if (stack.length > MAX_LEXICAL_DEPTH) {
        throw new Error(`Rust syntax nesting exceeds bound: ${path}`);
      }
    } else if (Object.hasOwn(pairs, token.value)) {
      if (stack.pop() !== pairs[token.value]) {
        throw new Error(`unbalanced Rust delimiter in ${path}`);
      }
    }
  }
  if (stack.length > 0) throw new Error(`unbalanced Rust delimiter in ${path}`);
}

function statementEnd(tokens: RustToken[], start: number, path: string): number {
  let braces = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === '{') braces += 1;
    else if (tokens[index].value === '}') braces -= 1;
    else if (tokens[index].value === ';' && braces === 0) return index;
    if (braces < 0 || braces > MAX_LEXICAL_DEPTH) throw new Error(`malformed Rust use tree in ${path}`);
  }
  throw new Error(`unterminated Rust use in ${path}`);
}

function parseUseTree(
  tokens: RustToken[],
  start: number,
  end: number,
  prefix: string[],
  rootTokenIndex: number | null,
  absolute: boolean,
  dependencies: ParsedUseDependency[],
  path: string
): number {
  let index = start;
  let absolutePath = absolute;
  if (tokens[index]?.value === '::') {
    if (prefix.length === 0 && rootTokenIndex === null) absolutePath = true;
    index += 1;
  }
  if (tokens[index]?.value === '{') {
    index += 1;
    while (index < end && tokens[index].value !== '}') {
      index = parseUseTree(
        tokens,
        index,
        end,
        prefix,
        rootTokenIndex,
        absolutePath,
        dependencies,
        path
      );
      if (tokens[index]?.value === ',') index += 1;
      else if (tokens[index]?.value !== '}') throw new Error(`malformed Rust use group in ${path}`);
    }
    if (tokens[index]?.value !== '}') throw new Error(`unterminated Rust use group in ${path}`);
    return index + 1;
  }
  const segment = tokens[index];
  if (!segment || (segment.kind !== 'identifier' && segment.value !== '*')) {
    throw new Error(`malformed Rust use tree in ${path}`);
  }
  if (segment.value === '*') {
    dependencies.push({
      segments: prefix,
      tokenIndex: index,
      rootTokenIndex: rootTokenIndex ?? index,
      binding: null,
      absolute: absolutePath
    });
    return index + 1;
  }
  const segments = isRustKeyword(segment, 'self') && prefix.length > 0
    ? prefix
    : [...prefix, segment.value];
  const tokenIndex = index;
  const dependencyRoot = rootTokenIndex ?? index;
  index += 1;
  if (isRustKeyword(tokens[index], 'as')) {
    if (tokens[index + 1]?.kind !== 'identifier' && tokens[index + 1]?.value !== '_') {
      throw new Error(`malformed Rust use alias in ${path}`);
    }
    dependencies.push({
      segments,
      tokenIndex,
      rootTokenIndex: dependencyRoot,
      binding: tokens[index + 1].value === '_' ? null : tokens[index + 1].value,
      absolute: absolutePath
    });
    return index + 2;
  }
  if (tokens[index]?.value !== '::') {
    dependencies.push({
      segments,
      tokenIndex,
      rootTokenIndex: dependencyRoot,
      binding: isRustKeyword(segment, 'self') && prefix.length > 0
        ? prefix.at(-1) ?? null
        : segment.value,
      absolute: absolutePath
    });
    return index;
  }
  return parseUseTree(
    tokens,
    index + 1,
    end,
    segments,
    dependencyRoot,
    absolutePath,
    dependencies,
    path
  );
}

function validateUseDependency(
  dependency: ParsedUseDependency,
  tokens: RustToken[],
  scopeMap: RustScopeMap,
  moduleRanges: TokenRange[],
  fileModuleDepth: number,
  testRanges: TokenRange[],
  path: string,
  testOnlyDependencies: DependencyOccurrence[],
  barePathOccurrences: BarePathOccurrence[],
  pinnedTree: boolean
): void {
  const root = dependency.segments[0];
  if (!root) throw new Error(`empty Rust use dependency in ${path}`);
  const rootToken = tokens[dependency.rootTokenIndex];
  if (dependency.absolute) {
    if (['std', 'core', 'alloc'].includes(root)) return;
    recordOrRejectBarePath(
      dependency.segments,
      rootToken,
      path,
      pinnedTree,
      barePathOccurrences
    );
    return;
  }
  if (isRustKeyword(rootToken, 'crate')) {
    validateCrateDependency(
      dependency.segments,
      dependency.rootTokenIndex,
      testRanges,
      path,
      testOnlyDependencies
    );
    return;
  }
  if (isRustKeyword(rootToken, 'super')) {
    validateRelativeSuperDependency(
      dependency.segments,
      dependency.rootTokenIndex,
      moduleRanges,
      fileModuleDepth,
      path
    );
    return;
  }
  if (
    ['std', 'core', 'alloc'].includes(root) ||
    isRustKeyword(rootToken, 'self') ||
    rustBindingVisible(root, dependency.rootTokenIndex, scopeMap, false) ||
    (
      root !== dependency.binding &&
      rustBindingVisible(root, dependency.rootTokenIndex, scopeMap, true)
    )
  ) {
    return;
  }
  recordOrRejectBarePath(
    dependency.segments,
    rootToken,
    path,
    pinnedTree,
    barePathOccurrences
  );
}

function validateMaximalRustPaths(input: {
  tokens: RustToken[];
  useRanges: TokenRange[];
  scopeMap: RustScopeMap;
  moduleRanges: TokenRange[];
  fileModuleDepth: number;
  testRanges: TokenRange[];
  path: string;
  pinnedTree: boolean;
  testOnlyDependencies: DependencyOccurrence[];
  barePathOccurrences: BarePathOccurrence[];
}): void {
  const {
    tokens,
    useRanges,
    scopeMap,
    moduleRanges,
    fileModuleDepth,
    testRanges,
    path,
    pinnedTree,
    testOnlyDependencies,
    barePathOccurrences
  } = input;
  for (let index = 0; index < tokens.length; index += 1) {
    if (isInsideTokenRange(index, useRanges)) continue;
    const token = tokens[index];
    let rootIndex: number;
    let absolute = false;
    if (token.kind === 'identifier' && tokens[index + 1]?.value === '::') {
      if (
        tokens[index - 1]?.value === '::' ||
        tokens[index - 1]?.value === '.'
      ) {
        continue;
      }
      if (isNonPathRustKeyword(token)) continue;
      rootIndex = index;
    } else if (
      token.value === '::' &&
      tokens[index + 1]?.kind === 'identifier' &&
      isLeadingRustPath(tokens[index - 1])
    ) {
      rootIndex = index + 1;
      absolute = true;
    } else {
      continue;
    }

    const segments = [tokens[rootIndex].value];
    let cursor = rootIndex;
    while (
      tokens[cursor + 1]?.value === '::' &&
      tokens[cursor + 2]?.kind === 'identifier'
    ) {
      segments.push(tokens[cursor + 2].value);
      cursor += 2;
    }
    const root = segments[0];
    const rootToken = tokens[rootIndex];
    if (absolute) {
      if (!['std', 'core', 'alloc'].includes(root)) {
        recordOrRejectBarePath(
          segments,
          rootToken,
          path,
          pinnedTree,
          barePathOccurrences
        );
      }
    } else if (isRustKeyword(rootToken, 'crate')) {
      validateCrateDependency(
        segments,
        rootIndex,
        testRanges,
        path,
        testOnlyDependencies
      );
    } else if (isRustKeyword(rootToken, 'super')) {
      validateRelativeSuperDependency(
        segments,
        rootIndex,
        moduleRanges,
        fileModuleDepth,
        path
      );
    } else if (
      ['std', 'core', 'alloc'].includes(root) ||
      isRustKeyword(rootToken, 'self') ||
      root === 'Self' ||
      isRustPrimitive(root) ||
      rustBindingVisible(root, rootIndex, scopeMap, true) ||
      (
        segments.length === 1 &&
        tokens[rootIndex + 2]?.value === '<' &&
        rustGenericCallableVisible(root, rootIndex, scopeMap)
      )
    ) {
      // Proven local or built-in root.
    } else {
      recordOrRejectBarePath(
        segments,
        rootToken,
        path,
        pinnedTree,
        barePathOccurrences
      );
    }
    index = Math.max(index, cursor);
  }
}

function isLeadingRustPath(previous: RustToken | undefined): boolean {
  if (!previous) return true;
  if (
    previous.value === '::' ||
    previous.value === '.' ||
    [')', ']', '}', '>'].includes(previous.value)
  ) {
    return false;
  }
  return previous.kind !== 'identifier' || isNonPathRustKeyword(previous);
}

function isNonPathRustKeyword(token: RustToken): boolean {
  if (token.raw || token.kind !== 'identifier') return false;
  return new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'dyn', 'else',
    'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let',
    'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'static',
    'struct', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
    'yield'
  ]).has(token.value);
}

function isRustPrimitive(value: string): boolean {
  return new Set([
    'bool', 'char', 'str',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'f32', 'f64'
  ]).has(value);
}

function rustBindingVisible(
  name: string,
  tokenIndex: number,
  scopeMap: RustScopeMap,
  includeImported: boolean
): boolean {
  let scope: number | null = scopeMap.at[tokenIndex] ?? 0;
  while (scope !== null) {
    const current = scopeMap.scopes[scope];
    if (
      current.declared.has(name) ||
      (includeImported && current.imported.has(name))
    ) {
      return true;
    }
    scope = current.parent;
  }
  return false;
}

function rustGenericCallableVisible(
  name: string,
  tokenIndex: number,
  scopeMap: RustScopeMap
): boolean {
  let scope: number | null = scopeMap.at[tokenIndex] ?? 0;
  while (scope !== null) {
    const current = scopeMap.scopes[scope];
    if (current.genericCallables.has(name)) return true;
    scope = current.parent;
  }
  return false;
}

function validateRelativeSuperDependency(
  segments: string[],
  tokenIndex: number,
  moduleRanges: TokenRange[],
  fileModuleDepth: number,
  path: string
): void {
  const firstNonSuper = segments.findIndex(segment => segment !== 'super');
  const count = firstNonSuper < 0 ? segments.length : firstNonSuper;
  const inlineDepth = moduleRanges.filter(range =>
    tokenIndex >= range.start && tokenIndex < range.end
  ).length;
  if (count > fileModuleDepth + inlineDepth) {
    throw new Error(`relative super dependency escapes G.729 in ${path}`);
  }
}

function recordOrRejectBarePath(
  segments: string[],
  rootToken: RustToken | undefined,
  path: string,
  pinnedTree: boolean,
  barePathOccurrences: BarePathOccurrence[]
): void {
  const dependency = segments.join('::');
  if (!rootToken) throw new Error(`malformed Rust dependency path in ${path}`);
  if (!pinnedTree) {
    throw new Error(`undeclared external dependency in ${path}: ${dependency}`);
  }
  barePathOccurrences.push({
    path,
    offset: rootToken.offset,
    dependency
  });
}

function validateCrateDependency(
  segments: string[],
  tokenIndex: number,
  testRanges: TokenRange[],
  path: string,
  testOnlyDependencies: DependencyOccurrence[]
): void {
  const dependency = segments.join('::');
  if (matchesDependencyRoot(dependency, RUNTIME_DEPENDENCY_ROOTS)) return;
  if (
    matchesDependencyRoot(dependency, TEST_ONLY_DEPENDENCY_ROOTS) &&
    isInsideTokenRange(tokenIndex, testRanges)
  ) {
    testOnlyDependencies.push({
      path,
      dependency: 'crate::codecs::CodecFactory'
    });
    return;
  }
  const kind = matchesDependencyRoot(dependency, TEST_ONLY_DEPENDENCY_ROOTS)
    ? 'test-only dependency used outside cfg(test)'
    : 'undeclared dependency';
  throw new Error(`${kind} in ${path}: ${dependency}`);
}

function matchesDependencyRoot(
  dependency: string,
  roots: readonly string[]
): boolean {
  return roots.some(root =>
    dependency === root || dependency.startsWith(`${root}::`)
  );
}

function isInsideTokenRange(
  position: number,
  ranges: TokenRange[]
): boolean {
  return ranges.some(range => position >= range.start && position < range.end);
}

function compareDependencyOccurrence(
  left: DependencyOccurrence,
  right: DependencyOccurrence
): number {
  const leftValue = `${left.path}\0${left.dependency}`;
  const rightValue = `${right.path}\0${right.dependency}`;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function computeBarePathOccurrenceSha256(
  occurrences: BarePathOccurrence[]
): string {
  const canonical = [...occurrences]
    .sort((left, right) => {
      const leftValue = `${left.path}\0${left.offset}\0${left.dependency}`;
      const rightValue = `${right.path}\0${right.offset}\0${right.dependency}`;
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    })
    .map(({ path, offset, dependency }) =>
      [path, String(offset), dependency].join('\0')
    )
    .join('\n');
  return sha256(Buffer.from(canonical));
}

function assertSafeDirectory(path: string, label: string): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) throw new Error(`${label} symlink is forbidden`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
}

function assertPathComponents(
  root: string,
  relativePath: string,
  label: string,
  finalKind: 'file' | 'directory'
): void {
  safeRelativePath(relativePath, label);
  let current = root;
  const segments = relativePath.split('/');
  segments.forEach((segment, index) => {
    current = join(current, segment);
    const status = lstatSync(current);
    if (status.isSymbolicLink()) {
      throw new Error(`source root symlink component is forbidden for ${label}: ${segment}`);
    }
    const last = index === segments.length - 1;
    if ((!last || finalKind === 'directory') && !status.isDirectory()) {
      throw new Error(`${label} path component must be a directory: ${segment}`);
    }
    if (last && finalKind === 'file' && !status.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
  });
}

function assertRegularFile(path: string, label: string): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) throw new Error(`${label} symlink is forbidden`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file`);
}

function readBounded(path: string, expectedBytes: number, label = 'source file'): Buffer {
  positiveInteger(expectedBytes, 'size');
  assertRegularFile(path, label);
  if (expectedBytes > MAX_BYTES || statSync(path).size > MAX_BYTES) throw new Error('source file exceeds bound');
  return readFileSync(path);
}

function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function sha256Value(value: string, label: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`bad ${label}`); }
function positiveInteger(value: unknown, label: string): asserts value is number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`bad ${label}`); }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is required`); return value as Record<string, unknown>; }
function string(value: unknown, label: string): string { if (typeof value !== 'string') throw new Error(`bad ${label}`); return value; }
function number(value: unknown, label: string): number { if (typeof value !== 'number') throw new Error(`bad ${label}`); return value; }
function requireDate(value: unknown, label: string): void {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (
    typeof value !== 'string' ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error(`bad canonical ${label} date-time`);
  }
}
function exact(actual: unknown, expected: unknown, label: string): void { if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} drift`); }
function exactArray(actual: unknown, expected: string[], label: string): void { exact(actual, expected, label); }
function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const allowed = new Set(expected);
  const unexpected = Object.keys(value).find(key => !allowed.has(key));
  if (unexpected) {
    throw new Error(`unexpected additional property in ${label}: ${unexpected}`);
  }
  const missing = expected.find(key => !Object.hasOwn(value, key));
  if (missing) throw new Error(`missing ${label} property: ${missing}`);
}

function cli(): void {
  const args = process.argv.slice(2);
  const value = (flag: string): string => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error('usage: verify-rvoip-g729-source-candidate --manifest <path> --archive <path> --source-root <repo-root>'); return args[index + 1]; };
  try {
    const manifestPath = value('--manifest'); const archivePath = value('--archive'); const repoRoot = value('--source-root');
    if (args.length !== 6) throw new Error('usage: verify-rvoip-g729-source-candidate --manifest <path> --archive <path> --source-root <repo-root>');
    assertRegularFile(manifestPath, 'manifest');
    const candidate = JSON.parse(readFileSync(manifestPath, 'utf8')) as Candidate;
    verifyRvoipG729SourceCandidate(candidate);
    assertRegularFile(archivePath, 'archive');
    assertSafeDirectory(repoRoot, 'source root');
    for (const support of candidate.support_files ?? []) {
      assertPathComponents(repoRoot, support.path, `support file ${support.path}`, 'file');
      assertRegularFile(join(repoRoot, support.path), `support file ${support.path}`);
    }
    assertPathComponents(
      repoRoot,
      SOURCE_PREFIX.slice(0, -1),
      'selected source root',
      'directory'
    );
    const archive = readBounded(archivePath, 8594565, 'archive');
    if (archive.byteLength !== 8594565 || sha256(archive) !== '16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e') throw new Error('archive identity drift');
    for (const support of candidate.support_files ?? []) {
      const body = readBounded(
        join(repoRoot, support.path),
        support.bytes,
        `support file ${support.path}`
      );
      if (body.byteLength !== support.bytes || sha256(body) !== support.sha256) throw new Error(`support file drift: ${support.path}`);
    }
    const treeEntries = (candidate.selected_sources ?? []).map(entry => ({
      ...entry,
      path: entry.path.slice(SOURCE_PREFIX.length)
    }));
    verifyRvoipG729SelectedSourceTree(treeEntries, join(repoRoot, SOURCE_PREFIX));
    process.stdout.write(`${JSON.stringify({ source_identity: 'passed', capacity_claim: 'none', runtime_enabled: false, selected_sources: candidate.selected_sources?.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'verification failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && /verify-rvoip-g729-source-candidate\.(?:ts|js)$/.test(process.argv[1])) cli();
