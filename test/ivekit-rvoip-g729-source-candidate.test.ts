import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const schemaPath = 'docs/capacity/schemas/rvoip-g729-source-candidate.schema.json';
const manifestPath = 'docs/capacity/forks/rvoip-g729-source-candidate-v1.json';
const forksPath = 'docs/capacity/forks/ivekit-forks-v1.json';
const verifierPath = 'scripts/verify-rvoip-g729-source-candidate.ts';
const readmePath = 'docs/capacity/README.md';
const required = [schemaPath, manifestPath, forksPath, verifierPath, readmePath];
const hex = /^[a-f0-9]{64}$/;
const sourceSetSha256 = 'bbc645b365a3b0d86fd2c05881d7911d65b880b695b1483dba856903bae223ad';
const gates = ['license_review', 'patent_legal_review', 'extraction', 'dependency_closure', 'annex_a', 'annex_b_vad_dtx_cng', 'annex_b_fmtp_negotiation', 'packetization_10ms', 'packetization_20ms', 'sid_no_data', 'plc', 'reference_vectors', 'g711_pairs', 'opus_pairs', 'interoperability', 'quality', 'allocation', 'latency', 'sessions_per_core', 'supply_chain', 'production_eligibility'];

function prerequisites(): boolean {
  for (const path of required) assert.ok(existsSync(path), `missing required artifact: ${path}`);
  return required.every(existsSync);
}
function json(path: string): Record<string, any> { return JSON.parse(readFileSync(path, 'utf8')); }
function candidate(): Record<string, any> { return json(manifestPath); }
function sourceDigest(entries: Array<Record<string, any>>): string {
  const canonical = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({ path, bytes, sha256, planned_target }) => [path, String(bytes), sha256, planned_target].join('\0')).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
function reversed(value: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(value).reverse());
}
function runVerifier(archive: string, sourceRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    '--import', 'tsx', verifierPath,
    '--manifest', manifestPath,
    '--archive', archive,
    '--source-root', sourceRoot
  ], { cwd: process.cwd(), encoding: 'utf8' });
}
function syntheticSourceEntry(root: string, body: string): Array<Record<string, any>> {
  const path = 'fixture.rs';
  writeFileSync(join(root, path), body);
  return [{
    path,
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
    planned_target: `services/voice-media-rs/vendor/rvoip-g729/${path}`
  }];
}

test('rvoip G.729 candidate schema and required artifacts exist', () => { prerequisites(); });

test('rvoip G.729 candidate validates against its 2020 schema', () => {
  prerequisites();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('uri', { type: 'string', validate: (value: string) => { try { return Boolean(new URL(value)); } catch { return false; } } });
  ajv.addFormat('date-time', { type: 'string', validate: (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value });
  const validate = ajv.compile(json(schemaPath));
  assert.equal(validate(candidate()), true, ajv.errorsText(validate.errors));
});

test('rvoip G.729 candidate pins source archive and support files', () => {
  prerequisites();
  const value = candidate();
  assert.equal(value.candidate_id, 'rvoip-g729-codec-core-v1');
  assert.deepEqual(value.source, { repository: 'https://github.com/eisenzopf/rvoip', commit: '4ced02b7f6e73041c848f1765dc2bcf7588796f0', tree: '74dabd314841d99e1a87dbdaca6050fc4e8ed923', commit_signature: 'unsigned', archive: { sha256: '16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e', bytes: 8594565 } });
  assert.deepEqual(value.support_files, [
    { path: 'LICENSE', bytes: 1075, sha256: 'd689025d3da6610ea2ff966052e3709e2eb15fc7553e7f2ddf49866e62b24859' },
    { path: 'THIRD_PARTY_NOTICES.md', bytes: 1522, sha256: '172bdddc94e3e07e9c35c895380afdc85e78085a0ff4084f3d52fc85fc93ad12' },
    { path: 'crates/media/codec-core/Cargo.toml', bytes: 1268, sha256: 'ed53b56f67bb1ce3ae63145017893a7b0f003e4a6fd8b8b2b8d39573f1efc2d0' }
  ]);
});

test('rvoip G.729 selected Rust set has exactly the pinned 136-tuple identity', async () => {
  prerequisites();
  const value = candidate(); const selected = value.selected_sources;
  assert.equal(selected.length, 136); assert.equal(value.source_set_sha256, sourceSetSha256);
  assert.equal(sourceDigest(selected), sourceSetSha256);
  const verifier = await import(`../${verifierPath}`);
  assert.equal(typeof verifier.computeRvoipG729SourceSetSha256, 'function');
  assert.equal(verifier.computeRvoipG729SourceSetSha256(selected), sourceSetSha256);
  assert.equal(verifier.computeRvoipG729SourceSetSha256(selected), sourceDigest(selected));
  const paths = selected.map((entry: Record<string, any>) => entry.path);
  assert.deepEqual(paths, [...paths].sort()); assert.equal(new Set(paths).size, 136);
  const targets = new Set<string>();
  for (const entry of selected) {
    assert.match(entry.path, /^crates\/media\/codec-core\/src\/codecs\/g729\/.+\.rs$/);
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0); assert.match(entry.sha256, hex);
    assert.match(entry.planned_target, /^services\/voice-media-rs\/vendor\/rvoip-g729\/.+\.rs$/);
    assert.ok(!targets.has(entry.planned_target), entry.planned_target); targets.add(entry.planned_target);
  }
});

test('rvoip G.729 schema itself closes exact support and selected identities', () => {
  prerequisites();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('uri', {
    type: 'string',
    validate: (value: string) => {
      try { return Boolean(new URL(value)); } catch { return false; }
    }
  });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  });
  const validate = ajv.compile(json(schemaPath));
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ['support path', value => { value.support_files[0].path = 'COPYING'; }],
    ['support bytes', value => { value.support_files[1].bytes += 1; }],
    ['support hash', value => {
      value.support_files[2].sha256 = '0'.repeat(64);
    }],
    ['selected path', value => {
      value.selected_sources[0].path =
        value.selected_sources[1].path;
    }],
    ['selected bytes', value => {
      value.selected_sources[45].bytes += 1;
    }],
    ['selected hash', value => {
      value.selected_sources[90].sha256 = '0'.repeat(64);
    }],
    ['selected target', value => {
      value.selected_sources[135].planned_target =
        'services/voice-media-rs/vendor/rvoip-g729/drift.rs';
    }],
    ['mode identity', value => {
      value.planned_codec_contract.modes[0].mode_id = 'G729';
    }],
    ['frame size', value => {
      value.planned_codec_contract.samples_per_frame = 160;
    }],
    ['packetization', value => {
      value.planned_codec_contract.packetization_ms = [20];
    }],
    ['Annex B fmtp promotion', value => {
      value.planned_codec_contract.annex_b_fmtp_negotiation.status =
        'controlled_pass';
    }],
    ['peer identity promotion', value => {
      value.planned_codec_contract.modes[1].independent_peer.identity =
        'unreviewed-peer';
    }],
    ['quality profile promotion', value => {
      value.planned_codec_contract.modes[0].quality_profile.profile_id =
        'merged-profile-v1';
    }],
    ['legal boundary weakening', value => {
      value.planned_codec_contract.legal_boundary
        .external_legal_conclusion_required = false;
    }],
    ['gate promotion', value => {
      value.gates.annex_b_fmtp_negotiation = 'controlled_pass';
    }]
  ];
  for (const [label, mutate] of cases) {
    const fixture = structuredClone(candidate());
    mutate(fixture);
    assert.equal(validate(fixture), false, label);
  }
});

test('rvoip G.729 candidate separates A and AB engineering contracts', () => {
  const value = candidate();
  assert.deepEqual(value.planned_codec_contract, {
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
  });
});

test('rvoip G.729 candidate authority, vectors, and claims remain closed and unpromoted', () => {
  prerequisites();
  const value = candidate(); const authority = value.dependency_authority;
  assert.equal(authority.authority, 'codec_adapter_only'); assert.equal(authority.closed, true);
  assert.deepEqual(authority.external_allowlist, []);
  assert.deepEqual(authority.internal_allowlist, ['crate::codecs::g729']);
  assert.deepEqual(authority.codec_adapter_allowlist, ['crate::error', 'crate::types']);
  assert.deepEqual(authority.test_only_allowlist, ['crate::codecs::CodecFactory']);
  assert.deepEqual(authority.unresolved, []);
  assert.deepEqual(value.support_file_policy, {
    cargo_toml: 'provenance_only_not_adopted',
    dependency_selection: 'selected_sources_only'
  });
  assert.deepEqual(value.forbidden_source_prefixes, ['rtp', 'runtime', 'session', 'sip', 'webrtc']);
  assert.deepEqual(value.reference_vectors, { status: 'not_run', external_injection_required: true, artifacts: [] });
  assert.deepEqual(Object.keys(value.gates).sort(), [...gates].sort()); for (const gate of gates) assert.equal(value.gates[gate], 'not_run', gate);
  assert.deepEqual(value.claim, { capacity_claim: 'none', production_eligible: false, runtime_enabled: false });
});

test('rvoip fork registry and capacity index pin the planned component', () => {
  prerequisites();
  const registry = json(forksPath); const fork = registry.components.find((entry: Record<string, any>) => entry.component_id === 'rvoip-g729-codec-core');
  assert.ok(fork); assert.equal(fork.lifecycle, 'planned'); assert.equal(fork.integration_mode, 'pinned_source');
  assert.deepEqual(fork.upstream, { repository: 'https://github.com/eisenzopf/rvoip', version: '4ced02b7f6e73041c848f1765dc2bcf7588796f0', pin_kind: 'exact_commit', commit: '4ced02b7f6e73041c848f1765dc2bcf7588796f0', source_identity_complete: true, source_archive: { url: 'https://codeload.github.com/eisenzopf/rvoip/tar.gz/4ced02b7f6e73041c848f1765dc2bcf7588796f0', sha256: '16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e', size_bytes: 8594565 } });
  assert.deepEqual(fork.implemented_changes, []);
  assert.equal(fork.verification.source_identity, 'passed');
  for (const key of ['patch_apply', 'compile', 'unit', 'integration', 'benchmark', 'real_environment']) assert.equal(fork.verification[key], 'not_run', key);
  assert.equal(fork.release_gate.production_eligible, false);
  assert.equal(registry.generated_at, '2026-07-29T16:00:00+08:00');
  const readme = readFileSync(readmePath, 'utf8'); for (const path of [manifestPath, schemaPath, verifierPath]) assert.ok(readme.includes(path), path);
});

test('rvoip G.729 verifier rejects additional properties at every object level', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const cases: Array<[string, (value: any) => void]> = [
    ['candidate', value => { value.unexpected = true; }],
    ['source', value => { value.source.unexpected = true; }],
    ['archive', value => { value.source.archive.unexpected = true; }],
    ['support file', value => { value.support_files[0].unexpected = true; }],
    ['selected source', value => { value.selected_sources[0].unexpected = true; }],
    ['dependency authority', value => { value.dependency_authority.unexpected = true; }],
    ['reference vectors', value => { value.reference_vectors.unexpected = true; }],
    ['gates', value => { value.gates.unexpected = 'not_run'; }],
    ['claim', value => { value.claim.unexpected = false; }]
  ];
  for (const [label, mutate] of cases) {
    const fixture = structuredClone(candidate()); mutate(fixture);
    assert.throws(
      () => verifier.verifyRvoipG729SourceCandidate(fixture),
      /additional propert|unexpected/i,
      label
    );
  }
});

test('rvoip G.729 verifier compares objects independent of key order', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const fixture = structuredClone(candidate());
  fixture.source = reversed(fixture.source);
  fixture.source.archive = reversed(fixture.source.archive);
  fixture.support_files = fixture.support_files.map(reversed);
  fixture.selected_sources = fixture.selected_sources.map(reversed);
  fixture.dependency_authority = reversed(fixture.dependency_authority);
  fixture.dependency_authority.unresolved =
    fixture.dependency_authority.unresolved.map(reversed);
  fixture.reference_vectors = reversed(fixture.reference_vectors);
  fixture.gates = reversed(fixture.gates);
  fixture.claim = reversed(fixture.claim);
  assert.doesNotThrow(() => verifier.verifyRvoipG729SourceCandidate(fixture));
});

test('rvoip G.729 verifier rejects non-canonical time and invalid non-claims', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const time = structuredClone(candidate());
  time.generated_at = '2026-07-29T08:00:00Z';
  assert.throws(
    () => verifier.verifyRvoipG729SourceCandidate(time),
    /generated at|date.time|canonical/i
  );
  for (const nonClaims of [[], [''], ['valid', 7]]) {
    const fixture = structuredClone(candidate());
    fixture.non_claims = nonClaims;
    assert.throws(
      () => verifier.verifyRvoipG729SourceCandidate(fixture),
      /non.claim/i
    );
  }
});

test('rvoip G.729 verifier rejects each unsafe manifest mutation separately', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`); assert.equal(typeof verifier.verifyRvoipG729SourceCandidate, 'function');
  assert.doesNotThrow(() => verifier.verifyRvoipG729SourceCandidate(candidate()));
  const cases: Array<[string, (value: any) => void]> = [
    ['duplicate', value => { value.selected_sources[1].path = value.selected_sources[0].path; }],
    ['unsorted', value => { [value.selected_sources[0], value.selected_sources[1]] = [value.selected_sources[1], value.selected_sources[0]]; }],
    ['bad hash', value => { value.selected_sources[0].sha256 = '0'.repeat(64); }],
    ['bad size', value => { value.selected_sources[0].bytes = 0; }],
    ['planned codec contract', value => {
      value.planned_codec_contract.frame_ms = 20;
    }],
    ['forbidden dependency', value => { value.dependency_authority.external_allowlist.push('rtp-core'); }],
    ['unresolved dependency', value => {
      value.dependency_authority.unresolved.push({
        crate: 'g729-sys',
        version: '0.1.2',
        resolution: 'must_remove_before_runtime_enablement',
        status: 'not_run'
      });
    }],
    ['missing gate', value => { delete value.gates.plc; }],
    ['capacity claim', value => { value.claim.capacity_claim = '1k'; }],
    ['runtime enabled', value => { value.claim.runtime_enabled = true; }],
    ['production eligible', value => { value.claim.production_eligible = true; }],
    ['path traversal', value => { value.selected_sources[0].path = '../escape.rs'; }],
    ['absolute path', value => { value.selected_sources[0].path = '/escape.rs'; }],
    ['control character', value => { value.selected_sources[0].planned_target = 'services/voice-media-rs/vendor/rvoip-g729/a\n.rs'; }]
  ];
  for (const [label, mutate] of cases) { const fixture = structuredClone(candidate()); mutate(fixture); assert.throws(() => verifier.verifyRvoipG729SourceCandidate(fixture), new RegExp(label.replace(' ', '[- ]'), 'i'), label); }
});

test('rvoip G.729 source-tree verifier rejects unlisted files and tuple drift', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`); assert.equal(typeof verifier.verifyRvoipG729SelectedSourceTree, 'function');
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-test-'));
  try {
    mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested', 'a.rs'), 'fn a() {}\n');
    const bytes = readFileSync(join(root, 'nested', 'a.rs')).byteLength; const sha256 = createHash('sha256').update(readFileSync(join(root, 'nested', 'a.rs'))).digest('hex');
    const entries = [{ path: 'nested/a.rs', bytes, sha256, planned_target: 'services/voice-media-rs/vendor/rvoip-g729/nested/a.rs' }];
    assert.doesNotThrow(() => verifier.verifyRvoipG729SelectedSourceTree(entries, root));
    writeFileSync(join(root, 'unexpected.rs'), 'fn surprise() {}\n');
    assert.throws(() => verifier.verifyRvoipG729SelectedSourceTree(entries, root), /unexpected/i, 'unexpected .rs');
    rmSync(join(root, 'unexpected.rs')); entries[0].bytes += 1;
    assert.throws(() => verifier.verifyRvoipG729SelectedSourceTree(entries, root), /size/i, 'size mismatch');
    entries[0].bytes = bytes; writeFileSync(join(root, 'nested', 'a.rs'), 'fn b() {}\n');
    assert.throws(() => verifier.verifyRvoipG729SelectedSourceTree(entries, root), /hash/i, 'hash mismatch');
    writeFileSync(join(root, 'nested', 'a.rs'), 'fn a() {}\n');
    const forbidden = 'use crate::runtime::Session;\nfn a() {}\n';
    writeFileSync(join(root, 'nested', 'a.rs'), forbidden);
    entries[0].bytes = Buffer.byteLength(forbidden);
    entries[0].sha256 = createHash('sha256').update(forbidden).digest('hex');
    assert.throws(
      () => verifier.verifyRvoipG729SelectedSourceTree(entries, root),
      /dependency|crate::runtime/i,
      'undeclared dependency root'
    );
    const misplacedTestDependency =
      'use crate::codecs::CodecFactory;\nfn a() {}\n';
    writeFileSync(join(root, 'nested', 'a.rs'), misplacedTestDependency);
    entries[0].bytes = Buffer.byteLength(misplacedTestDependency);
    entries[0].sha256 = createHash('sha256')
      .update(misplacedTestDependency).digest('hex');
    assert.throws(
      () => verifier.verifyRvoipG729SelectedSourceTree(entries, root),
      /test.only|CodecFactory/i,
      'test-only dependency used at runtime'
    );
    const allowedDependencies = [
      'use crate::codecs::g729::impls;',
      'use crate::error::CodecError;',
      'use crate::types::AudioCodec;',
      '#[cfg(test)]',
      'mod tests { use crate::codecs::CodecFactory; }',
      'fn a() {}',
      ''
    ].join('\n');
    writeFileSync(join(root, 'nested', 'a.rs'), allowedDependencies);
    entries[0].bytes = Buffer.byteLength(allowedDependencies);
    entries[0].sha256 = createHash('sha256')
      .update(allowedDependencies).digest('hex');
    assert.doesNotThrow(
      () => verifier.verifyRvoipG729SelectedSourceTree(entries, root)
    );
    writeFileSync(join(root, 'nested', 'a.rs'), 'fn a() {}\n');
    entries[0].bytes = bytes;
    entries[0].sha256 = sha256;
    symlinkSync(tmpdir(), join(root, 'outside'));
    assert.throws(() => verifier.verifyRvoipG729SelectedSourceTree(entries, root), /symlink|outside/i, 'outside symlink');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 pinned exceptions require the exact 136-tuple identity', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-count-only-'));
  try {
    const entries = Array.from({ length: 136 }, (_, index) => {
      const path = `fixture-${String(index).padStart(3, '0')}.rs`;
      const body = index === 0 ? 'use serde::Serialize;\n' : '// local\n';
      writeFileSync(join(root, path), body);
      return {
        path,
        bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        planned_target: `services/voice-media-rs/vendor/rvoip-g729/${path}`
      };
    });
    assert.throws(
      () => verifier.verifyRvoipG729SelectedSourceTree(entries, root),
      /undeclared external dependency.*serde/i
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 dependency audit rejects external, grouped, and spaced imports', async t => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-dependencies-'));
  try {
    const cases = [
      'use serde::Serialize;\n',
      'use rtp_core::Session;\n',
      'extern crate sip_core;\n',
      'use crate::{runtime::Session};\n',
      'use crate :: runtime :: Session;\n',
      'use { crate::types::AudioCodec, serde::Serialize };\n'
    ];
    for (const body of cases) {
      await t.test(body.trim(), () => {
        assert.throws(
          () => verifier.verifyRvoipG729SelectedSourceTree(
            syntheticSourceEntry(root, body),
            root
          ),
          /dependency|external|serde|rtp_core|sip_core|runtime/i
        );
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 dependency audit ignores comments and Rust literals', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-lexical-'));
  try {
    const body = [
      '// use crate::runtime::Session;',
      '/* extern crate sip_core; /* use serde::Serialize; */ */',
      'const NORMAL: &str = "crate::runtime::Session }";',
      'const BYTE: &[u8] = b"use rtp_core::Session; {";',
      'const RAW: &str = r##"{ use serde::Serialize; }"##;',
      "const BRACE: char = '}';",
      '#[cfg(test)]',
      'mod tests { use crate::codecs::CodecFactory; }',
      'fn a() {}',
      ''
    ].join('\n');
    assert.doesNotThrow(
      () => verifier.verifyRvoipG729SelectedSourceTree(
        syntheticSourceEntry(root, body),
        root
      )
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 dependency audit keeps runtime imports outside tokenized cfg(test)', async () => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-cfg-test-'));
  try {
    const body = [
      '#[cfg(test)]',
      'mod tests {',
      '  const NORMAL: &str = "{ crate::codecs::CodecFactory";',
      '  const RAW: &str = r##"{"##;',
      "  const BRACE: char = '{';",
      '  use crate::codecs::CodecFactory;',
      '}',
      'use crate::codecs::CodecFactory;',
      'const NORMAL_CLOSE: &str = "} crate::codecs::CodecFactory";',
      'const RAW_CLOSE: &str = r##"}"##;',
      "const BRACE_CLOSE: char = '}';",
      ''
    ].join('\n');
    assert.throws(
      () => verifier.verifyRvoipG729SelectedSourceTree(
        syntheticSourceEntry(root, body),
        root
      ),
      /test.only|CodecFactory|dependency/i
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 dependency lexer handles conservative Rust syntax edges', async t => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-rust-syntax-'));
  try {
    await t.test('raw local identifiers and lifetimes stay local', () => {
      const body = [
        'mod r#local {}',
        'use r#local::Thing;',
        "fn borrowed<'a>(value: &'a str) -> &'a str { value }",
        ''
      ].join('\n');
      assert.doesNotThrow(
        () => verifier.verifyRvoipG729SelectedSourceTree(
          syntheticSourceEntry(root, body),
          root
        )
      );
    });
    await t.test('aliases, globs, and trailing commas remain supported', () => {
      const body = 'use crate::types::{AudioCodec as Codec, *,};\n';
      assert.doesNotThrow(
        () => verifier.verifyRvoipG729SelectedSourceTree(
          syntheticSourceEntry(root, body),
          root
        )
      );
    });
    for (const body of [
      'use super::super::runtime::Session;\n',
      '#[cfg(any(test))] mod tests { use crate::codecs::CodecFactory; }\n',
      '#[cfg_attr(test, cfg(test))] mod tests { use crate::codecs::CodecFactory; }\n',
      'fn malformed( {\n',
      'const UNTERMINATED: &str = "dependency text;\n',
      "const UNTERMINATED_CHAR: char = 'x;\n",
      "const UNTERMINATED_CHAR: char = 'x",
      "const UNTERMINATED_CHAR: char = 'x,\n",
      "fn malformed() { consume('x); }\n"
    ]) {
      await t.test(`reject ${body.trim()}`, () => {
        assert.throws(
          () => verifier.verifyRvoipG729SelectedSourceTree(
            syntheticSourceEntry(root, body),
            root
          ),
          /dependency|test.only|malformed|unterminated|unbalanced|super/i
        );
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 dependency lexer validates maximal paths with lexical scope', async t => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-path-scope-'));
  try {
    for (const body of [
      'fn f(_: serde::Serialize) {}\n',
      'fn f(_: ::serde::Serialize) {}\n',
      'fn f() { serde::do_it(); }\n',
      '#[derive(serde::Serialize)] struct Derived;\n',
      'fn f() { super::super::runtime::run(); }\n',
      'mod outer { mod serde {} }\nuse serde::Serialize;\n',
      'mod serde中 {}\nuse serde::Serialize;\n',
      '#[cfg(test)] mod serde {}\nuse serde::Serialize;\n',
      '#[cfg(test)] pub mod serde {}\nuse serde::Serialize;\n',
      [
        '#[cfg(test)] pub use crate::types as serde;',
        'use serde::Serialize;',
        ''
      ].join('\n'),
      '#[cfg(test)] mod tests { mod serde {} }\nuse serde::Serialize;\n',
      [
        'macro_rules! phantom (() => (mod serde {}));',
        'use serde::Serialize;',
        ''
      ].join('\n'),
      [
        'macro_rules! phantom { () => { mod serde {} } }',
        'use serde::Serialize;',
        ''
      ].join('\n'),
      'fn serde() {}\nfn f(_: serde::Serialize) {}\n',
      'const serde: u8 = 0;\nfn f(_: serde::Serialize) {}\n',
      'static serde: u8 = 0;\nfn f(_: serde::Serialize) {}\n',
      'use serde as serde;\n',
      'use First as Second;\nuse Second as First;\n',
      [
        'fn inner() { use crate::types::AudioCodec as Codec; }',
        'fn outer(_: Codec::Associated) {}',
        ''
      ].join('\n')
    ]) {
      await t.test(`reject ${body.trim()}`, () => {
        assert.throws(
          () => verifier.verifyRvoipG729SelectedSourceTree(
            syntheticSourceEntry(root, body),
            root
          ),
          /dependency|external|serde|scope/i
        );
      });
    }
    for (const body of [
      'fn r#use() {}\n',
      [
        'struct RawField { r#type: i32 }',
        'fn read(value: RawField) -> i32 { value.r#type }',
        ''
      ].join('\n'),
      'mod serde {}\nfn f(_: serde::Serialize) {}\n',
      'pub mod serde {}\nfn f(_: serde::Serialize) {}\n',
      'struct Local;\nfn f(_: Local::Associated) {}\n',
      'pub struct serde;\nfn f(_: serde::Serialize) {}\n',
      'fn local<T>() {}\nfn f() { local::<u8>(); }\n',
      'pub fn serde<T>() {}\nfn f() { serde::<u8>(); }\n',
      [
        'use crate::types::AudioCodec as Codec;',
        'fn f(_: Codec::Associated) {}',
        ''
      ].join('\n'),
      [
        'pub use crate::types as serde;',
        'fn f(_: serde::AudioCodec) {}',
        ''
      ].join('\n'),
      [
        'use crate::types as LocalTypes;',
        'use LocalTypes::AudioCodec as Codec;',
        'fn f(_: Codec::Associated) {}',
        ''
      ].join('\n')
    ]) {
      await t.test(`allow ${body.trim()}`, () => {
        assert.doesNotThrow(
          () => verifier.verifyRvoipG729SelectedSourceTree(
            syntheticSourceEntry(root, body),
            root
          )
        );
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 dependency lexer never promotes attributed items to unconditional local roots', async t => {
  prerequisites();
  const verifier = await import(`../${verifierPath}`);
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-attributed-roots-'));
  try {
    const cases = [
      [
        'cfg(any(test)) module',
        '#[cfg(any(test))] mod serde {}\nuse serde::Serialize;\n'
      ],
      [
        'cfg(feature) import',
        [
          '#[cfg(feature = "local-serde")] use crate::types as serde;',
          'use serde::Serialize;',
          ''
        ].join('\n')
      ],
      [
        'cfg_attr module',
        [
          '#[cfg_attr(feature = "local-serde", path = "generated.rs")]',
          'mod serde {}',
          'use serde::Serialize;',
          ''
        ].join('\n')
      ],
      [
        'attribute macro module',
        '#[generated] pub mod serde {}\nuse serde::Serialize;\n'
      ],
      [
        'attribute macro import',
        '#[generated] pub(crate) use crate::types as serde;\nuse serde::Serialize;\n'
      ],
      [
        'attribute macro declared binding',
        '#[generated] pub struct serde;\nfn f(_: serde::Serialize) {}\n'
      ],
      [
        'attribute macro generic callable binding',
        '#[generated] pub fn serde<T>() {}\nfn f() { serde::<u8>(); }\n'
      ]
    ] as const;
    for (const [label, body] of cases) {
      await t.test(label, () => {
        assert.throws(
          () => verifier.verifyRvoipG729SelectedSourceTree(
            syntheticSourceEntry(root, body),
            root
          ),
          /dependency|external|serde|scope/i
        );
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 CLI rejects archive and support-file symlinks before hashing', () => {
  prerequisites();
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-cli-symlink-'));
  try {
    const target = join(root, 'target');
    writeFileSync(target, 'not trusted\n');
    const archiveLink = join(root, 'archive.tar.gz');
    symlinkSync(target, archiveLink);
    const archiveResult = runVerifier(archiveLink, root);
    assert.notEqual(archiveResult.status, 0);
    assert.match(
      String(archiveResult.stderr),
      /archive.*symlink|symlink.*archive/i
    );

    rmSync(archiveLink);
    writeFileSync(archiveLink, 'not an archive\n');
    symlinkSync(target, join(root, 'LICENSE'));
    const supportResult = runVerifier(archiveLink, root);
    assert.notEqual(supportResult.status, 0);
    assert.match(
      String(supportResult.stderr),
      /support.*symlink|symlink.*support/i
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rvoip G.729 CLI rejects source-root and descendant symlink components', async t => {
  prerequisites();
  const root = mkdtempSync(join(tmpdir(), 'rvoip-g729-source-root-symlink-'));
  try {
    const archive = join(root, 'archive.tar.gz');
    writeFileSync(archive, 'not an archive\n');
    const realRoot = join(root, 'real');
    mkdirSync(join(realRoot, 'crates', 'media', 'codec-core'), { recursive: true });
    writeFileSync(join(realRoot, 'LICENSE'), 'license\n');
    writeFileSync(join(realRoot, 'THIRD_PARTY_NOTICES.md'), 'notices\n');
    writeFileSync(
      join(realRoot, 'crates', 'media', 'codec-core', 'Cargo.toml'),
      'cargo\n'
    );
    const sourceRootLink = join(root, 'source-root-link');
    symlinkSync(realRoot, sourceRootLink);
    await t.test('direct source-root symlink', () => {
      const rootResult = runVerifier(archive, sourceRootLink);
      assert.notEqual(rootResult.status, 0);
      assert.match(
        String(rootResult.stderr),
        /source root.*symlink|symlink.*source root/i
      );
    });

    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'codecs', 'g729'), { recursive: true });
    mkdirSync(join(realRoot, 'crates', 'media', 'codec-core', 'src'));
    symlinkSync(
      join(outside, 'codecs'),
      join(realRoot, 'crates', 'media', 'codec-core', 'src', 'codecs')
    );
    await t.test('source-tree ancestor symlink', () => {
      const linkedComponentResult = runVerifier(archive, realRoot);
      assert.notEqual(linkedComponentResult.status, 0);
      assert.match(
        String(linkedComponentResult.stderr),
        /source root.*symlink|symlink.*source root/i
      );
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
