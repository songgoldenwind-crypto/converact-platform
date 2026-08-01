import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  type ConveractNamingPolicy,
  loadNamingPolicy,
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
        reason: 'Fixture compatibility boundary.',
        owner: 'platform-foundation',
        removal_condition: 'Remove after the fixture compatibility window.',
        evidence: 'docs/migrations/opc-to-converact-v1.md',
      },
      {
        id: 'immutable_migration_identifiers',
        path_globs: ['src/migrations/**'],
        tokens: ['OPC', 'iveKit'],
        reason: 'Fixture migration identifiers are append-only compatibility surfaces.',
        owner: 'data-platform',
        removal_condition: 'Retain while any database can contain the migration.',
        evidence: 'docs/migrations/opc-to-converact-v1.md',
      },
      {
        id: 'stable_api_paths',
        path_globs: ['src/**'],
        tokens: ['OPC', 'iveKit'],
        match_patterns: ['(?:^|/)api/(?:opc|ivekit)(?:/|$)'],
        reason: 'Fixture API paths remain stable during the name migration.',
        owner: 'platform-api',
        removal_condition: 'Remove only in a versioned API migration.',
        evidence: 'docs/migrations/opc-to-converact-v1.md',
      },
    ],
    historical: [
      {
        id: 'evidence',
        path_globs: ['docs/evidence/**'],
        tokens: ['OPC', 'iveKit'],
        reason: 'Fixture evidence is immutable.',
        owner: 'platform-assurance',
        removal_condition: 'Never rewrite signed fixture evidence.',
        evidence: 'docs/evidence/release.md',
      },
      {
        id: 'archived_plan',
        path_globs: ['docs/superpowers/**'],
        tokens: ['OPC', 'iveKit'],
        reason: 'Fixture plan records a superseded implementation decision.',
        owner: 'platform-assurance',
        removal_condition: 'Retain as historical design provenance.',
        evidence: 'docs/design/2026-07-31-converact-full-rename-implementation-plan.md',
      },
      {
        id: 'patch',
        path_globs: ['patches/**'],
        tokens: ['OPC', 'iveKit'],
        reason: 'Fixture patch payload is immutable.',
        owner: 'supply-chain',
        removal_condition: 'Remove with the corresponding upstream version.',
        evidence: 'patches/source.patch',
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
    'src/migrations/001_ivekit.sql',
    'docs/superpowers/old-opc-plan.md',
    '.github/workflows/build.yml',
  ];

  try {
    writeFixture(
      root,
      paths[0],
      "export const name = 'OPC Platform'; export const path = '/api/ivekit/calls';\n",
    );
    writeFixture(root, paths[1], '{"name":"@opc/ivekit-sdk"}\n');
    writeFixture(root, paths[2], "export const legacyKey = 'OPC_API_KEY';\n");
    writeFixture(root, paths[3], '# OPC release evidence\n');
    writeFixture(root, paths[4], 'iveKit patch provenance\n');
    writeFixture(root, paths[5], 'CREATE TABLE opc_ivekit_calls ();\n');
    writeFixture(root, paths[6], '# OPC / iveKit superseded plan\n');
    writeFixture(
      root,
      paths[7],
      'uses: songgoldenwind-crypto/opc-platform/.github/actions/build@main\n',
    );

    const result = evaluateNamingPolicy(scanLegacyNames(root, basePolicy, paths));

    assert.equal(result.counts.compatibility, 5);
    assert.equal(result.counts.historical, 5);
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
        {
          id: 'compatibility_rule',
          path_globs: ['ambiguous.txt'],
          tokens: ['OPC'],
          reason: 'Fixture compatibility rule.',
          owner: 'platform-foundation',
          removal_condition: 'Remove after fixture compatibility support ends.',
          evidence: 'ambiguous.txt',
        },
      ],
      historical: [
        {
          id: 'historical_rule',
          path_globs: ['ambiguous.txt'],
          tokens: ['OPC'],
          reason: 'Fixture historical rule.',
          owner: 'platform-assurance',
          removal_condition: 'Retain the fixture historical record.',
          evidence: 'ambiguous.txt',
        },
      ],
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

test('rejects classification rules without complete governance metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-policy-metadata-'));
  const policyPath = join(root, 'policy.json');
  const invalid = structuredClone(basePolicy);
  delete (invalid.classifications.compatibility[0] as { evidence?: string }).evidence;

  try {
    writeFileSync(policyPath, JSON.stringify(invalid));
    assert.throws(
      () => loadNamingPolicy(policyPath),
      /Invalid Converact naming policy/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('repository policy recognizes the direct IVEKIT environment compatibility prefix', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');

  assert.deepEqual(policy.environment.legacyPrefixes, [
    'OPC_',
    'OPC_IVEKIT_',
    'IVEKIT_',
  ]);
  const aliasRule = policy.classifications.compatibility.find(
    (rule) => rule.id === 'environment_compatibility_alias',
  );
  assert.ok(aliasRule);
  assert.ok(aliasRule.tokens.includes('IVEKIT_'));
});

test('repository policy preserves frozen versioned machine contracts byte-for-byte', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'docs/architecture/communication-technology-baseline-v1.json',
    'docs/architecture/component-authority-matrix-v1.json',
    'docs/architecture/valkey-command-inventory-v1.json',
    'docs/capacity/contracts/rvoip-capability-integration-v1.json',
    'docs/capacity/schemas/voice-media-goal3.schema.json',
    'docs/capacity/profiles/mix-100k-v1.json',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.rule))],
    ['immutable_versioned_machine_contracts'],
  );
});

test('repository policy preserves the v1 backup marker and primary database identity', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'src/agent-runtime/converact/operations/backup-runner.ts',
    'src/agent-runtime/converact/operations/backup.ts',
    'test/converact-backup-runner.test.ts',
    'test/converact-backup.test.ts',
  ]).filter((finding) =>
    finding.rule !== 'durable_database_metric_and_wire_identifiers'
  );

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.rule))],
    ['backup_v1_identity'],
  );
});

test('repository policy treats the superseded full objective as historical provenance', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'docs/capacity/contracts/unified-voice-foundation-historical-objective.md',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['historical'],
  );
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.rule))],
    ['superseded_full_objective'],
  );
});

test('repository policy preserves deployed Kamailio wire, metric, and dialog-state identifiers', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'src/agent-runtime/converact/voice/kamailio-config.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.rule))],
    ['durable_database_metric_and_wire_identifiers'],
  );
});

test('standalone PostgreSQL tests use current fixture names and only retain compatibility identifiers', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'test/converact-standalone-postgres.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('media-control entrypoint exposes only current environment keys and stable RTPengine commands', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'scripts/converact-media-control-agent.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('dialog recovery deployment uses current sidecar keys and preserves only the RustPBX fork ABI', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'test/converact-dialog-recovery-deployment.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('voice deployment uses current product names around the embedded RustPBX ABI', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'test/converact-voice-deployment.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.equal(findings.some((finding) => finding.disposition === 'rename'), false);
  assert.equal(findings.some((finding) => finding.disposition === 'unclassified'), false);
  assert.ok(findings.some((finding) => finding.rule === 'embedded_fork_environment_abi'));
});

test('dialog shadow runtime uses current keys while retaining its durable JetStream name', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'src/agent-runtime/converact/voice/dialog-shadow-runtime.ts',
    'test/converact-dialog-shadow-runtime.test.ts',
    'test/converact-dialog-shadow-jetstream.test.ts',
    'test/converact-dialog-shadow-quorum.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('RustPBX builder uses current inputs while preserving immutable patch provenance', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'infra/converact/rustpbx/build.sh',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('RTPengine overlay sources and assertions preserve only the pinned source ABI', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'infra/converact/rtpengine/overlay-tests/ivekit_replay_protocol_test.py',
    'test/converact-rtpengine-source-overlay.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('RTPengine runtime keeps wire commands while active fallbacks and Goal 2 inputs are current', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'scripts/converact-rtpengine-acceptance.ts',
    'scripts/converact-voice-media-goal2-finalize.ts',
    'src/agent-runtime/converact/media-control/rtpengine.ts',
    'test/converact-rtpengine-media-transport.test.ts',
    'test/converact-voice-media-goal2-contract.test.ts',
    'test/converact-voice-media-goal2-finalizer.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.equal(findings.some((finding) => finding.disposition === 'rename'), false);
  assert.equal(findings.some((finding) => finding.disposition === 'unclassified'), false);
  assert.ok(findings.some((finding) => finding.rule === 'rtpengine_control_command_abi'));
  assert.ok(findings.some((finding) => finding.rule === 'rtpengine_goal2_v1_source_contract'));
});

test('LiveKit Egress keeps only its pinned source ABI, fork ABI, and durable metrics', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'infra/converact/livekit-egress/apply-overlay.mjs',
    'infra/converact/livekit-egress/build-converact.sh',
    'infra/converact/livekit-egress/build.sh',
    'infra/converact/livekit-egress/README.md',
    'infra/k8s/templates/livekit-egress-deployment.yaml',
    'test/converact-livekit-egress-pool-patch.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.equal(findings.some((finding) => finding.disposition === 'rename'), false);
  assert.equal(findings.some((finding) => finding.disposition === 'unclassified'), false);
  assert.ok(findings.some((finding) => finding.rule === 'livekit_egress_v1_source_abi'));
  assert.ok(
    findings.some(
      (finding) => finding.rule === 'durable_database_metric_and_wire_identifiers',
    ),
  );
});

test('LiveKit Ingress uses current build inputs around its pinned source ABI', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    '.github/workflows/converact-livekit-ingress-image.yml',
    'infra/converact/livekit-ingress/apply-overlay.mjs',
    'infra/converact/livekit-ingress/build-converact.sh',
    'infra/converact/livekit-ingress/build.sh',
    'infra/converact/livekit-ingress/README.md',
    'test/converact-livekit-ingress-foundation.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.equal(findings.some((finding) => finding.disposition === 'rename'), false);
  assert.equal(findings.some((finding) => finding.disposition === 'unclassified'), false);
  assert.ok(findings.some((finding) => finding.rule === 'livekit_ingress_v1_source_abi'));
});

test('Tinode build uses current inputs around the pinned v0.25.3 source ABI', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'infra/converact/tinode/apply-overlay.mjs',
    'infra/converact/tinode/build-converact.sh',
    'infra/converact/tinode/build.sh',
    'infra/converact/tinode/README.md',
    'infra/converact/tinode/server-hook.go',
    'infra/converact/tinode/server-hook_test.go',
    'integrations/tinode-v0.25.3/registry.go',
    'test/converact-tinode-owner-patch.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.equal(findings.some((finding) => finding.disposition === 'rename'), false);
  assert.equal(findings.some((finding) => finding.disposition === 'unclassified'), false);
  assert.ok(findings.some((finding) => finding.rule === 'tinode_v0_25_3_source_abi'));
  assert.ok(findings.some((finding) => finding.rule === 'embedded_fork_environment_abi'));
});

test('RustDesk keeps pinned native ABI while active configuration uses Converact names', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'infra/converact/rustdesk-server/apply-overlay.mjs',
    'infra/converact/rustdesk-server/server-hook.rs',
    'integrations/rustdesk-1.4.9/apply-overlay.mjs',
    'integrations/rustdesk-1.4.9/ivekit_native_control.rs',
    'integrations/rustdesk-1.4.9/ivekit_native_evidence.rs',
    'scripts/converact-rustdesk-led-example.ts',
    'test/converact-rustdesk-server-owner-patch.test.ts',
    'test/rustdesk-native-control-overlay.test.ts',
    'test/rustdesk-windows-package.test.ts',
    'test/rustdesk-windows-session-companion.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.equal(findings.some((finding) => finding.disposition === 'rename'), false);
  assert.equal(findings.some((finding) => finding.disposition === 'unclassified'), false);
  assert.ok(findings.some((finding) => finding.rule === 'rustdesk_pinned_source_abi'));
  assert.ok(
    findings.some((finding) => finding.rule === 'rustdesk_led_legacy_environment_alias'),
  );
  assert.ok(
    findings.some(
      (finding) => finding.rule === 'durable_database_metric_and_wire_identifiers',
    ),
  );
});

test('delivery generation uses current names and retains only explicit source and wire compatibility', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'scripts/converact-delivery-bundle.ts',
    'test/converact-delivery-bundle.test.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('chat HTTP keeps the published /api/ivekit route family as its only legacy surface', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'src/agent-runtime/converact/chat-http.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('readiness checks retain append-only migration and database identifiers', () => {
  const policy = loadNamingPolicy('config/branding/converact-naming-policy.json');
  const findings = scanLegacyNames(process.cwd(), policy, [
    'src/agent-runtime/converact/operations/readiness.ts',
  ]);

  assert.ok(findings.length > 0);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.disposition))],
    ['compatibility'],
  );
});

test('match patterns are case-sensitive so durable snake-case IDs cannot hide legacy env keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-policy-case-'));
  const policy: ConveractNamingPolicy = {
    ...basePolicy,
    classifications: {
      ...basePolicy.classifications,
      compatibility: [
        {
          id: 'stable_metric',
          path_globs: ['config/metrics.yml'],
          tokens: ['OPC'],
          match_patterns: ['^opc_[a-z0-9_]+$'],
          reason: 'Fixture metric identifiers remain stable.',
          owner: 'platform-observability',
          removal_condition: 'Remove only through a versioned metric migration.',
          evidence: 'config/metrics.yml',
        },
      ],
    },
  };

  try {
    writeFixture(
      root,
      'config/metrics.yml',
      'metric: opc_media_calls_total\nenv: OPC_MEDIA_CALLS_TOTAL\n',
    );
    const result = evaluateNamingPolicy(
      scanLegacyNames(root, policy, ['config/metrics.yml']),
    );

    assert.equal(result.counts.compatibility, 1);
    assert.equal(result.counts.rename, 1);
    assert.equal(result.violations[0]?.token, 'OPC_MEDIA_CALLS_TOTAL');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
