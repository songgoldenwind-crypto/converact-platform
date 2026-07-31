# Converact Full Rename Implementation Plan

> **Execution:** Run inline, task-by-task, in the isolated worktree. Use TDD for executable
> compatibility behavior and narrow commits for mechanical rename groups. Do not use subagents.

**Goal:** Replace the active `OPC` and `iveKit` product/repository identity with `Converact`, preserve
explicit compatibility and historical facts, rename the GitHub repositories, and prove that no
unclassified legacy product name remains.

**Architecture:** The migration is policy-driven. A machine-readable naming policy distinguishes
current product surfaces, compatibility identifiers, and immutable historical evidence. GitHub and
filesystem names move first; active packages, source, infrastructure, and documentation then migrate
in bounded groups. A verifier fails on every legacy name not covered by an explicit compatibility or
historical rule.

**Tech Stack:** Git/GitHub CLI, TypeScript/Node.js, npm, Rust/Cargo, Go, Python, Helm/YAML, Markdown,
JSON/JSON Schema.

---

## Guardrails applying to every task

- Work only in `/Users/songjinfeng/Projects/converact-worktrees/platform-renaming` until Task 11 moves
  the worktree to its final path.
- Do not change the server, its containers, release symlink, credentials, or runtime configuration.
- Do not modify files in `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730`.
- Preserve `maintenance/legacy-production-20260730` at commit `b6a26269ce05` unless a fresh read-only
  check proves it already advanced outside this task; any drift is a stop condition.
- Preserve all dirty/staged/untracked work in `/Users/songjinfeng/Desktop/opc` and
  `/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3`.
- Never use global replacement over `docs/evidence/**`, patch payloads, lockfiles, database migrations,
  external protocol names, commit hashes, or historical objective files.
- Never use `git add .`; stage exact paths for each commit.
- Do not push a branch until all local verification in Task 10 passes.

## Task 0: Freeze baseline and generate the initial inventory

**Files:**

- Create: `config/branding/converact-naming-policy.json`
- Create: `config/branding/converact-naming-policy.schema.json`
- Create: `docs/design/converact-rename-inventory.md`
- Create: `scripts/converact-name-inventory.ts`
- Test: `test/converact-name-inventory.test.ts`

- [ ] **Step 1: Record the immutable baseline**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git worktree list --porcelain
git remote -v
git -C /Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730 status --short --branch
git -C /Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730 rev-parse HEAD
```

Expected: the rename worktree is clean, its HEAD contains the naming contract, and the frozen
production worktree is clean at `b6a26269ce05`.

- [ ] **Step 2: Write the failing inventory test**

The test creates a temporary fixture containing one active `OPC Platform` string, one allowed
`OPC_*` compatibility identifier, and one historical Evidence path. It asserts exactly one violation:

```ts
assert.deepEqual(
  scanLegacyNames(fixtureRoot, policy).map((finding) => finding.rule),
  ['legacy_product_name']
);
```

- [ ] **Step 3: Run the test and verify RED**

```bash
node --import tsx --test test/converact-name-inventory.test.ts
```

Expected: FAIL because `scanLegacyNames` and the policy loader do not exist.

- [ ] **Step 4: Implement deterministic inventory scanning**

`scripts/converact-name-inventory.ts` must read `git ls-files -z`, classify path and content matches,
emit stable JSON sorted by path/line/column/token, distinguish `rename`, `compatibility`, `historical`,
and `external`, reject unmatched occurrences, and never print file contents or environment values.

The policy contains these exact identities:

```json
{
  "brand": { "legacy": ["OPC", "iveKit"], "current": "Converact" },
  "repository": {
    "legacy": "songgoldenwind-crypto/opc-platform",
    "current": "songgoldenwind-crypto/converact-platform"
  },
  "environment": {
    "legacyPrefixes": ["OPC_", "OPC_IVEKIT_"],
    "currentPrefixes": ["CONVERACT_", "CONVERACT_FABRIC_"]
  }
}
```

- [ ] **Step 5: Run the test and inventory**

```bash
node --import tsx --test test/converact-name-inventory.test.ts
node --import tsx scripts/converact-name-inventory.ts \
  --json .runtime/converact-rename-inventory.json \
  --markdown docs/design/converact-rename-inventory.md
```

Expected: test PASS; the report classifies all current occurrences without treating pending `rename`
items as completed.

- [ ] **Step 6: Commit the baseline inventory**

Stage only the five listed files and commit:

```text
test(branding): inventory legacy names
```

## Task 1: Preflight and rename the primary GitHub repository

**Files/external state:**

- Create: `docs/operations/converact-repository-rename-runbook.md`
- Rename: `songgoldenwind-crypto/opc-platform` → `songgoldenwind-crypto/converact-platform`
- Modify: Git remotes of all independent `opc-platform` clones

- [ ] **Step 1: Prove permission and target availability**

```bash
gh auth status
gh repo view songgoldenwind-crypto/opc-platform --json name,visibility,isPrivate,defaultBranchRef,url
gh repo view songgoldenwind-crypto/converact-platform --json name,url
```

Expected: source is private and accessible; target returns `Could not resolve to a Repository`.

- [ ] **Step 2: Capture non-redirecting dependencies**

Scan exact repository URLs, reusable Actions, webhooks, package/container sources, deployment scripts,
badges, and documentation. GitHub redirects ordinary repository traffic and Git operations, but not
Actions referenced through the old repository name.

- [ ] **Step 3: Rename the private repository**

```bash
gh repo rename converact-platform --repo songgoldenwind-crypto/opc-platform --yes
```

Expected: the new repository has the same ID, visibility, history, branches, tags, and `main` default.

- [ ] **Step 4: Update every independent clone remote**

Set `origin` to `https://github.com/songgoldenwind-crypto/converact-platform.git` in:

```text
/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3
/Users/songjinfeng/Desktop/opc/.worktrees/livekit-acceptance
/Users/songjinfeng/Desktop/opc/.worktrees/ivekit-v2
/Users/songjinfeng/Desktop/opc/.worktrees/ivekit-v3
```

The linked production worktree shares the first clone's Git config; do not edit its files.

- [ ] **Step 5: Verify redirects and remote integrity**

Run `git ls-remote` against old and new URLs and `git fetch --dry-run origin` in every clone. Verify
`maintenance/legacy-production-20260730` still resolves to the recorded commit.

- [ ] **Step 6: Commit the runbook**

Stage only `docs/operations/converact-repository-rename-runbook.md` and commit:

```text
docs(ops): record repository rename
```

## Task 2: Add an enforceable naming policy gate

**Files:**

- Modify: `scripts/converact-name-inventory.ts`
- Modify: `config/branding/converact-naming-policy.json`
- Create: `scripts/verify-converact-naming.ts`
- Create: `test/converact-naming-policy.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ivekit-component-hooks-ci.yml`

- [ ] **Step 1: Write failing policy tests**

Cover current product text, active `OPC Platform`, active `iveKit` package names, `OPC_API_KEY`
classification, historical Evidence, patch provenance, old repository URLs in workflows, and unknown
legacy dispositions.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/converact-naming-policy.test.ts
```

Expected: FAIL because the enforcement CLI is absent.

- [ ] **Step 3: Implement the gate**

The verifier exits non-zero when an inventory item is `rename` or `unclassified`, prints counts and
paths only, and exposes:

```json
"verify:converact-naming": "node --import tsx scripts/verify-converact-naming.ts"
```

The workflow runs tests and the verifier before build jobs.

- [ ] **Step 4: Verify fixture GREEN and repository RED**

Fixture tests pass. The repository verifier still fails with the exact pending migration count until
Task 9; that failure is evidence of remaining work.

- [ ] **Step 5: Commit the gate**

```text
test(branding): enforce Converact names
```

## Task 3: Rename packages, clients, SDKs, and active directories

**Files:**

- Move: `clients/ivekit-reference/` → `clients/converact-reference/`
- Move: `sdk/ivekit/` → `sdk/converact/`
- Move: `services/ivekit-service/` → `services/converact-service/`
- Move: `infra/ivekit/` → `infra/converact/`
- Move: `src/agent-runtime/ivekit/` → `src/agent-runtime/converact/`
- Move: active `src/ivekit-*.ts` → corresponding `src/converact-*.ts`
- Modify: package metadata, lockfiles, imports, scripts, build contexts, Helm paths, and tests

- [ ] **Step 1: Write failing package/path contract tests**

Assert target paths exist, legacy active paths do not, and package names equal:

```text
converact-platform
converact-console
@converact/reference-client
@converact/sdk
@converact/service
@converact/capacity-runtime
@converact/javascript-sdk
converact-agent-panel
@converact/rustdesk-edge-agent
```

Assert the Rust package becomes `converact-component-hook`, with Helm charts
`converact-platform`, `converact-service`, and `converact-rtpengine`.

- [ ] **Step 2: Verify RED**

Run the contract test and confirm failure on current paths and package names.

- [ ] **Step 3: Move active paths with exact `git mv` operations**

Move the five directories and active entrypoints. Do not rename Evidence, patch filenames, migration
filenames, or historical plans in this task.

- [ ] **Step 4: Update package and build metadata**

Update names, imports, npm scripts, Docker contexts, Helm chart names, TypeScript paths, client runtime
config filenames, and lockfile package roots. Keep public registry publication `not_run` until the
`@converact` scope is controlled.

- [ ] **Step 5: Verify package/path contracts and builds**

```bash
npm ci
node --import tsx --test test/converact-package-paths.test.ts
npm run typecheck
npm --prefix clients/converact-reference test
npm --prefix clients/converact-reference run build
npm --prefix sdk/converact test
npm --prefix sdk/converact run build
npm --prefix services/converact-service test
npm --prefix services/converact-service run build
cargo test --manifest-path integrations/component-hook-rs/Cargo.toml
helm lint infra/k8s
helm lint infra/converact/helm/rtpengine
helm lint services/converact-service/helm/converact
```

Expected: all commands exit zero; publication remains `not_run`.

- [ ] **Step 6: Commit package/path migration**

```text
refactor(brand): rename active platform packages
```

## Task 4: Implement `CONVERACT_*` environment compatibility

**Files:**

- Create: `src/config/converact-env.ts`
- Create: `test/converact-env.test.ts`
- Create: `services/ai-agent-py/converact_env.py`
- Create: `services/ai-agent-py/tests/test_converact_env.py`
- Modify: active TypeScript, Python, Go, Rust, shell, Compose, Helm, and example readers

- [ ] **Step 1: Write TypeScript RED tests**

```ts
assert.equal(resolveBrandEnv({ CONVERACT_API_KEY: 'new' }, 'API_KEY'), 'new');
assert.equal(resolveBrandEnv({ OPC_API_KEY: 'old' }, 'API_KEY'), 'old');
assert.equal(
  resolveBrandEnv({ CONVERACT_API_KEY: 'same', OPC_API_KEY: 'same' }, 'API_KEY'),
  'same'
);
assert.throws(
  () => resolveBrandEnv({ CONVERACT_API_KEY: 'new', OPC_API_KEY: 'old' }, 'API_KEY'),
  /conflicting branded environment variables/
);
```

Also prove `CONVERACT_FABRIC_INSTANCE_ID` aliases `OPC_IVEKIT_INSTANCE_ID`; errors may name keys but
never values.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test test/converact-env.test.ts
```

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement the TypeScript resolver**

Expose `resolveBrandEnv`, `resolveFabricEnv`, and `installBrandEnvAliases`. Use own properties, treat
empty strings as explicit, fail on unequal dual values, redact values, and emit a structured
deprecation event only when an old key is the sole source.

- [ ] **Step 4: Write and implement Python parity**

Run `python3 -m unittest services.ai-agent-py.tests.test_converact_env` RED, implement the same rules,
then rerun GREEN.

- [ ] **Step 5: Migrate active readers**

Replace active `OPC_IVEKIT_*` reads with `resolveFabricEnv` and remaining active `OPC_*` reads with
`resolveBrandEnv`. New examples expose `CONVERACT_*`; old keys remain only in resolvers, compatibility
tests, migration docs, or explicit deprecated alias tables. Go/Rust/shell helpers obey the same four
cases and never silently prefer conflicting values.

- [ ] **Step 6: Verify configuration parity**

Run TypeScript/Python and touched Go/Rust tests, `npm run typecheck`, static Compose/Helm rendering,
and the naming inventory. No active direct environment read may remain unclassified.

- [ ] **Step 7: Commit environment compatibility**

```text
refactor(config): migrate Converact environment keys
```

## Task 5: Rename source symbols, API presentation, and product UI

**Files:**

- Modify: active `src/**`, `frontend/**`, `clients/converact-reference/**`, `sdk/**`, `services/**`
- Move: active scripts and tests whose filenames start with `ivekit-` or contain `opc-`
- Preserve: stable API paths, database tables, migration IDs, event IDs, and historical IDs

- [ ] **Step 1: Write failing presentation and import tests**

Assert page titles, product labels, API metadata, generated SDK metadata, CLI help, and active runtime
service names use `Converact`, `Converact Fabric`, `Converact Engage`, `Converact Agent Runtime`, or
`Converact Resolve` as appropriate.

- [ ] **Step 2: Rename active source symbols and files**

Use semantic mappings rather than blind casing replacement:

```text
Ivekit* product symbols      → ConveractFabric*
ivekit service/entrypoint    → converact service/entrypoint
OPC product presentation    → Converact
OPC/iveKit aggregate brand  → Converact Fabric
```

Do not rename third-party `LiveKit`, SIP `Call-ID`, published wire fields, or database identifiers
solely for aesthetics.

- [ ] **Step 3: Preserve exported compatibility**

For an already published TypeScript/SDK name, make the Converact symbol authoritative and export the
old symbol as a deprecated alias with one removal version. Both names call one implementation.

- [ ] **Step 4: Verify active code and UI**

Run typecheck, touched unit suites, frontend build, reference-client build/tests, SDK build/tests, and
the naming verifier. No active product-facing old label may remain.

- [ ] **Step 5: Commit source and presentation migration**

```text
refactor(brand): adopt Converact product identity
```

## Task 6: Rename infrastructure, workflows, images, and charts

**Files:**

- Move: `.github/workflows/ivekit-*.yml` → `.github/workflows/converact-*.yml`
- Modify: `.github/workflows/**`, `infra/**`, Compose files, Dockerfiles, and Helm charts
- Move: `config/grafana/provisioning/dashboards/opc.yml` → `converact.yml`
- Move: `config/ivr/opc_m1.toml` → `converact_m1.toml`
- Move: `infra/k8s/templates/opc-deployment.yaml` → `converact-deployment.yaml`
- Move: `integrations/n8n/opc-manifest.json` → `converact-manifest.json`
- Move: `public/widget/opc-chat-widget.js` → `converact-chat-widget.js`

- [ ] **Step 1: Write failing infrastructure contract tests**

Assert target workflow filenames, chart names, labels, service names, image repositories, OCI source
labels, dashboards, deployment templates, and widget filenames. Old immutable image references are
allowed only in historical Evidence and frozen release inventories.

- [ ] **Step 2: Migrate new-build artifacts**

New images use `ghcr.io/songgoldenwind-crypto/converact-*`. Do not delete or retag old `opc-*` images;
the frozen production line still pulls them by digest. OCI source labels use the new repository URL.

- [ ] **Step 3: Rename workflows and non-production resources**

Update paths, artifacts, cache keys, concurrency groups, release names, Helm helpers, Kubernetes
labels, dashboards, and scripts. Do not apply manifests or run Docker locally.

- [ ] **Step 4: Verify static infrastructure**

Run YAML parsing, `helm lint`, safe `docker compose config` rendering only, existing preflight unit
tests, OCI reference tests, and the naming verifier.

- [ ] **Step 5: Commit infrastructure migration**

```text
build(brand): rename Converact artifacts
```

## Task 7: Migrate canonical architecture, goals, and active documentation

**Files:**

- Reconcile: `/Users/songjinfeng/Desktop/opc/architecture-foundation/**`
- Modify: canonical `README`, `CONTEXT.md`, `AGENTS.md`, `CLAUDE.md`, active `docs/design/**`,
  `docs/adr/**`, `docs/capacity/**`, runbooks, OpenAPI titles, and goals
- Move: active documentation filenames containing `opc` or `ivekit` to Converact equivalents
- Preserve: `docs/evidence/**`, historical objectives, exact legacy keys, and patch provenance

- [ ] **Step 1: Hash both documentation sources**

Create a ledger containing source path/repository/commit or dirty-snapshot marker/SHA-256, target path,
disposition, and conflict resolution. No file enters canonical docs without a ledger row.

- [ ] **Step 2: Reconcile R2/R5 and Goal 00–17**

Use Converact names while preserving every communication, rvoip, G.729, RTPengine, LiveKit, Speech,
AI-native, VOS-EQ, 100K, Profile, Offer, state, and Gate requirement. Never rewrite old Evidence or
promote `not_run`.

- [ ] **Step 3: Update canonical navigation**

The primary hierarchy is:

```text
Converact Platform
├── Converact Fabric
├── Converact Engage
├── Converact Agent Runtime
└── Converact Resolve
```

- [ ] **Step 4: Verify documentation**

Validate Markdown links, JSON/Schema, OpenAPI, goal manifest hashes, traceability, placeholders,
product-state labels, and the naming verifier.

- [ ] **Step 5: Commit canonical documentation**

```text
docs(platform): adopt Converact architecture
```

## Task 8: Verify SDK and external compatibility surfaces

**Files:**

- Modify: `sdk/converact/**`, `sdk/javascript/**`, OpenAPI metadata, widget loader, and examples
- Create: `docs/migrations/opc-to-converact-v1.md`
- Test: SDK, OpenAPI, widget, environment-alias, and deprecated-export compatibility tests

- [ ] **Step 1: Write compatibility tests**

Prove new SDK imports work, legacy exports resolve to the same implementation, stable API paths and
wire fields remain unchanged, and conflicting new/old configuration fails closed.

- [ ] **Step 2: Write the migration guide**

Include package/import/environment/image/Helm/service/repository/product mappings, compatibility
window, conflict behavior, rollback, and identifiers intentionally left stable.

- [ ] **Step 3: Run SDK and contract suites**

Build package tarballs without publishing, inspect contents, validate OpenAPI, and run SDK tests.
Registry publication remains `not_run` until the `@converact` scope is controlled.

- [ ] **Step 4: Commit compatibility surfaces**

```text
docs(migration): publish Converact name map
```

## Task 9: Drive the naming verifier to zero

**Files:**

- Modify: every remaining active path reported by `scripts/verify-converact-naming.ts`
- Modify: `config/branding/converact-naming-policy.json` only for genuine compatibility/history
- Modify: `docs/design/converact-rename-inventory.md`

- [ ] **Step 1: Regenerate and classify every residual**

Each allowlist rule states exact reason, owner, removal condition, and evidence path. Never reclassify
an inconvenient active item as historical merely to pass.

- [ ] **Step 2: Remove all active residuals**

Rename or rewrite every `rename` and `unclassified` finding.

- [ ] **Step 3: Verify zero active residuals**

```bash
npm run verify:converact-naming
```

Expected:

```text
rename=0 unclassified=0
```

Compatibility and historical counts may remain and are printed with rule IDs.

- [ ] **Step 4: Commit residual cleanup**

```text
chore(brand): close legacy name inventory
```

## Task 10: Run full local verification and completion audit

**Files:**

- Create: `docs/evidence/converact-rename-local-verification-2026-07-31.json`
- Create: `docs/evidence/converact-rename-completion-audit-2026-07-31.md`

- [ ] **Step 1: Run the full non-container matrix**

```bash
npm run verify:converact-naming
npm run typecheck
npm test
npm run check:sidecars
npm --prefix frontend run build
npm --prefix clients/converact-reference test
npm --prefix clients/converact-reference run build
npm --prefix sdk/converact test
npm --prefix sdk/converact run build
npm --prefix services/converact-service test
npm --prefix services/converact-service run build
cargo test --manifest-path services/voice-media-rs/Cargo.toml
cargo test --manifest-path integrations/component-hook-rs/Cargo.toml
python3 -m unittest discover -s services/ai-agent-py/tests
```

Run `go test ./...` separately in each touched Go module. Do not replace a failing broad suite with a
passing narrow suite.

- [ ] **Step 2: Validate artifacts and repository state**

Validate JSON/Schema/OpenAPI, Helm, safe Compose rendering, Markdown links, package tarballs, OCI
labels, workflow YAML, remotes, GitHub settings, branch protection, and old URL redirects. Do not start
Docker or alter a server.

- [ ] **Step 3: Recheck frozen production**

Prove the production worktree is clean and its HEAD/tree match Task 0. Use `git status`, `rev-parse`,
and tree comparison rather than relying on its branch name.

- [ ] **Step 4: Write evidence without invented success**

The JSON records command, cwd, start/end, exit code, output digest, source commit, scope, and status.
Unexecuted commands are `not_run`; failures are `failed`, never omitted.

- [ ] **Step 5: Commit verification evidence**

```text
test(brand): verify Converact migration
```

## Task 11: Establish the final canonical worktree and push verified history

**Files/external state:**

- Move worktree to `/Users/songjinfeng/Projects/converact-worktrees/platform`
- Update canonical execution-root manifests and runbooks
- Push `codex/converact-platform-rename` only after Task 10 passes

- [ ] **Step 1: Confirm final path absence and clean state**

Run clean status, worktree inventory, HEAD, remote, and non-destructive path-existence checks.

- [ ] **Step 2: Move through Git**

```bash
git worktree move \
  /Users/songjinfeng/Projects/converact-worktrees/platform-renaming \
  /Users/songjinfeng/Projects/converact-worktrees/platform
```

- [ ] **Step 3: Verify after move**

Re-run HEAD/remote/worktree/clean-state/naming-verifier/frozen-production checks from the new path.

- [ ] **Step 4: Push verified history**

```bash
git push -u origin codex/converact-platform-rename
```

Expected: push succeeds to `songgoldenwind-crypto/converact-platform`; no deployment runs.

## Task 12: Migrate and archive the old `opc` repository

**Files/external state:**

- Source: `/Users/songjinfeng/Desktop/opc`
- Target: canonical Converact repository through reviewed commits only
- Rename: `songgoldenwind-crypto/opc` → `songgoldenwind-crypto/opc-legacy`

- [ ] **Step 1: Complete the G00 source ledger**

Every staged, unstaged, and untracked item receives `migrated`, `duplicate`, `historical`, `generated`,
`secret/private`, or `unresolved` with hash and evidence. Any `unresolved` item blocks archive.

- [ ] **Step 2: Migrate accepted artifacts through narrow commits**

Do not commit from the dirty old index. Apply reviewed files into the clean Converact worktree, verify,
and commit exact paths while preserving source hashes.

- [ ] **Step 3: Prove migration completeness**

Run ledger/goal/trace/hash reconciliation and the full Converact matrix. The old repository must have
no unique required artifact without a target or archive path.

- [ ] **Step 4: Rename and archive the private legacy repository**

```bash
gh repo rename opc-legacy --repo songgoldenwind-crypto/opc --yes
gh repo archive songgoldenwind-crypto/opc-legacy --yes
```

Do not delete the local dirty directory. Update its remote only after archive verification.

- [ ] **Step 5: Final acceptance**

The goal is complete only when both GitHub repositories have intended names, the canonical worktree is
clean and verified, all active names are Converact, every old name is machine-classified compatibility
or history, production and server state are unchanged, and every required check has passing evidence
or an explicit user-accepted external prerequisite.
