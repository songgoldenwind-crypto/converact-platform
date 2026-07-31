import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  type ConveractNamingPolicy,
  scanLegacyNames,
} from '../scripts/converact-name-inventory.js';
import { evaluateNamingPolicy } from '../scripts/verify-converact-naming.js';

const basePolicy: ConveractNamingPolicy = {
  schema_version: 1,
  brand: { current: 'Converact', legacy: ['OPC', 'iveKit'] },
  repository: {
    current: 'songgoldenwind-crypto/converact-platform',
    legacy: 'songgoldenwind-crypto/opc-platform',
  },
  environment: {
    currentPrefixes: ['CONVERACT_', 'CONVERACT_FABRIC_'],
    legacyPrefixes: ['OPC_', 'OPC_IVEKIT_'],
  },
  classifications: {
    compatibility: [
      {
        id: 'environment_alias',
        path_globs: ['src/config/converact-env.ts'],
        tokens: ['OPC_'],
      },
    ],
    historical: [
      {
        id: 'evidence',
        path_globs: ['docs/evidence/**'],
        tokens: ['OPC', 'iveKit'],
      },
      {
        id: 'patch',
        path_globs: ['patches/**'],
        tokens: ['OPC', 'iveKit'],
      },
    ],
    external: [],
  },
};

function writeFixture(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

test('fails active legacy names while preserving explicit compatibility and history', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-policy-'));
  const paths = [
    'src/product.ts',
    'sdk/ivekit/package.json',
    'src/config/converact-env.ts',
    'docs/evidence/release.md',
    'patches/source.patch',
    '.github/workflows/build.yml',
  ];

  try {
    writeFixture(root, paths[0], "export const name = 'OPC Platform';\n");
    writeFixture(root, paths[1], '{"name":"@opc/ivekit-sdk"}\n');
    writeFixture(root, paths[2], "export const legacyKey = 'OPC_API_KEY';\n");
    writeFixture(root, paths[3], '# OPC release evidence\n');
    writeFixture(root, paths[4], 'iveKit patch provenance\n');
    writeFixture(
      root,
      paths[5],
      'uses: songgoldenwind-crypto/opc-platform/.github/actions/build@main\n',
    );

    const result = evaluateNamingPolicy(scanLegacyNames(root, basePolicy, paths));

    assert.equal(result.counts.compatibility, 1);
    assert.equal(result.counts.historical, 2);
    assert.equal(result.counts.unclassified, 0);
    assert.deepEqual(
      [...new Set(result.violations.map((finding) => finding.path))],
      ['.github/workflows/build.yml', 'sdk/ivekit/package.json', 'src/product.ts'],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('fails closed when policy rules assign different dispositions', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-policy-conflict-'));
  const ambiguousPolicy: ConveractNamingPolicy = {
    ...basePolicy,
    classifications: {
      ...basePolicy.classifications,
      compatibility: [
        { id: 'compatibility_rule', path_globs: ['ambiguous.txt'], tokens: ['OPC'] },
      ],
      historical: [{ id: 'historical_rule', path_globs: ['ambiguous.txt'], tokens: ['OPC'] }],
    },
  };

  try {
    writeFixture(root, 'ambiguous.txt', 'OPC\n');
    const result = evaluateNamingPolicy(
      scanLegacyNames(root, ambiguousPolicy, ['ambiguous.txt']),
    );

    assert.equal(result.counts.unclassified, 1);
    assert.equal(result.violations[0]?.rule, 'ambiguous_policy_rules');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
