import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  type ConveractNamingPolicy,
  excludeGeneratedOutputs,
  scanLegacyNames,
} from '../scripts/converact-name-inventory.js';

const policy: ConveractNamingPolicy = {
  schema_version: 1,
  brand: {
    current: 'Converact',
    legacy: ['OPC', 'iveKit'],
  },
  repository: {
    current: 'songgoldenwind-crypto/converact-platform',
    legacy: 'songgoldenwind-crypto/opc-platform',
  },
  environment: {
    currentPrefixes: ['CONVERACT_', 'CONVERACT_FABRIC_'],
    legacyPrefixes: ['OPC_', 'OPC_IVEKIT_', 'IVEKIT_'],
  },
  classifications: {
    compatibility: [
      {
        id: 'legacy_environment_alias',
        path_globs: ['config/compatibility/**'],
        tokens: ['OPC_'],
        reason: 'Fixture environment compatibility boundary.',
        owner: 'platform-foundation',
        removal_condition: 'Remove after the fixture compatibility window.',
        evidence: 'config/compatibility/env.txt',
      },
    ],
    external: [],
    historical: [
      {
        id: 'historical_evidence',
        path_globs: ['docs/evidence/**'],
        tokens: ['OPC', 'iveKit'],
        reason: 'Fixture evidence remains immutable.',
        owner: 'platform-assurance',
        removal_condition: 'Never rewrite the fixture evidence.',
        evidence: 'docs/evidence/release.md',
      },
    ],
  },
};

test('classifies only an active legacy product name as a rename violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-name-inventory-'));

  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'config/compatibility'), { recursive: true });
    mkdirSync(join(root, 'docs/evidence'), { recursive: true });
    writeFileSync(join(root, 'src/product.ts'), "export const product = 'OPC Platform';\n");
    writeFileSync(join(root, 'config/compatibility/env.txt'), 'OPC_API_KEY\n');
    writeFileSync(join(root, 'docs/evidence/release.md'), '# iveKit release evidence\n');

    const findings = scanLegacyNames(root, policy, [
      'src/product.ts',
      'config/compatibility/env.txt',
      'docs/evidence/release.md',
    ]);

    assert.deepEqual(
      findings
        .filter((finding) => finding.disposition === 'rename')
        .map((finding) => finding.rule),
      ['legacy_product_name'],
    );
    assert.deepEqual(
      findings.map(({ disposition, path, token }) => ({ disposition, path, token })),
      [
        {
          disposition: 'compatibility',
          path: 'config/compatibility/env.txt',
          token: 'OPC_API_KEY',
        },
        {
          disposition: 'historical',
          path: 'docs/evidence/release.md',
          token: 'iveKit',
        },
        {
          disposition: 'rename',
          path: 'src/product.ts',
          token: 'OPC',
        },
      ],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('excludes generated reports from their own inventory inputs', () => {
  assert.deepEqual(
    excludeGeneratedOutputs(
      ['src/product.ts', 'docs/design/converact-rename-inventory.md'],
      '/repo',
      ['docs/design/converact-rename-inventory.md'],
    ),
    ['src/product.ts'],
  );
});

test('derives every legacy matcher from the supplied policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-name-policy-'));
  const alternatePolicy: ConveractNamingPolicy = {
    ...policy,
    brand: { current: 'Current', legacy: ['OLD', 'LegacyKit'] },
    repository: { current: 'owner/current', legacy: 'owner/old-platform' },
    environment: {
      currentPrefixes: ['CURRENT_'],
      legacyPrefixes: ['LEGACY_'],
    },
    classifications: { compatibility: [], external: [], historical: [] },
  };

  try {
    writeFileSync(
      join(root, 'product.txt'),
      'OLD Platform\nLegacyKit engine\nLEGACY_API_KEY\nowner/old-platform\n',
    );

    assert.deepEqual(
      scanLegacyNames(root, alternatePolicy, ['product.txt']).map((finding) => finding.token),
      ['OLD', 'LegacyKit', 'LEGACY_API_KEY', 'owner/old-platform'],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('does not detect IVEKIT inside LIVEKIT or current LiveKit keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-name-livekit-boundary-'));

  try {
    writeFileSync(
      join(root, 'environment.txt'),
      'LIVEKIT_API_KEY\nCONVERACT_LIVEKIT_API_KEY\nIVEKIT_API_KEY\n',
    );

    assert.deepEqual(
      scanLegacyNames(root, policy, ['environment.txt']).map((finding) => finding.token),
      ['IVEKIT_API_KEY'],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
