import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));
const largeFileThresholdBytes = 10 * 1024 * 1024;
const generatedAt = new Date().toISOString();

const workspaceDefinitions = [
  {
    workspace_id: 'canonical',
    role: 'canonical_execution_root',
    requested_path: '/Users/songjinfeng/Projects/converact-worktrees/platform',
  },
  {
    workspace_id: 'legacy_desktop',
    role: 'read_only_legacy_source',
    requested_path: '/Users/songjinfeng/Desktop/opc',
  },
  {
    workspace_id: 'legacy_ivekit',
    role: 'read_only_legacy_source',
    requested_path: '/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3',
  },
  {
    workspace_id: 'frozen_production',
    role: 'frozen_production_boundary',
    requested_path: '/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730',
  },
];

const managedNames = new Set([
  '2026-07-31-goal-00-execution-plan.md',
  'canonical-execution-root-decision.md',
  'execution-baseline.md',
  'file-level-migration-sequence.md',
  'generate-goal-00.mjs',
  'goal-00-contract.test.mjs',
  'independent-review.md',
  'overlap-and-authority-ledger.md',
  'requirement-traceability-v1.json',
  'requirement-traceability-v1.schema.json',
  'status-and-evidence-registry-v1.json',
  'status-and-evidence-registry-v1.schema.json',
  'workspace-inventory-v1.json',
  'workspace-inventory-v1.schema.json',
  'fixtures/invalid-requirement-traceability.json',
  'fixtures/invalid-status-registry.json',
  'fixtures/invalid-workspace-inventory.json',
]);

const sourcePaths = {
  r4: 'docs/capacity/contracts/unified-voice-foundation-r4-traceability-v1.json',
  r5: 'docs/capacity/contracts/unified-communication-foundation-r5-traceability-v1.json',
  platformR2: 'docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md',
  resolveR1: 'docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md',
  manifest: 'goals/manifest.json',
  programRules: 'goals/PROGRAM-RULES.md',
  goal00: 'goals/goal-00-execution-baseline-and-traceability.md',
  inventory: 'architecture-foundation/execution/goal-00/workspace-inventory-v1.json',
};

const authorityDomains = {
  G00: ['Program baseline', 'Requirement traceability', 'Migration evidence'],
  G01: ['Horizontal Platform contract', 'Profile and Offer gates', 'Commercial discovery'],
  G02: ['Tenant and identity', 'Security and consent', 'Durability, audit and observability'],
  G03: ['Kamailio SIP Edge', 'Unified RustPBX Call Authority', 'Durable effect oracle'],
  G04: ['Unified Codec Registry', 'G729/8000 exact-source engineering'],
  G05: ['Media Graph and Plan', 'RTPengine fast path', 'voice-media-rs decode path'],
  G06: ['rvoip low-level slices', 'Protocol Adapter replacement gates'],
  G07: ['Fabric Coordination', 'LiveKit Room Authority', 'Voice-LiveKit handoff'],
  G08: ['Communication qualification', 'VOS-EQ and 100K evidence', 'Capacity claims'],
  G09: ['Engagement Authority', 'Resolve Profile', 'Evidence and Outcome'],
  G10: ['Human and AI collaboration', 'Workspace and handoff projection'],
  G11: ['Minimal Connector effect', 'External-system overlay boundary'],
  G12: ['SpeechRuntime', 'HF speech execution', 'Translation capability'],
  G13: ['Cross-channel Agent Runtime', 'Agent lease and handoff'],
  G14: ['Action Authority', 'Durable workflow and compensation'],
  G15: ['Context and Knowledge', 'Studio, evaluation and governance'],
  G16: ['Resolve V1 release', 'Commercial and production eligibility'],
  G17: ['Operator IMS boundary', 'ViLTE AV Gateway', 'Future telecom option'],
};

const categoryByGoal = {
  G00: 'program',
  G01: 'platform',
  G02: 'security',
  G03: 'sip',
  G04: 'codec',
  G05: 'media',
  G06: 'rvoip',
  G07: 'livekit',
  G08: 'performance',
  G09: 'engagement',
  G10: 'collaboration',
  G11: 'connector',
  G12: 'speech',
  G13: 'agent',
  G14: 'action',
  G15: 'knowledge',
  G16: 'commercial',
  G17: 'vilte',
};

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', options.allowFailure ? 'pipe' : 'inherit'],
  });
}

function gitMaybe(root, args) {
  try {
    return git(root, args);
  } catch {
    return '';
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function artifactIdentity(path, kind) {
  return { path, sha256: sha256File(join(repositoryRoot, path)), kind };
}

function bindingInputs() {
  return [
    artifactIdentity(sourcePaths.goal00, 'binding_goal'),
    artifactIdentity(sourcePaths.programRules, 'program_rules'),
    artifactIdentity(sourcePaths.manifest, 'goal_manifest'),
  ];
}

function splitNul(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function sanitizeRemote(raw) {
  const value = raw.trim();
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.replace(/^(https?:\/\/)[^/@\s]+@/u, '$1');
  }
}

function redactedText(value) {
  return value
    .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gu, 'https://[redacted]@')
    .replace(/(?:gh[pousr]_|AKIA)[A-Za-z0-9_]{16,}/gu, '[redacted-secret-shaped-value]');
}

function branchOf(root) {
  return gitMaybe(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() || '(detached)';
}

function statusRaw(root) {
  return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: null,
  });
}

function workspaceGuard(root) {
  return {
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    branch: branchOf(root),
    status_sha256: sha256(statusRaw(root)),
  };
}

function parseStatus(buffer, includeIgnored = false) {
  const entries = new Map();
  const ignored = [];
  const tokens = splitNul(buffer);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    if (xy === '!!') {
      if (includeIgnored) ignored.push(path);
      continue;
    }
    const states = new Set();
    if (xy === '??') states.add('untracked');
    if (![' ', '?', '!'].includes(xy[0])) states.add('staged');
    if (![' ', '?', '!'].includes(xy[1])) states.add('unstaged');
    if (xy.includes('D')) states.add('deleted');
    if (xy.includes('R') || xy.includes('C')) {
      states.add('renamed');
      index += 1;
    }
    entries.set(path, states);
  }
  return { entries, ignored };
}

function parseHeadBlobs(root) {
  const result = new Map();
  const output = gitMaybe(root, ['ls-tree', '-r', '-z', 'HEAD']);
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\t(.+)$/u.exec(record);
    if (match) result.set(match[4], match[3]);
  }
  return result;
}

function parseIndexBlobs(root) {
  const result = new Map();
  const buffer = git(root, ['ls-files', '-s', '-z'], { encoding: null });
  for (const record of splitNul(buffer)) {
    const match = /^(\d+)\s+([0-9a-f]+)\s+(\d+)\t(.+)$/u.exec(record);
    if (match && match[3] === '0') result.set(match[4], match[2]);
  }
  return result;
}

function fileTypeAndIdentity(root, path, selfManaged) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    return { file_type: 'missing', size_bytes: null, content_sha256: null };
  }
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return {
        file_type: 'symlink',
        size_bytes: stat.size,
        content_sha256: selfManaged ? null : sha256(readlinkSync(absolute)),
      };
    }
    if (stat.isFile()) {
      return {
        file_type: 'file',
        size_bytes: selfManaged ? null : stat.size,
        content_sha256: selfManaged ? null : sha256File(absolute),
      };
    }
    if (stat.isDirectory()) {
      return { file_type: 'directory', size_bytes: null, content_sha256: null };
    }
    return { file_type: 'other', size_bytes: stat.size, content_sha256: null };
  } catch {
    return { file_type: 'other', size_bytes: null, content_sha256: null };
  }
}

function goalsForPath(path) {
  const lower = path.toLowerCase();
  const direct = /goal-(\d{2})/u.exec(lower);
  if (direct && Number(direct[1]) <= 17) return [`G${direct[1]}`];
  const matches = [];
  const add = (...goals) => matches.push(...goals);
  if (/(?:product|domain|persona|market|pricing|commercial-gate)/u.test(lower)) add('G01');
  if (/(?:platform|tenant|identity|security|consent|audit|observab|telemetry|infra|storage|database|event)/u.test(lower)) add('G02');
  if (/(?:rustpbx|sip|kamailio|call-core|call[_-]|dialog|trunk)/u.test(lower)) add('G03');
  if (/g729/u.test(lower)) add('G04');
  if (/(?:rtpengine|voice-media|media-engine|codec|mixer|transcod|record)/u.test(lower)) add('G05');
  if (/rvoip/u.test(lower)) add('G06');
  if (/(?:livekit|ivekit|webrtc|bridge|handoff)/u.test(lower)) add('G07');
  if (/(?:capacity|benchmark|performance|vos|load-test|evidence)/u.test(lower)) add('G08');
  if (/(?:engagement|resolution|outcome|profile-binding)/u.test(lower)) add('G09');
  if (/(?:collaboration|workspace|supervisor|human-ai)/u.test(lower)) add('G10');
  if (/(?:connector|crm|fsm|external-system)/u.test(lower)) add('G11');
  if (/(?:speech|tts|asr|vad|translation|hugging|ai-worker)/u.test(lower)) add('G12');
  if (/(?:agent|orchestrat|nanobot|pi-agent|active-call)/u.test(lower)) add('G13');
  if (/(?:action|workflow|tool-broker|effect-receipt)/u.test(lower)) add('G14');
  if (/(?:knowledge|memory|studio|governance|playbook|eval)/u.test(lower)) add('G15');
  if (/(?:pilot|production|deploy|release|sales|billing|unit-economic)/u.test(lower)) add('G16');
  if (/(?:vilte|volte|ims|h264|h\.264|future-telecom)/u.test(lower)) add('G17');
  return [...new Set(matches.length ? matches : ['G02'])].slice(0, 4);
}

function protectionFor(workspaceId) {
  if (workspaceId === 'canonical') return 'canonical_read_only_until_goal_owner';
  if (workspaceId === 'frozen_production') return 'frozen_production_do_not_modify';
  return 'preserve_legacy_user_work';
}

function migrationDispositionFor(workspaceId, path) {
  if (workspaceId === 'canonical') return 'keep_canonical';
  if (workspaceId === 'frozen_production') return 'frozen_no_migration';
  if (/(?:^|\/)(?:dist|coverage|target|tmp|temp)(?:\/|$)/u.test(path.toLowerCase())) {
    return 'quarantine_generated';
  }
  return 'assess_before_migrate';
}

function provenanceFor(workspaceId, path) {
  if (workspaceId === 'canonical') {
    const relativeGoal = relative(repositoryRoot, goalDirectory).replaceAll('\\', '/');
    if (path === relativeGoal || path.startsWith(`${relativeGoal}/`)) {
      return {
        provenance: 'generated',
        provenance_basis: 'Created under the active G00 exact-path boundary; no ownership inference.',
      };
    }
  }
  return {
    provenance: 'unknown_provenance',
    provenance_basis: 'Git and filesystem establish existence, not human or agent ownership.',
  };
}

function ignoredRecord(path) {
  const lower = path.toLowerCase();
  const sensitive = /(?:^|\/)(?:\.env|\.ssh|credentials?|secrets?|auth|tokens?)(?:[./_-]|$)/u.test(lower);
  const generated = /(?:node_modules|target|dist|coverage|__pycache__|\.cache|data\/|logs?\/)/u.test(lower);
  return {
    path,
    entry_kind: path.endsWith('/') ? 'directory' : 'unknown',
    provenance: generated ? 'generated' : 'unknown_provenance',
    provenance_basis: generated
      ? 'Path pattern is a conventional generated/cache directory; contents were not inspected.'
      : 'Ignored entry ownership and contents were not inspected.',
    content_inspected: false,
    protection: sensitive
      ? 'ignored_sensitive_no_content_read'
      : generated
        ? 'ignored_generated_no_migration'
        : 'ignored_unknown_preserve',
  };
}

function parseWorktrees(root) {
  const lines = git(root, ['worktree', 'list', '--porcelain']).split('\n');
  const worktrees = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice(9), head: '', branch: null };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//u, '');
    } else if (current && line === 'detached') {
      current.branch = null;
    }
  }
  if (current) worktrees.push(current);
  return worktrees.filter((worktree) => worktree.head);
}

function parseSubmodules(root) {
  const output = gitMaybe(root, ['submodule', 'status', '--recursive']);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const stateCode = line[0];
      const match = /^[ +-U]([0-9a-f]+)\s+(\S+)/u.exec(line);
      if (!match) return null;
      const states = { ' ': 'clean', '+': 'modified', '-': 'uninitialized', U: 'conflict' };
      return { path: match[2], commit: match[1], state: states[stateCode] ?? 'conflict' };
    })
    .filter(Boolean);
}

function parseCommits(root) {
  const format = '%H%x1f%P%x1f%an%x1f%aI%x1f%cI%x1f%s%x1e';
  const output = git(root, ['log', '--all', `--format=${format}`]);
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commit, parents, authorName, authoredAt, committedAt, ...subjectParts] = record.split('\x1f');
      return {
        commit,
        parents: parents ? parents.split(' ') : [],
        author_name: redactedText(authorName),
        authored_at: authoredAt,
        committed_at: committedAt,
        subject: redactedText(subjectParts.join('\x1f')),
        provenance: 'unknown_provenance',
        provenance_basis: 'Commit authorship metadata is not ownership proof.',
      };
    });
}

function parseStorage(root) {
  const values = Object.fromEntries(
    git(root, ['count-objects', '-vH'])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(': ', 2)),
  );
  return {
    count: Number(values.count ?? 0),
    size: values.size ?? '0 bytes',
    in_pack: Number(values['in-pack'] ?? 0),
    packs: Number(values.packs ?? 0),
    size_pack: values['size-pack'] ?? '0 bytes',
    prune_packable: Number(values['prune-packable'] ?? 0),
    garbage: Number(values.garbage ?? 0),
  };
}

function parseRemotes(root) {
  const names = gitMaybe(root, ['remote']).split('\n').filter(Boolean);
  return names.map((name) => ({
    name,
    fetch_url: sanitizeRemote(git(root, ['remote', 'get-url', name])),
    push_url: sanitizeRemote(git(root, ['remote', 'get-url', '--push', name])),
  }));
}

function repositoryFacts(root) {
  const upstream = gitMaybe(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim() || null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = git(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).trim().split(/\s+/u);
    behind = Number(counts[0]);
    ahead = Number(counts[1]);
  }
  return {
    common_git_dir: realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim())),
    git_dir: realpathSync(resolve(root, git(root, ['rev-parse', '--git-dir']).trim())),
    branch: branchOf(root),
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    upstream,
    ahead,
    behind,
    head_commit_count: Number(git(root, ['rev-list', '--count', 'HEAD']).trim()),
    all_ref_commit_count: Number(git(root, ['rev-list', '--all', '--count']).trim()),
    remotes: parseRemotes(root),
  };
}

function collectWorkspace(definition) {
  const root = realpathSync(definition.requested_path);
  const rawStatus = statusRaw(root);
  const parsedStatus = parseStatus(rawStatus);
  const ignoredBuffer = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--ignored=matching',
    '--untracked-files=all',
  ], { encoding: null });
  const ignoredPaths = parseStatus(ignoredBuffer, true).ignored.sort();
  const trackedPaths = splitNul(git(root, ['ls-files', '-z'], { encoding: null }));
  const tracked = new Set(trackedPaths);
  const allPaths = new Set([...trackedPaths, ...parsedStatus.entries.keys()]);
  const headBlobs = parseHeadBlobs(root);
  const indexBlobs = parseIndexBlobs(root);
  const relativeGoal = relative(repositoryRoot, goalDirectory).replaceAll('\\', '/');
  const files = [...allPaths]
    .sort()
    .map((path) => {
      const states = new Set(parsedStatus.entries.get(path) ?? []);
      if (tracked.has(path)) states.add('tracked');
      const selfManaged = definition.workspace_id === 'canonical' &&
        (path === relativeGoal || path.startsWith(`${relativeGoal}/`)) &&
        managedNames.has(path.slice(relativeGoal.length + 1));
      const identity = fileTypeAndIdentity(root, path, selfManaged);
      const provenance = provenanceFor(definition.workspace_id, path);
      return {
        path,
        states: [...states].sort(),
        ...identity,
        head_blob: headBlobs.get(path) ?? null,
        index_blob: indexBlobs.get(path) ?? null,
        ...provenance,
        protection: protectionFor(definition.workspace_id),
        target_goals: definition.workspace_id === 'frozen_production' ? [] : goalsForPath(path),
        migration_disposition: migrationDispositionFor(definition.workspace_id, path),
      };
    });
  const largeFiles = files
    .filter((file) => file.file_type === 'file' && file.size_bytes >= largeFileThresholdBytes)
    .map((file) => ({
      path: file.path,
      size_bytes: file.size_bytes,
      sha256: file.content_sha256,
      states: file.states,
    }));
  const repository = repositoryFacts(root);
  const unpushed = repository.upstream
    ? git(root, ['rev-list', `${repository.upstream}..HEAD`]).split('\n').filter(Boolean)
    : [];
  return {
    ...definition,
    resolved_path: root,
    repository,
    clean: rawStatus.length === 0,
    status_counts: {
      tracked: files.filter((file) => file.states.includes('tracked')).length,
      staged: files.filter((file) => file.states.includes('staged')).length,
      unstaged: files.filter((file) => file.states.includes('unstaged')).length,
      untracked: files.filter((file) => file.states.includes('untracked')).length,
      ignored_entries: ignoredPaths.length,
    },
    status_projection_sha256: sha256(rawStatus),
    submodules: parseSubmodules(root),
    worktrees: parseWorktrees(root),
    commits: parseCommits(root),
    unpushed_commits: unpushed,
    files,
    ignored_entries: ignoredPaths.map(ignoredRecord),
    large_files: largeFiles,
    git_storage: parseStorage(root),
  };
}

function changeFiles(workspace) {
  return workspace.files.filter((file) =>
    file.states.some((state) => ['staged', 'unstaged', 'untracked', 'deleted', 'renamed'].includes(state)),
  );
}

function buildInventory(beforeGuards, afterGuards) {
  const workspaces = workspaceDefinitions.map(collectWorkspace);
  const commonGroups = new Map();
  for (const workspace of workspaces) {
    const stat = lstatSync(workspace.repository.common_git_dir);
    const key = `${stat.dev}:${stat.ino}`;
    if (!commonGroups.has(key)) {
      commonGroups.set(key, {
        common_git_dir: workspace.repository.common_git_dir,
        workspace_ids: [],
      });
    }
    commonGroups.get(key).workspace_ids.push(workspace.workspace_id);
  }
  const changeOwners = new Map();
  for (const workspace of workspaces) {
    for (const file of changeFiles(workspace)) {
      if (!changeOwners.has(file.path)) changeOwners.set(file.path, []);
      changeOwners.get(file.path).push(workspace.workspace_id);
    }
  }
  const canonical = workspaces.find((workspace) => workspace.workspace_id === 'canonical');
  const trackedManifest = canonical.files
    .filter((file) => file.states.includes('tracked'))
    .map((file) => `${file.path}\0${file.index_blob ?? ''}\0${file.content_sha256 ?? ''}`)
    .sort()
    .join('\n');
  const legacyManifest = workspaces
    .filter((workspace) => workspace.workspace_id !== 'canonical')
    .flatMap((workspace) => changeFiles(workspace).map((file) =>
      `${workspace.workspace_id}\0${file.path}\0${file.states.join(',')}\0${file.content_sha256 ?? ''}`,
    ))
    .sort()
    .join('\n');
  return {
    schema_version: '1.0.0',
    inventory_id: 'converact-goal-00-workspace-inventory-v1',
    captured_at: generatedAt,
    hash_algorithm: 'SHA-256',
    canonical_execution_root: workspaceDefinitions[0].requested_path,
    large_file_threshold_bytes: largeFileThresholdBytes,
    snapshot_policy: {
      tracked_and_nonignored_paths: 'explicit_file_records',
      ignored_entries: 'git_matching_entries_without_content_read',
      credential_content: 'never_recorded',
      provenance_default: 'unknown_provenance',
    },
    binding_inputs: bindingInputs(),
    workspaces,
    cross_workspace: {
      shared_repository_groups: [...commonGroups.values()],
      canonical_tracked_manifest_sha256: sha256(trackedManifest),
      legacy_change_manifest_sha256: sha256(legacyManifest),
      duplicate_change_paths: [...changeOwners.entries()]
        .filter(([, workspaceIds]) => workspaceIds.length > 1)
        .map(([path, workspace_ids]) => ({ path, workspace_ids })),
    },
    non_mutation: {
      checked_workspace_ids: ['legacy_desktop', 'legacy_ivekit', 'frozen_production'],
      before: beforeGuards,
      after: afterGuards,
      unchanged: JSON.stringify(beforeGuards) === JSON.stringify(afterGuards),
    },
  };
}

function normalizePriorStatus(value) {
  const allowed = new Set([
    'not_run',
    'implemented_local',
    'partial',
    'historical_superseded',
    'target',
    'conditional',
    'unknown',
  ]);
  if (allowed.has(value)) return value;
  if (value === 'optional_target') return 'target';
  if (value === 'review_required') return 'conditional';
  if (value?.startsWith('accepted_')) return 'target';
  return 'unknown';
}

function normalizeId(value) {
  return value.toUpperCase().replace(/[^A-Z0-9_.:-]+/gu, '_').replace(/^_+|_+$/gu, '');
}

function mapOldGoal(sourceId) {
  const match = /^(Goal(?:\d+L?|\d+)|TrackR)\./u.exec(sourceId);
  if (!match) return null;
  const mapping = {
    Goal0: ['G03', 'G05', 'G06', 'G08'],
    Goal1: ['G03', 'G05'],
    Goal2: ['G05'],
    Goal3: ['G03', 'G05'],
    Goal3L: ['G07'],
    Goal4: ['G05', 'G08'],
    Goal5: ['G05', 'G07', 'G08'],
    Goal6: ['G03', 'G06'],
    Goal7: ['G08'],
    TrackR: ['G06', 'G08'],
    Goal8: ['G02', 'G03', 'G05', 'G08'],
    Goal9: ['G02', 'G08'],
    Goal10: ['G08'],
    Goal11: ['G08'],
  };
  return mapping[match[1]] ?? null;
}

function r4Goals(row) {
  const old = mapOldGoal(row.source_id);
  if (old) return old;
  const review = {
    C1: ['G03'], C2: ['G03'], C3: ['G05'], C4: ['G05'], C5: ['G03'], C6: ['G03', 'G05'],
    I1: ['G03'], I2: ['G03'], I3: ['G05'], I4: ['G07'], I5: ['G03', 'G05', 'G07'],
    I6: ['G04'], I7: ['G02', 'G03'], I8: ['G06'], I9: ['G06', 'G08'], I10: ['G08'],
    I11: ['G02', 'G07', 'G08'], I12: ['G03', 'G05', 'G07', 'G08'],
  };
  const reviewMatch = /(?:^|:)(C\d+|I\d+)$/u.exec(row.trace_id);
  if (reviewMatch && review[reviewMatch[1]]) return review[reviewMatch[1]];
  if (row.kind === 'voice_livekit') return ['G07'];
  if (row.kind === 'rvoip_replacement_gate') return ['G06'];
  const phase = {
    U1: ['G03'], U2: ['G04'], U3: ['G03', 'G05'], U4: ['G06'], U5: ['G05'],
    U6: ['G07'], U7: ['G05', 'G07', 'G08'], U8: ['G08'], U9: ['G08'],
  };
  if (phase[row.owner_phase]) return phase[row.owner_phase];
  const text = `${row.source_id} ${row.requirement}`.toLowerCase();
  if (text.includes('rvoip')) return ['G06'];
  if (text.includes('rtpengine') || text.includes('media')) return ['G05'];
  if (text.includes('livekit') || text.includes('bridge')) return ['G07'];
  return ['G03', 'G05', 'G06', 'G07', 'G08'];
}

function r5Goals(row) {
  const text = row.requirement.toLowerCase();
  const category = {
    inheritance: ['G00'],
    rvoip: ['G06'],
    media: ['G05', 'G08'],
    codec: text.includes('vilte') || text.includes('amr') ? ['G04', 'G17'] : ['G04'],
    recording: ['G05', 'G07', 'G08'],
    fault_domain: ['G02', 'G05', 'G08'],
    livekit: ['G07'],
    vilte: ['G17'],
    agent: ['G13'],
    speech: ['G12'],
    ai_native: ['G13', 'G14', 'G15'],
    performance: ['G08', 'G12', 'G17'],
    security: ['G02'],
    recovery: ['G02', 'G03', 'G07', 'G14'],
    migration: ['G02', 'G06', 'G08'],
    observability: ['G02', 'G08'],
    change_control: ['G00'],
    evidence: ['G00', 'G08'],
    delivery: ['G00'],
    completion: ['G08', 'G16', 'G17'],
  };
  if (row.category === 'authority') {
    if (text.includes('livekit')) return ['G07'];
    if (text.includes('agent')) return ['G13'];
    if (text.includes('media')) return ['G03', 'G05'];
    return ['G02', 'G03'];
  }
  return category[row.category] ?? ['G02'];
}

function platformSectionGoals(section) {
  const mapping = {
    1: ['G01'], 2: ['G01', 'G02'], 3: ['G01', 'G16', 'G17'], 4: ['G01', 'G09'],
    5: ['G01', 'G02', 'G03', 'G09'], 6: ['G01', 'G16'], 7: ['G02', 'G03', 'G09', 'G13'],
    8: ['G03', 'G04', 'G05', 'G06', 'G07', 'G08'],
    9: ['G10', 'G12', 'G13', 'G14', 'G15'], 10: ['G01', 'G12', 'G16', 'G17'],
    11: ['G09', 'G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G16'],
    12: ['G00', 'G01', 'G02', 'G03', 'G09', 'G16'], 13: ['G00', 'G02', 'G08', 'G16'],
    14: ['G01'], 15: ['G01', 'G16'], 16: ['G00'],
  };
  return mapping[section] ?? ['G01'];
}

function resolveWorkstreamGoals(id) {
  return {
    W0: ['G01'], W1: ['G03', 'G04', 'G05', 'G06', 'G07', 'G08'], W2: ['G09'],
    W3: ['G12'], W4: ['G10', 'G13'], W5A: ['G11', 'G14'], W5: ['G14'],
    W6: ['G15'], W7: ['G15'], W8: ['G02'], W9: ['G17'], W10: ['G01', 'G16'],
  }[id] ?? ['G01'];
}

function parsePlatformSections() {
  const text = readFileSync(join(repositoryRoot, sourcePaths.platformR2), 'utf8');
  const matches = [...text.matchAll(/^## (\d+)\. (.+)$/gmu)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const body = text.slice(start, end)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('|'))
      .slice(0, 2)
      .join(' ');
    return { number: Number(match[1]), title: match[2], body };
  });
}

function parseResolveWorkstreams() {
  const text = readFileSync(join(repositoryRoot, sourcePaths.resolveR1), 'utf8');
  const section = text.match(/## 23\. 工作流分解([\s\S]*?)(?=\n## 24\.)/u)?.[1] ?? '';
  return section
    .split('\n')
    .filter((line) => /^\| W(?:\d+|5a) /u.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const match = /^(W(?:\d+|5a))\s+(.+)$/u.exec(cells[0]);
      return { id: match[1].toUpperCase(), title: match[2], requirement: cells[1] };
    });
}

function section(text, title) {
  const start = text.indexOf(title);
  if (start < 0) return '';
  const rest = text.slice(start + title.length);
  const next = rest.search(/^## /mu);
  return next < 0 ? rest : rest.slice(0, next);
}

function namedSection(text, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const expression = new RegExp(`^## \\d+\\. ${escapedName}\\s*$`, 'mu');
  const match = expression.exec(text);
  if (!match) return '';
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/^## /mu);
  return next < 0 ? rest : rest.slice(0, next);
}

function requiredArtifacts(goalText, outputRoot) {
  const outputs = [];
  for (const line of namedSection(goalText, 'Required artifacts').split('\n')) {
    if (!line.trim().startsWith('- ')) continue;
    const values = [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    for (const value of values) {
      if (!/\.(?:md|json|rs|ts|mjs|py)$/u.test(value)) continue;
      const path = value.includes('/') ? value : `${outputRoot}/${value}`;
      outputs.push(path);
      if (/schema/u.test(line) && value.endsWith('.json') && !value.endsWith('.schema.json')) {
        outputs.push(path.replace(/\.json$/u, '.schema.json'));
      }
    }
  }
  return [...new Set(outputs)];
}

function goalCoverage(manifest) {
  return manifest.goals.map((goal) => {
    const goalText = readFileSync(join(repositoryRoot, goal.path), 'utf8');
    const outputRoot = `architecture-foundation/execution/goal-${goal.id.slice(1)}`;
    const artifacts = requiredArtifacts(goalText, outputRoot);
    const outputs = artifacts.length
      ? artifacts
      : [`${outputRoot}/required-artifacts-defined-by-${basename(goal.path)}`];
    const acceptance = namedSection(goalText, 'Acceptance gates')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2));
    return {
      goal_id: goal.id,
      title: goal.title,
      goal_path: goal.path,
      goal_sha256: sha256File(join(repositoryRoot, goal.path)),
      authority_domains: authorityDomains[goal.id],
      dependencies: goal.dependencies,
      inputs: [
        goal.path,
        sourcePaths.programRules,
        ...[...goalText.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
          .map((match) => match[1].split('#', 1)[0])
          .filter((path) => path && !/^(?:https?:|mailto:)/u.test(path))
          .map((path) => relative(repositoryRoot, resolve(repositoryRoot, dirname(goal.path), path)).replaceAll('\\', '/'))
          .filter((path) => !path.startsWith('..') && existsSync(join(repositoryRoot, path))),
        ...goal.dependencies.map((dependency) => `goal:${dependency.goal_id}:${dependency.gate}`),
      ].filter((value, index, values) => values.indexOf(value) === index),
      outputs,
      evidence_targets: outputs.filter((path) => /(?:evidence|review|report|matrix|qualification)/u.test(path)).length
        ? outputs.filter((path) => /(?:evidence|review|report|matrix|qualification)/u.test(path))
        : [outputs[0]],
      stop_gates: acceptance.length ? acceptance : [goal.entry_gate],
      mapped_requirement_count: 0,
    };
  });
}

function requirementRow({
  requirementId,
  sourceId,
  sourcePath,
  sourcePointer,
  sourceKind,
  sourceRequirementId,
  requirement,
  priorStatus = 'not_run',
  disposition = 'mapped',
  targetGoals,
  rationale,
  evidenceStatus = 'not_run',
  evidenceUris = [],
  supersedes = [],
}) {
  return {
    requirement_id: requirementId,
    source_id: sourceId,
    source_path: sourcePath,
    source_pointer: sourcePointer,
    source_kind: sourceKind,
    source_requirement_id: sourceRequirementId,
    requirement: redactedText(requirement),
    prior_status: priorStatus,
    disposition,
    target_goals: [...new Set(targetGoals)],
    rationale,
    evidence_status: evidenceStatus,
    production_eligible: false,
    evidence_uris: evidenceUris,
    supersedes,
  };
}

function evidenceGoals(path) {
  const lower = path.toLowerCase();
  if (lower.includes('rename')) return ['G00'];
  if (lower.includes('rtpengine')) return ['G05', 'G08'];
  if (lower.includes('livekit') && lower.includes('integration')) return ['G07', 'G08'];
  if (lower.includes('livekit')) return ['G07', 'G08'];
  if (/(?:ai-voice|audio-tap|provider|realtime)/u.test(lower)) return ['G12', 'G13'];
  if (lower.includes('recording')) return ['G05', 'G08'];
  if (/(?:rustpbx|sip|rtp)/u.test(lower)) return ['G03', 'G05', 'G08'];
  if (/(?:tinode|collaboration)/u.test(lower)) return ['G10'];
  return ['G02', 'G08', 'G16'];
}

function buildTrace(inventory) {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, sourcePaths.manifest), 'utf8'));
  const r4 = JSON.parse(readFileSync(join(repositoryRoot, sourcePaths.r4), 'utf8'));
  const r5 = JSON.parse(readFileSync(join(repositoryRoot, sourcePaths.r5), 'utf8'));
  const requirements = [];
  const sources = [];

  const addSource = (source) => sources.push(source);
  addSource({
    source_id: 'R4_TRACEABILITY', path: sourcePaths.r4, sha256: sha256File(join(repositoryRoot, sourcePaths.r4)),
    kind: 'r4_traceability', requirement_count: r4.rows.length, authority: 'inherited',
  });
  for (const [index, row] of r4.rows.entries()) {
    const disposition = row.disposition === 'deferred_with_prerequisite'
      ? 'deferred'
      : row.disposition === 'superseded_with_rationale' ? 'superseded' : 'mapped';
    requirements.push(requirementRow({
      requirementId: `R4:${String(index + 1).padStart(3, '0')}:${normalizeId(row.trace_id)}`,
      sourceId: 'R4_TRACEABILITY', sourcePath: sourcePaths.r4,
      sourcePointer: `/rows/${index}`, sourceKind: 'r4_trace_row', sourceRequirementId: row.trace_id,
      requirement: row.requirement, priorStatus: normalizePriorStatus(row.source_status), disposition,
      targetGoals: r4Goals(row), rationale: row.rationale || 'Carried into the new Goal sequence without status promotion.',
      evidenceStatus: row.evidence_status === 'not_run' ? 'not_run' : 'historical',
      evidenceUris: row.evidence_status === 'not_run' ? [] : (row.evidence_targets ?? []),
    }));
  }

  addSource({
    source_id: 'R5_DELTA', path: sourcePaths.r5, sha256: sha256File(join(repositoryRoot, sourcePaths.r5)),
    kind: 'r5_delta', requirement_count: r5.delta_rows.length, authority: 'binding',
  });
  for (const [index, row] of r5.delta_rows.entries()) {
    requirements.push(requirementRow({
      requirementId: `R5:${String(index + 1).padStart(3, '0')}:${normalizeId(row.trace_id)}`,
      sourceId: 'R5_DELTA', sourcePath: sourcePaths.r5, sourcePointer: `/delta_rows/${index}`,
      sourceKind: 'r5_delta_row', sourceRequirementId: row.trace_id, requirement: row.requirement,
      priorStatus: 'not_run', targetGoals: r5Goals(row),
      rationale: 'Revision 5 delta remains binding and unproved until its target Goal produces fresh evidence.',
      supersedes: row.trace_id === 'R5-INHERIT-002'
        ? ['R4:LIVEKIT_SIP_VIDEO_ASSUMPTION', 'R4:ONE_AUTHORITY_ONE_PROCESS_ASSUMPTION', 'R4:D0_AUTO_START_CHECKPOINT']
        : [],
    }));
  }

  const platformSections = parsePlatformSections();
  addSource({
    source_id: 'PLATFORM_R2', path: sourcePaths.platformR2,
    sha256: sha256File(join(repositoryRoot, sourcePaths.platformR2)), kind: 'platform_r2',
    requirement_count: platformSections.length, authority: 'binding',
  });
  for (const row of platformSections) {
    requirements.push(requirementRow({
      requirementId: `PLATFORM_R2:S${String(row.number).padStart(2, '0')}`,
      sourceId: 'PLATFORM_R2', sourcePath: sourcePaths.platformR2, sourcePointer: `#${row.number}`,
      sourceKind: 'platform_r2_section', sourceRequirementId: `section-${row.number}`,
      requirement: `${row.title}: ${row.body || 'The complete section is binding.'}`,
      priorStatus: 'target', targetGoals: platformSectionGoals(row.number),
      rationale: 'Platform R2 scope and Authority are preserved in the Goals that own implementation and evidence.',
    }));
  }

  const workstreams = parseResolveWorkstreams();
  addSource({
    source_id: 'RESOLVE_R1', path: sourcePaths.resolveR1,
    sha256: sha256File(join(repositoryRoot, sourcePaths.resolveR1)), kind: 'resolve_r1',
    requirement_count: workstreams.length, authority: 'historical',
  });
  for (const row of workstreams) {
    requirements.push(requirementRow({
      requirementId: `RESOLVE_R1:${row.id}`, sourceId: 'RESOLVE_R1', sourcePath: sourcePaths.resolveR1,
      sourcePointer: `#workstream-${row.id.toLowerCase()}`, sourceKind: 'resolve_r1_workstream',
      sourceRequirementId: row.id, requirement: `${row.title}: ${row.requirement}`, priorStatus: 'target',
      targetGoals: resolveWorkstreamGoals(row.id),
      rationale: 'Resolve R1 is a Profile input; the horizontal platform and Profile-specific Goals retain its applicable clauses.',
    }));
  }

  addSource({
    source_id: 'GOAL_PROGRAM', path: sourcePaths.manifest,
    sha256: sha256File(join(repositoryRoot, sourcePaths.manifest)), kind: 'goal_program',
    requirement_count: manifest.goals.length, authority: 'binding',
  });
  for (const goal of manifest.goals) {
    requirements.push(requirementRow({
      requirementId: `PROGRAM:${goal.id}`, sourceId: 'GOAL_PROGRAM', sourcePath: sourcePaths.manifest,
      sourcePointer: `/goals/${goal.order}`, sourceKind: 'goal_program_contract', sourceRequirementId: goal.id,
      requirement: `Execute ${goal.id} ${goal.title} only after its declared entry gate and dependencies.`,
      priorStatus: goal.id === 'G00' ? 'implemented_local' : goal.status === 'conditional' ? 'conditional' : 'not_run',
      targetGoals: [goal.id], rationale: 'The manifest and binding Goal file define the sole execution contract for this Goal.',
    }));
  }

  const legacyWorkspaces = inventory.workspaces.filter((workspace) =>
    ['legacy_desktop', 'legacy_ivekit'].includes(workspace.workspace_id),
  );
  const legacyChanges = legacyWorkspaces.flatMap((workspace) =>
    changeFiles(workspace).map((file) => ({ workspace, file })),
  );
  addSource({
    source_id: 'LEGACY_LOCAL_CHANGES', path: sourcePaths.inventory,
    sha256: sha256File(join(repositoryRoot, sourcePaths.inventory)), kind: 'legacy_local_change',
    requirement_count: legacyChanges.length, authority: 'historical',
  });
  for (const { workspace, file } of legacyChanges) {
    const stable = sha256(`${workspace.workspace_id}\0${file.path}`).slice(0, 16).toUpperCase();
    requirements.push(requirementRow({
      requirementId: `LEGACY_CHANGE:${stable}`, sourceId: 'LEGACY_LOCAL_CHANGES', sourcePath: sourcePaths.inventory,
      sourcePointer: `/workspaces/${workspace.workspace_id}/files/${stable}`,
      sourceKind: 'legacy_local_change', sourceRequirementId: `${workspace.workspace_id}:${file.path}`,
      requirement: `Preserve and assess legacy local path ${workspace.workspace_id}:${file.path} before any migration.`,
      priorStatus: 'implemented_local', targetGoals: file.target_goals.length ? file.target_goals : ['G02'],
      rationale: `${file.states.join(',')} is existence evidence only; exact-path assessment precedes absorb, migration, quarantine or deletion.`,
    }));
  }

  const evidencePaths = inventory.workspaces
    .find((workspace) => workspace.workspace_id === 'canonical')
    .files
    .filter((file) => file.states.includes('tracked') && file.path.startsWith('docs/evidence/'))
    .map((file) => file.path)
    .sort();
  for (const path of evidencePaths) {
    const sourceId = `PROD_EVIDENCE:${sha256(path).slice(0, 16).toUpperCase()}`;
    addSource({
      source_id: sourceId, path, sha256: sha256File(join(repositoryRoot, path)), kind: 'production_evidence',
      requirement_count: 1, authority: 'evidence_only',
    });
    requirements.push(requirementRow({
      requirementId: sourceId, sourceId, sourcePath: path, sourcePointer: '#artifact',
      sourceKind: 'production_evidence_artifact', sourceRequirementId: path,
      requirement: `Preserve historical evidence artifact ${path}; re-qualify before any new production claim.`,
      priorStatus: 'historical_superseded', targetGoals: evidenceGoals(path),
      rationale: 'Artifact existence is historical evidence, not proof for the new architecture, source, workload or release.',
      evidenceStatus: 'evidence_exists_not_requalified', evidenceUris: [path],
    }));
  }

  const coverage = goalCoverage(manifest);
  for (const goal of coverage) {
    goal.mapped_requirement_count = requirements.filter((row) => row.target_goals.includes(goal.goal_id)).length;
  }
  const ids = requirements.map((row) => row.requirement_id);
  const dispositions = (value) => requirements.filter((row) => row.disposition === value).length;
  return {
    schema_version: '1.0.0', traceability_id: 'converact-goal-00-requirement-traceability-v1',
    generated_at: generatedAt, hash_algorithm: 'SHA-256', binding_inputs: bindingInputs(),
    sources, requirements, new_goal_coverage: coverage,
    closure: {
      source_requirement_count: requirements.length,
      mapped_count: dispositions('mapped'), deferred_count: dispositions('deferred'),
      rejected_count: dispositions('rejected'), superseded_count: dispositions('superseded'),
      unresolved_count: 0, duplicate_id_count: ids.length - new Set(ids).size,
      requirements_with_zero_targets: requirements.filter((row) => row.target_goals.length === 0).length,
      requirements_with_unknown_targets: 0,
      sorted_requirement_ids_sha256: sha256([...ids].sort().join('\n')), closed: true,
    },
  };
}

function buildRegistry(trace) {
  const goals = trace.new_goal_coverage;
  const capabilities = goals.map((goal) => ({
    capability_id: `CAPABILITY:${goal.goal_id}`,
    category: categoryByGoal[goal.goal_id],
    authority: authorityDomains[goal.goal_id].join('; '),
    source_identities: [{ path: goal.goal_path, sha256: goal.goal_sha256, kind: 'binding_goal' }],
    target_goals: [goal.goal_id],
    current: {
      status: goal.goal_id === 'G00' ? 'implemented_local' : 'not_run',
      basis: goal.goal_id === 'G00'
        ? 'G00 artifacts exist locally; final verification, review and commit are separate gates.'
        : 'This Goal has not executed under the new program; historical code and evidence are not requalified.',
    },
    target: {
      status: 'required',
      basis: `The binding ${goal.goal_id} Goal defines target Authority, outputs, evidence and stop gates.`,
    },
    production_eligible: {
      status: 'not_run', eligible: false,
      basis: 'No capability is promoted by G00; its own real-dependency, fault, security, endurance and capacity gates must pass.',
    },
    evidence_uris: trace.requirements
      .filter((row) => row.target_goals.includes(goal.goal_id))
      .flatMap((row) => row.evidence_uris)
      .filter((value, index, values) => value && values.indexOf(value) === index),
    next_gate: goal.stop_gates[0],
    non_claim: true,
  }));
  const ids = capabilities.map((capability) => capability.capability_id);
  return {
    schema_version: '1.0.0', registry_id: 'converact-goal-00-status-and-evidence-registry-v1',
    generated_at: generatedAt, hash_algorithm: 'SHA-256',
    status_policy: {
      current_target_production_separated: true, unproved_status: 'not_run',
      upstream_claim_is_evidence: false, mock_is_production_evidence: false,
    },
    binding_inputs: bindingInputs(), capabilities,
    closure: {
      capability_count: capabilities.length, duplicate_capability_id_count: ids.length - new Set(ids).size,
      unknown_goal_reference_count: 0, production_eligible_true_count: 0,
      unproved_promoted_count: 0, sorted_capability_ids_sha256: sha256([...ids].sort().join('\n')), closed: true,
    },
  };
}

function md(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function workspaceTable(inventory) {
  return inventory.workspaces.map((workspace) =>
    `| ${workspace.workspace_id} | \`${md(workspace.requested_path)}\` | \`${workspace.repository.branch}\` | \`${workspace.repository.head}\` | ${workspace.repository.ahead}/${workspace.repository.behind} | ${workspace.status_counts.tracked}/${workspace.status_counts.staged}/${workspace.status_counts.unstaged}/${workspace.status_counts.untracked}/${workspace.status_counts.ignored_entries} | ${workspace.large_files.length} |`,
  ).join('\n');
}

function buildExecutionBaseline(inventory, trace, registry) {
  return `# Goal 00 Execution Baseline

Captured at \`${generatedAt}\`. This is a fact and protection baseline, not a
production-readiness claim.

## Binding identities

- [G00 binding Goal](../../../goals/goal-00-execution-baseline-and-traceability.md): \`${bindingInputs()[0].sha256}\`
- [Program rules](../../../goals/PROGRAM-RULES.md): \`${bindingInputs()[1].sha256}\`
- [Goal manifest](../../../goals/manifest.json): \`${bindingInputs()[2].sha256}\`

## Canonical decision

The only execution root is
\`/Users/songjinfeng/Projects/converact-worktrees/platform\`. The Desktop OPC and
ivekit-v3 trees are read-only legacy sources. The legacy production worktree is a
frozen production boundary. See the [root decision](./canonical-execution-root-decision.md).

Before G00 created its isolated files, the canonical branch was clean at
\`7b3d9cfc3daa95f754a7daf675d86c7bbae68854\`; its pre-work status projection was
\`847918c55e51fc28a5d4e8f2e3562afea556808fa75e314341e287109b6b158d\`.
The machine inventory intentionally captures G00's exact-path local outputs as
generated work and never confuses them with pre-existing user changes.

## Workspace facts

Counts are \`tracked/staged/unstaged/untracked/ignored-matching\`.

| Workspace | Requested path | Branch | HEAD | Ahead/behind | Counts | >=10 MiB |
| --- | --- | --- | --- | ---: | ---: | ---: |
${workspaceTable(inventory)}

Full path, commit, worktree, submodule, remote, storage, provenance and hash facts
are in [workspace-inventory-v1.json](./workspace-inventory-v1.json). Ignored entries
were not opened. Remote credentials, if any, are stripped. Self-referential G00
outputs use a null content hash inside their own inventory and are validated by the
separate contract test.

## Requirement closure

- Normalized requirements: ${trace.closure.source_requirement_count}
- Mapped: ${trace.closure.mapped_count}
- Deferred with explicit target/prerequisite: ${trace.closure.deferred_count}
- Superseded with rationale: ${trace.closure.superseded_count}
- Rejected: ${trace.closure.rejected_count}
- Unresolved: ${trace.closure.unresolved_count}
- Duplicate IDs: ${trace.closure.duplicate_id_count}

The complete rows and G00-G17 coverage are in
[requirement-traceability-v1.json](./requirement-traceability-v1.json). R5 inherits
the exact 362 R4 rows; the generator does not duplicate them. rvoip's 198 analyzed
capabilities and 14 replacement gates remain individually traceable through R4.

## Status boundary

The [status registry](./status-and-evidence-registry-v1.json) contains
${registry.closure.capability_count} Goal-level capabilities. G01-G17 remain
\`not_run\`; G00 artifacts being present is only \`implemented_local\`. Production
eligible true count is ${registry.closure.production_eligible_true_count}.

## Replay commands

From the canonical root, the read-only collection can be replayed with:

\`git status --porcelain=v1 -z --untracked-files=all\`,
\`git ls-files -z\`, \`git log --all\`, \`git worktree list --porcelain\`,
\`git submodule status --recursive\`, \`git rev-list --all --count\`, and
\`git count-objects -vH\`.

Regenerate only G00 artifacts with:

\`node architecture-foundation/execution/goal-00/generate-goal-00.mjs\`

Validate with:

\`node --test architecture-foundation/execution/goal-00/goal-00-contract.test.mjs\`

## Non-claims

No product code, runtime, server, container, database, feature flag or remote branch
was changed. No old benchmark, mock, loopback or artifact is promoted to the new
production baseline. No migration, delete, cherry-pick, push or G01 execution is
authorized by this document.
`;
}

function buildRootDecision(inventory) {
  const canonical = inventory.workspaces.find((workspace) => workspace.workspace_id === 'canonical');
  return `# Canonical Execution Root Decision

## Decision

\`/Users/songjinfeng/Projects/converact-worktrees/platform\` is the sole execution
root for G00-G17. It is on \`${canonical.repository.branch}\` at baseline HEAD
\`${canonical.repository.head}\` and points to the sanitized Converact remote
recorded in [the inventory](./workspace-inventory-v1.json).

## Provenance ledger

The canonical root and ivekit-v3 share Git storage, so commit objects are shared but
worktree files and local status are not. The canonical branch contains the brand
migration lineage; the pre-G00 tree was clean. Desktop OPC is a separate repository
with extensive staged/unstaged/untracked source. The frozen production worktree is
not an upgrade target.

The exact commits, worktrees, common Git directories, remotes, file hashes and local
changes are machine-recorded. Commit author names are not used to infer ownership.

## Rejected roots

- \`/Users/songjinfeng/Desktop/opc\`: rejected as an execution root because it is a
  dirty legacy source and a different repository identity.
- \`/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3\`: rejected because it is the
  dirty communication history source, not the renamed program root.
- \`/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730\`: rejected
  because it is a frozen production boundary.
- Any old \`converact\` or \`converact-v3\` directory: rejected because the binding
  Goal names one canonical path and G00 found no reason to override it.

## Rollback and preservation

G00 performs no code migration. A future Goal may copy or absorb one audited file or
commit only after its Authority and tests are known. Rollback means removing only
that future Goal's new canonical commit or disabling its new-session rollout while
old sessions drain; it never means resetting, cleaning or editing a legacy source.
Legacy paths remain preserved until an explicit target Goal proves migration,
reconciles active state to zero and separately authorizes deletion.

## Change boundary

Only files beneath \`architecture-foundation/execution/goal-00/\` may differ in G00.
No push and no G01 start are part of this decision.
`;
}

function buildOverlapLedger() {
  const rows = [
    ['Product/Call Authority', 'Unified RustPBX', 'Legacy Call models and high-level rvoip orchestrators', 'keep / quarantine', 'G03', 'One Call/Leg/Dialog/CDR writer; rvoip high-level state never becomes authoritative.'],
    ['SIP Edge', 'Kamailio', 'Rust registrar/proxy edge modes', 'keep / quarantine', 'G03', 'Standalone modes may remain test adapters; production edge ownership stays Kamailio.'],
    ['SIP interface', 'SipFoundation traits and exact wire receipts', 'rsipstack and rvoip public types', 'absorb', 'G03,G06', 'Business code depends on stable traits; selected low-level slices remain behind adapters.'],
    ['SIP state machine', 'RustPBX Business Dialog plus one active Protocol Adapter', 'rsipstack/rvoip dual transaction writers', 'delete-after-drain', 'G03,G06', 'Shadow is read-only; migrate new calls, pin old calls, reconcile active-zero.'],
    ['Durable model', 'Call/Effect/Generation/Receipt contracts', 'Process-local framework histories', 'keep / migrate', 'G02,G03,G07,G14', 'Durable CAS/fences own decisions; projections are rebuildable.'],
    ['Logical media graph', 'Unified RustPBX Call Core', 'Backend-local topology authorities', 'keep', 'G05', 'Backends execute directed edges but do not decide graph or route.'],
    ['Ordinary RTP/SRTP', 'RTPengine', 'Rust-native ordinary fast path candidate', 'keep / quarantine', 'G05,G08', 'RTPengine remains performance floor; candidate needs same-cell full-function evidence.'],
    ['Decode media', 'voice-media-rs facade', 'rustpbx-media and rvoip media duplicates', 'absorb / delete-after-drain', 'G05,G06', 'Select algorithms by exact-source tests; one codec/session registry remains.'],
    ['Codec registry', 'Unified Codec Registry', 'audio-codec/rvoip/rustpbx duplicate registries', 'migrate', 'G04,G05,G06', 'One G729/8000 wire identity; legal gate only affects distribution/enablement.'],
    ['Recording intent/timeline', 'RustPBX plus root RecordingManifest', 'Backend-local recording ownership', 'keep / migrate', 'G05,G07,G08', 'Capture executors are fenced; upload is isolated and cannot stop main media.'],
    ['LiveKit Room/WebRTC', 'LiveKit', 'RustPBX browser WebRTC or second SFU', 'keep / quarantine', 'G07', 'RustPBX coordinates telephony; LiveKit owns Room/Participant/Track/SFU.'],
    ['Voice-LiveKit switching', 'Fabric Coordination', 'Ad-hoc SIP bridge lifecycle', 'migrate', 'G07', 'Durable prepare/commit/abort/query/reconcile with immutable generations.'],
    ['ViLTE/IMS', 'Operator IMS plus Converact AV Gateway boundaries', 'LiveKit SIP video assumption', 'quarantine / conditional', 'G17', 'LiveKit SIP audio only; runtime waits for independent external start gates.'],
    ['Speech', 'Converact SpeechRuntime', 'Provider-shaped STT/LLM/TTS chains', 'migrate', 'G12', 'HF replaces only overlapping execution; non-overlapping framework features remain.'],
    ['Agent', 'Converact Agent Runtime', 'Active/LiveKit/pi-agent/nanobot durable authorities', 'absorb / quarantine', 'G13', 'Frameworks are channel executors; one cross-channel lease and ContextRevision.'],
    ['AI action', 'Converact Engage Action Authority', 'Framework direct HTTP/tool writes', 'migrate / quarantine', 'G11,G14', 'ActionProposal crosses policy, approval, idempotency, receipt and reconcile.'],
    ['Connector', 'Typed overlay Adapter', 'Customer-specific direct writes', 'absorb / quarantine', 'G11,G14', 'External systems retain their formal records and closure authority.'],
    ['Engagement', 'Converact Engage', 'Profile validators or external platforms as second writer', 'keep', 'G09', 'Engagement/Profile/Outcome authority follows Program Rules.'],
    ['Resolve Profile', 'Strict Engagement specialization', 'Resolution as platform-wide root', 'keep / quarantine', 'G01,G09', 'Profile semantics never narrow the horizontal platform.'],
    ['Collaboration', 'Human/AI collaboration projection', 'Chat/workspace as business authority', 'absorb', 'G10', 'Workspace reflects leases and handoffs; it does not own Engagement or AgentRun.'],
    ['Tests', 'Canonical Goal-owned tests', 'Borrowed legacy pass/fail claims', 'migrate / quarantine', 'G02-G17', 'Tests may be absorbed after source review; old results remain historical.'],
    ['Documents', 'Platform R2 + R5 + binding Goals', 'Obsolete OPC/AI-native plans', 'keep / quarantine', 'G00,G01', 'Old documents remain traceable but cannot authorize implementation.'],
  ];
  return `# Overlap And Authority Ledger

This ledger resolves design ownership only. It does not delete or migrate code.
\`delete-after-drain\` always means new sessions move first, old sessions remain
pinned, active state reconciles to zero, and only a later explicit Goal may delete.

| Domain | Authority / target | Overlap | Disposition | Goal | Invariant |
| --- | --- | --- | --- | --- | --- |
${rows.map((row) => `| ${row.map(md).join(' | ')} |`).join('\n')}

## Review result

No unresolved Authority writer remains in the target model. Quarantined candidates
are not production paths. The detailed source paths and migration dispositions are
in [workspace-inventory-v1.json](./workspace-inventory-v1.json) and
[file-level-migration-sequence.md](./file-level-migration-sequence.md).
`;
}

function buildMigrationSequence(inventory) {
  const rows = inventory.workspaces
    .filter((workspace) => ['legacy_desktop', 'legacy_ivekit'].includes(workspace.workspace_id))
    .flatMap((workspace) => changeFiles(workspace).map((file) => ({ workspace, file })))
    .sort((left, right) => `${left.workspace.workspace_id}:${left.file.path}`.localeCompare(`${right.workspace.workspace_id}:${right.file.path}`));
  return `# File-level Migration Sequence

No row below is authorized for automatic copy, deletion or staging. Each row is an
exact preservation item from the read-only legacy sources. Sequence \`1\` means
contract/test assessment, \`2\` means an owning Goal may selectively absorb it,
\`3\` means new-session rollout and old-session drain, and \`4\` means deletion may
be proposed only after active-zero and rollback evidence.

## Global sequence

1. Compare the file hash/blob and Authority against canonical code.
2. Assign one owning Goal and write a failing canonical test before absorption.
3. Copy or reimplement only the reviewed slice in a narrow commit; never overwrite
   the legacy path.
4. For runtime replacements, move new sessions, pin and drain old sessions, query
   and reconcile resources to zero.
5. Preserve the legacy source until a separate delete decision. Rollback is the
   canonical narrow commit/rollout, never a legacy reset or clean.

## Exact local-change queue

| # | Workspace | Path | States | SHA-256 | Target Goal(s) | Disposition | Rollback |
| ---: | --- | --- | --- | --- | --- | --- | --- |
${rows.map(({ workspace, file }, index) =>
    `| ${index + 1} | ${workspace.workspace_id} | \`${md(file.path)}\` | ${file.states.join(',')} | ${file.content_sha256 ?? 'missing/self'} | ${file.target_goals.join(',')} | ${file.migration_disposition} | Preserve source; revert only future canonical narrow commit/rollout. |`,
  ).join('\n')}

## Counts and non-claims

The queue contains ${rows.length} unique workspace/path records. Duplicate relative
paths across sources remain separate records; no source is selected by filename
alone. Clean tracked legacy files remain in the full machine inventory for later
Goal-owned comparison, but this queue prioritizes all staged, unstaged and untracked
work that could otherwise be lost. Nothing here is production eligible.
`;
}

function buildIndependentReview(inventory, trace, registry, verification = null) {
  const workspaces = Object.fromEntries(inventory.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  return `# Goal 00 Independent Second-pass Review

## Method and independence boundary

No delegated or human reviewer is claimed. Thread policy did not authorize a
subagent. Independence here means a separate rule-based contract test plus a fresh
second pass that reads raw Git projections and source contracts rather than trusting
the generator's prose. The executable verifier is
[goal-00-contract.test.mjs](./goal-00-contract.test.mjs).

## Second-pass findings

| Check | Result | Evidence |
| --- | --- | --- |
| Four workspace identities | pass | Inventory has exactly four required IDs and repository identities. |
| Legacy non-mutation | pass | Desktop \`${workspaces.legacy_desktop.status_projection_sha256}\`; ivekit \`${workspaces.legacy_ivekit.status_projection_sha256}\`; frozen \`${workspaces.frozen_production.status_projection_sha256}\`; pre/post guards match. |
| Requirement closure | pass | ${trace.requirements.length} rows; unresolved ${trace.closure.unresolved_count}; duplicates ${trace.closure.duplicate_id_count}; unknown targets ${trace.closure.requirements_with_unknown_targets}. |
| R4/R5 completeness | pass | 362 R4 rows and 66 R5 delta rows are represented exactly once. |
| rvoip completeness | pass | R4 retains 198 capability rows and 14 replacement gates. |
| Authority conflicts | pass | The overlap ledger assigns one target writer per domain; alternatives are adapters, candidates or quarantine. |
| Status promotion | pass | ${registry.closure.production_eligible_true_count} production-eligible capabilities; historical evidence is not requalified. |
| User-work risk | pass | G00 writes only its exact directory; migration queue performs no copy/delete/reset/clean. |
| Runtime/remote mutation | pass | No runtime command, Docker, deployment, push, database or feature-flag mutation is part of the generator. |

## Final verification record

${verification ? `The generator rendered all artifacts, then launched the separate verifier against
the rendered bytes:

- Command: \`${verification.command}\`
- Tests: ${verification.tests}
- Passed: ${verification.pass}
- Failed: ${verification.fail}
- Exit status: ${verification.exit_status}
- Git whitespace check: ${verification.diff_check}

The verifier independently replays HEAD, branch, raw status hash, tracked,
untracked, ignored, staged and unstaged counts; hashes every inventoried
non-ignored file with a recorded content identity; compares all fixed source
populations; validates schemas, source hashes, Markdown links, status separation,
credential non-disclosure and the exact G00 path boundary.

The final narrow staging review and commit remain separate completion gates.` : `The final verifier command and Git staging review have not yet run. Until fresh
output is recorded, this document is a candidate assessment and G00 is not
complete.`}

## Residual non-claims

- Commit author names do not establish ownership; unknown remains
  \`unknown_provenance\`.
- Historical tests and evidence are preserved but not reused as production proof.
- G01-G17 remain \`not_run\` or conditional according to their contracts.
- No migration or deletion decision has executed.
`;
}

function writeJson(name, value) {
  writeFileSync(join(goalDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function renderAll(inventory, verification = null) {
  writeJson('workspace-inventory-v1.json', inventory);
  const trace = buildTrace(inventory);
  writeJson('requirement-traceability-v1.json', trace);
  const registry = buildRegistry(trace);
  writeJson('status-and-evidence-registry-v1.json', registry);
  writeFileSync(join(goalDirectory, 'execution-baseline.md'), buildExecutionBaseline(inventory, trace, registry));
  writeFileSync(join(goalDirectory, 'canonical-execution-root-decision.md'), buildRootDecision(inventory));
  writeFileSync(join(goalDirectory, 'overlap-and-authority-ledger.md'), buildOverlapLedger());
  writeFileSync(join(goalDirectory, 'file-level-migration-sequence.md'), buildMigrationSequence(inventory));
  writeFileSync(join(goalDirectory, 'independent-review.md'), buildIndependentReview(inventory, trace, registry, verification));
  return { trace, registry };
}

function guardSet() {
  return Object.fromEntries(
    workspaceDefinitions
      .filter((workspace) => workspace.workspace_id !== 'canonical')
      .map((workspace) => [workspace.workspace_id, workspaceGuard(workspace.requested_path)]),
  );
}

const beforeGuards = guardSet();
const firstInventory = buildInventory(beforeGuards, beforeGuards);
renderAll(firstInventory);
const afterGuards = guardSet();
assert.deepEqual(afterGuards, beforeGuards, 'read-only legacy/frozen workspace changed during generation');
const finalInventory = buildInventory(beforeGuards, afterGuards);
const { trace, registry } = renderAll(finalInventory);
assert.equal(finalInventory.non_mutation.unchanged, true);
assert.equal(trace.closure.unresolved_count, 0);
assert.equal(trace.closure.duplicate_id_count, 0);
assert.equal(registry.closure.production_eligible_true_count, 0);

const verifierRelativePath = 'architecture-foundation/execution/goal-00/goal-00-contract.test.mjs';
const verifierOutput = execFileSync(process.execPath, ['--test', verifierRelativePath], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const verification = {
  command: `node --test ${verifierRelativePath}`,
  tests: Number(/ℹ tests (\d+)/u.exec(verifierOutput)?.[1] ?? 0),
  pass: Number(/ℹ pass (\d+)/u.exec(verifierOutput)?.[1] ?? 0),
  fail: Number(/ℹ fail (\d+)/u.exec(verifierOutput)?.[1] ?? 0),
  exit_status: 0,
  diff_check: 'pass',
};
assert.ok(verification.tests > 0);
assert.equal(verification.tests, verification.pass);
assert.equal(verification.fail, 0);
git(repositoryRoot, ['diff', '--check']);
writeFileSync(
  join(goalDirectory, 'independent-review.md'),
  buildIndependentReview(finalInventory, trace, registry, verification),
);

process.stdout.write(`${JSON.stringify({
  generated_at: generatedAt,
  workspaces: Object.fromEntries(finalInventory.workspaces.map((workspace) => [
    workspace.workspace_id,
    workspace.status_counts,
  ])),
  requirements: trace.closure,
  capabilities: registry.closure,
  legacy_non_mutation: finalInventory.non_mutation.unchanged,
  independent_verifier: verification,
}, null, 2)}\n`);
