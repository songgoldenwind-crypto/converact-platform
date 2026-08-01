import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));
const relativeGoalPath = relative(repositoryRoot, goalDirectory).replaceAll('\\', '/');
const workspaceRoots = {
  canonical: repositoryRoot,
  legacy_desktop: '/Users/songjinfeng/Desktop/opc',
  legacy_ivekit: '/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3',
  frozen_production: '/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730',
};

const documents = {
  workspace: {
    schema: 'workspace-inventory-v1.schema.json',
    document: 'workspace-inventory-v1.json',
    invalid: 'fixtures/invalid-workspace-inventory.json',
  },
  traceability: {
    schema: 'requirement-traceability-v1.schema.json',
    document: 'requirement-traceability-v1.json',
    invalid: 'fixtures/invalid-requirement-traceability.json',
  },
  registry: {
    schema: 'status-and-evidence-registry-v1.schema.json',
    document: 'status-and-evidence-registry-v1.json',
    invalid: 'fixtures/invalid-status-registry.json',
  },
};

const requiredMarkdown = [
  '2026-07-31-goal-00-execution-plan.md',
  'execution-baseline.md',
  'overlap-and-authority-ledger.md',
  'canonical-execution-root-decision.md',
  'file-level-migration-sequence.md',
  'independent-review.md',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Value(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitBuffer(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: null });
}

function gitText(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function splitNul(value) {
  return value.toString('utf8').split('\0').filter(Boolean);
}

function parseStatusPaths(raw) {
  const values = new Map();
  const tokens = splitNul(raw);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    const states = [];
    if (xy === '??') states.push('untracked');
    if (![' ', '?', '!'].includes(xy[0])) states.push('staged');
    if (![' ', '?', '!'].includes(xy[1])) states.push('unstaged');
    values.set(path, states);
    if (xy.includes('R') || xy.includes('C')) index += 1;
  }
  return values;
}

function resolveArtifactPath(path) {
  const match = /^workspace:\/\/([^/]+)\/(.+)$/u.exec(path);
  if (match) {
    const root = workspaceRoots[match[1]];
    assert.ok(root, `unknown workspace URI: ${path}`);
    return join(root, match[2]);
  }
  return isAbsolute(path) ? path : join(repositoryRoot, path);
}

function compile(schemaPath) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(schemaPath));
}

function assertValid(validate, value, label) {
  assert.equal(
    validate(value),
    true,
    `${label} must validate: ${JSON.stringify(validate.errors)}`,
  );
}

function collectMarkdownLinks(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1]);
}

test('schemas reject their intentionally invalid fixtures', () => {
  for (const [name, paths] of Object.entries(documents)) {
    const validate = compile(join(goalDirectory, paths.schema));
    const invalid = readJson(join(goalDirectory, paths.invalid));
    assert.equal(validate(invalid), false, `${name} invalid fixture must be rejected`);
    assert.ok(validate.errors?.length, `${name} rejection must expose schema errors`);
  }
});

test('all required G00 artifacts exist and validate', () => {
  for (const paths of Object.values(documents)) {
    const documentPath = join(goalDirectory, paths.document);
    assert.ok(existsSync(documentPath), `missing required artifact: ${paths.document}`);
    const validate = compile(join(goalDirectory, paths.schema));
    assertValid(validate, readJson(documentPath), paths.document);
  }
  for (const path of requiredMarkdown) {
    assert.ok(existsSync(join(goalDirectory, path)), `missing required artifact: ${path}`);
  }
});

test('workspace inventory closes paths, provenance and non-mutation', () => {
  const inventory = readJson(join(goalDirectory, documents.workspace.document));
  assert.deepEqual(
    inventory.workspaces.map((workspace) => workspace.workspace_id).sort(),
    ['canonical', 'frozen_production', 'legacy_desktop', 'legacy_ivekit'],
  );
  assert.equal(inventory.non_mutation.unchanged, true);
  for (const workspaceId of inventory.non_mutation.checked_workspace_ids) {
    assert.deepEqual(
      inventory.non_mutation.before[workspaceId],
      inventory.non_mutation.after[workspaceId],
      `${workspaceId} changed during G00 generation`,
    );
  }
  for (const workspace of inventory.workspaces) {
    const paths = workspace.files.map((file) => file.path);
    assert.equal(new Set(paths).size, paths.length, `${workspace.workspace_id} duplicate file path`);
    assert.equal(
      workspace.status_counts.tracked,
      workspace.files.filter((file) => file.states.includes('tracked')).length,
    );
    assert.equal(
      workspace.status_counts.untracked,
      workspace.files.filter((file) => file.states.includes('untracked')).length,
    );
    for (const file of workspace.files) {
      assert.ok(file.provenance_basis.length > 0);
      assert.ok(file.protection.length > 0);
    }
    for (const entry of workspace.ignored_entries) {
      assert.equal(entry.content_inspected, false);
    }
  }
});

test('workspace inventory replays against raw Git and filesystem facts', () => {
  const inventory = readJson(join(goalDirectory, documents.workspace.document));
  for (const workspace of inventory.workspaces) {
    const root = workspace.requested_path;
    const status = gitBuffer(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const statusPaths = parseStatusPaths(status);
    const tracked = splitNul(gitBuffer(root, ['ls-files', '-z']));
    const untracked = splitNul(gitBuffer(root, ['ls-files', '--others', '--exclude-standard', '-z']));
    const withIgnored = splitNul(gitBuffer(root, [
      'status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all',
    ]));
    const branch = gitText(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    assert.equal(gitText(root, ['rev-parse', 'HEAD']).trim(), workspace.repository.head);
    assert.equal(branch, workspace.repository.branch);
    const statusMatchesCapture = sha256Value(status) === workspace.status_projection_sha256;
    if (!statusMatchesCapture) {
      assert.equal(workspace.workspace_id, 'canonical', `${workspace.workspace_id} status drifted`);
      for (const path of statusPaths.keys()) {
        assert.ok(
          path === relativeGoalPath || path.startsWith(`${relativeGoalPath}/`),
          `canonical post-capture change escaped G00 staging boundary: ${path}`,
        );
      }
    } else {
      assert.equal(tracked.length, workspace.status_counts.tracked);
      assert.equal(untracked.length, workspace.status_counts.untracked);
      assert.equal(
        [...statusPaths.values()].filter((states) => states.includes('staged')).length,
        workspace.status_counts.staged,
      );
      assert.equal(
        [...statusPaths.values()].filter((states) => states.includes('unstaged')).length,
        workspace.status_counts.unstaged,
      );
    }
    assert.equal(withIgnored.filter((entry) => entry.startsWith('!! ')).length, workspace.status_counts.ignored_entries);
    assert.equal(Number(gitText(root, ['rev-list', '--count', 'HEAD']).trim()), workspace.repository.head_commit_count);
    assert.equal(Number(gitText(root, ['rev-list', '--all', '--count']).trim()), workspace.repository.all_ref_commit_count);
    assert.equal(workspace.commits.length, workspace.repository.all_ref_commit_count);
    assert.equal(new Set(workspace.commits.map((commit) => commit.commit)).size, workspace.commits.length);
    if (workspace.repository.upstream) {
      assert.deepEqual(
        gitText(root, ['rev-list', `${workspace.repository.upstream}..HEAD`]).split('\n').filter(Boolean),
        workspace.unpushed_commits,
      );
    }
    for (const file of workspace.files) {
      const absolute = join(root, file.path);
      if (file.content_sha256 === null) continue;
      assert.ok(existsSync(absolute), `${workspace.workspace_id} missing inventoried content: ${file.path}`);
      const stat = lstatSync(absolute);
      const digest = stat.isSymbolicLink()
        ? sha256Value(readlinkSync(absolute))
        : sha256File(absolute);
      assert.equal(digest, file.content_sha256, `${workspace.workspace_id} content drift: ${file.path}`);
      assert.equal(stat.size, file.size_bytes, `${workspace.workspace_id} size drift: ${file.path}`);
    }
  }
});

test('requirement traceability has exact closed counts and valid Goal references', () => {
  const trace = readJson(join(goalDirectory, documents.traceability.document));
  const ids = trace.requirements.map((row) => row.requirement_id);
  const goalIds = new Set(trace.new_goal_coverage.map((goal) => goal.goal_id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(trace.closure.source_requirement_count, trace.requirements.length);
  assert.equal(
    trace.closure.mapped_count,
    trace.requirements.filter((row) => row.disposition === 'mapped').length,
  );
  assert.equal(
    trace.closure.deferred_count,
    trace.requirements.filter((row) => row.disposition === 'deferred').length,
  );
  assert.equal(
    trace.closure.rejected_count,
    trace.requirements.filter((row) => row.disposition === 'rejected').length,
  );
  assert.equal(
    trace.closure.superseded_count,
    trace.requirements.filter((row) => row.disposition === 'superseded').length,
  );
  assert.equal(
    trace.closure.requirements_with_zero_targets,
    trace.requirements.filter((row) => row.target_goals.length === 0).length,
  );
  for (const row of trace.requirements) {
    if (row.disposition === 'mapped') assert.ok(row.target_goals.length > 0);
    for (const goalId of row.target_goals) assert.ok(goalIds.has(goalId));
  }
  for (const source of trace.sources) {
    assert.equal(
      source.requirement_count,
      trace.requirements.filter((row) => row.source_id === source.source_id).length,
      `${source.source_id} count drift`,
    );
  }
  for (const goal of trace.new_goal_coverage) {
    assert.equal(
      goal.mapped_requirement_count,
      trace.requirements.filter((row) => row.target_goals.includes(goal.goal_id)).length,
      `${goal.goal_id} mapped count drift`,
    );
  }
});

test('traceability preserves every fixed source population exactly once', () => {
  const trace = readJson(join(goalDirectory, documents.traceability.document));
  const inventory = readJson(join(goalDirectory, documents.workspace.document));
  const sources = new Map(trace.sources.map((source) => [source.source_id, source]));
  const expected = {
    R4_TRACEABILITY: 362,
    R5_DELTA: 66,
    PLATFORM_R2: 16,
    RESOLVE_R1: 12,
    GOAL_PROGRAM: 18,
    LEGACY_LOCAL_CHANGES: inventory.workspaces
      .filter((workspace) => ['legacy_desktop', 'legacy_ivekit'].includes(workspace.workspace_id))
      .flatMap((workspace) => workspace.files)
      .filter((file) => file.states.some((state) =>
        ['staged', 'unstaged', 'untracked', 'deleted', 'renamed'].includes(state),
      )).length,
  };
  for (const [sourceId, count] of Object.entries(expected)) {
    assert.equal(sources.get(sourceId)?.requirement_count, count, `${sourceId} source population drift`);
  }
  const r4Rows = readJson(join(repositoryRoot, 'docs/capacity/contracts/unified-voice-foundation-r4-traceability-v1.json')).rows;
  const r5Rows = readJson(join(repositoryRoot, 'docs/capacity/contracts/unified-communication-foundation-r5-traceability-v1.json')).delta_rows;
  assert.deepEqual(
    trace.requirements.filter((row) => row.source_id === 'R4_TRACEABILITY').map((row) => row.source_requirement_id),
    r4Rows.map((row) => row.trace_id),
  );
  assert.deepEqual(
    trace.requirements.filter((row) => row.source_id === 'R5_DELTA').map((row) => row.source_requirement_id),
    r5Rows.map((row) => row.trace_id),
  );
  assert.equal(r4Rows.filter((row) => row.kind === 'rvoip_capability').length, 198);
  assert.equal(r4Rows.filter((row) => row.kind === 'rvoip_replacement_gate').length, 14);
  assert.equal(r4Rows.filter((row) => row.kind === 'historical_goal_gate').length, 102);
  assert.equal(r4Rows.filter((row) => row.kind === 'review').length, 18);
  assert.equal(r4Rows.filter((row) => row.kind === 'supplemental_review').length, 6);
  assert.equal(r4Rows.filter((row) => row.kind === 'voice_livekit').length, 10);
  const evidenceSources = trace.sources.filter((source) => source.kind === 'production_evidence');
  assert.equal(evidenceSources.length, 94);
  assert.equal(evidenceSources.reduce((total, source) => total + source.requirement_count, 0), 94);
});

test('status registry separates current, target and production eligibility', () => {
  const registry = readJson(join(goalDirectory, documents.registry.document));
  const ids = registry.capabilities.map((capability) => capability.capability_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(registry.closure.capability_count, registry.capabilities.length);
  assert.equal(
    registry.capabilities.filter((capability) => capability.production_eligible.eligible).length,
    0,
  );
  for (const capability of registry.capabilities) {
    assert.equal(capability.non_claim, true);
    assert.ok(capability.current.basis);
    assert.ok(capability.target.basis);
    assert.ok(capability.production_eligible.basis);
  }
});

test('all recorded binding and source identities match current bytes', () => {
  const artifacts = [];
  for (const paths of Object.values(documents)) {
    artifacts.push(...readJson(join(goalDirectory, paths.document)).binding_inputs);
  }
  const trace = readJson(join(goalDirectory, documents.traceability.document));
  artifacts.push(...trace.sources.map(({ path, sha256, kind }) => ({ path, sha256, kind })));
  const unique = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  for (const artifact of unique.values()) {
    const path = resolveArtifactPath(artifact.path);
    assert.ok(existsSync(path), `missing source identity: ${artifact.path}`);
    assert.equal(sha256File(path), artifact.sha256, `hash drift: ${artifact.path}`);
  }
});

test('all local Markdown links in G00 resolve', () => {
  for (const name of requiredMarkdown) {
    const path = join(goalDirectory, name);
    const links = collectMarkdownLinks(readFileSync(path, 'utf8'));
    for (const link of links) {
      const target = link.split('#', 1)[0];
      if (!target || /^(?:https?:|mailto:|workspace:)/u.test(target)) continue;
      const decoded = decodeURIComponent(target);
      const resolved = normalize(resolve(dirname(path), decoded));
      assert.ok(existsSync(resolved), `${name} has broken link: ${link}`);
      const repositoryRelative = relative(repositoryRoot, resolved);
      assert.ok(
        repositoryRelative !== '..' &&
          !repositoryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
          !isAbsolute(repositoryRelative),
        `${name} link escapes repository without workspace URI: ${link}`,
      );
    }
  }
});

test('G00 documents do not contain credential values', () => {
  const paths = [
    ...Object.values(documents).flatMap(({ document, schema }) => [document, schema]),
    ...requiredMarkdown,
  ];
  const value = paths
    .map((path) => readFileSync(join(goalDirectory, path), 'utf8'))
    .join('\n');
  assert.doesNotMatch(value, /https?:\/\/[^/@\s]+:[^/@\s]+@/u);
  assert.doesNotMatch(value, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u);
  assert.doesNotMatch(value, /(?:gh[pousr]_|AKIA)[A-Za-z0-9_]{16,}/u);
});

test('G00 path boundary excludes product and runtime changes', () => {
  const relativeGoal = relative(repositoryRoot, goalDirectory).replaceAll('\\', '/');
  const allowed = new Set([
    ...Object.values(documents).flatMap(({ document, schema, invalid }) => [
      join(relativeGoal, document),
      join(relativeGoal, schema),
      join(relativeGoal, invalid),
    ]),
    ...requiredMarkdown.map((path) => join(relativeGoal, path)),
    join(relativeGoal, 'generate-goal-00.mjs'),
    join(relativeGoal, 'goal-00-contract.test.mjs'),
  ].map((path) => path.replaceAll('\\', '/')));
  for (const path of allowed) {
    const absolute = join(repositoryRoot, path);
    if (existsSync(absolute)) assert.ok(lstatSync(absolute));
  }
  const changed = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const statusPath = line.slice(3);
      const paths = statusPath.includes(' -> ') ? statusPath.split(' -> ') : [statusPath];
      return paths.map((path) => path.replace(/^"|"$/gu, '').replaceAll('\\', '/'));
    });
  for (const path of changed) {
    assert.ok(allowed.has(path), `G00 changed a path outside its boundary: ${path}`);
  }
});
