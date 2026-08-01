# Goal 00 Execution Baseline And Traceability Implementation Plan

**Goal:** Freeze one reproducible, machine-readable execution baseline for G00–G17
without modifying either legacy source, the frozen production worktree, product
runtime code, remote branches, or servers.

**Architecture:** Use Git as the source of truth. A generator reads four workspaces,
normalizes repository and file facts, preserves existing requirement identifiers,
adds deterministic supersede mappings, and writes only beneath
`architecture-foundation/execution/goal-00/`. A separate contract test validates
schemas, hashes, links, trace closure, status semantics, and non-mutation snapshots.

**Tech stack:** Node.js ESM, `node:test`, Ajv 2020-12, Git plumbing commands,
SHA-256, JSON Schema, Markdown.

---

## 1. Frozen design choices

### 1.1 Inventory projection

Three approaches were considered:

1. Recursively hash every file including ignored directories. Rejected because it
   would traverse credentials, browser sessions, dependencies, build caches, and
   potentially millions of generated files.
2. Record only repository-level counts. Rejected because it cannot prove file-level
   preservation or support a deterministic migration sequence.
3. Record every Git tracked, staged, unstaged, and untracked path; record ignored
   entries exactly as `git status --ignored=matching` exposes them without reading
   ignored contents. Selected because it is complete for migratable work and safe
   for credentials and generated caches.

Every non-ignored path receives a state, Git/blob or SHA-256 identity, provenance
classification, protection class, target Goal set, and migration disposition.
Unknown authorship is recorded as `unknown_provenance`; commit author names are
not treated as ownership proof.

### 1.2 Requirement normalization

The normalized trace contains:

- all 362 R4 trace rows under their existing IDs;
- all 66 R5 delta rows without duplicating inherited R4 rows;
- Platform R2 level-two sections;
- Resolve R1 W0–W10;
- every current G00–G17 binding Goal as coverage metadata;
- each legacy staged, unstaged, and untracked file as a preservation requirement;
- each tracked `docs/evidence/` artifact as an evidence-preservation row.

Existing IDs remain stable inside a namespaced G00 ID. A row is complete only when
it maps to one or more new Goals or records a reasoned `rejected`, `deferred`, or
`superseded` disposition. The closure must have zero unresolved and duplicate IDs.

### 1.3 Status discipline

`current`, `target`, and `production_eligible` are separate fields. File or
code existence can support `implemented_local` or `partial`, never
`production_eligible`. R4/R5 and upstream statuses are inherited without
promotion. Missing raw evidence remains `not_run`.

## 2. Exact file boundary

Only these G00 paths may be created or changed:

- `architecture-foundation/execution/goal-00/2026-07-31-goal-00-execution-plan.md`
- `architecture-foundation/execution/goal-00/execution-baseline.md`
- `architecture-foundation/execution/goal-00/workspace-inventory-v1.json`
- `architecture-foundation/execution/goal-00/workspace-inventory-v1.schema.json`
- `architecture-foundation/execution/goal-00/requirement-traceability-v1.json`
- `architecture-foundation/execution/goal-00/requirement-traceability-v1.schema.json`
- `architecture-foundation/execution/goal-00/overlap-and-authority-ledger.md`
- `architecture-foundation/execution/goal-00/canonical-execution-root-decision.md`
- `architecture-foundation/execution/goal-00/file-level-migration-sequence.md`
- `architecture-foundation/execution/goal-00/status-and-evidence-registry-v1.json`
- `architecture-foundation/execution/goal-00/status-and-evidence-registry-v1.schema.json`
- `architecture-foundation/execution/goal-00/independent-review.md`
- `architecture-foundation/execution/goal-00/generate-goal-00.mjs`
- `architecture-foundation/execution/goal-00/goal-00-contract.test.mjs`
- `architecture-foundation/execution/goal-00/fixtures/invalid-workspace-inventory.json`
- `architecture-foundation/execution/goal-00/fixtures/invalid-requirement-traceability.json`
- `architecture-foundation/execution/goal-00/fixtures/invalid-status-registry.json`

No manifest status is changed by G00 until all acceptance gates pass; the Goal
execution result is recorded in the G00 artifacts and the thread Goal mechanism.

## 3. Task sequence

### Task 1: Freeze the read-only pre-snapshot

- [ ] Run, for all four roots, `git status --porcelain=v2 --branch`,
  `git rev-parse`, `git rev-list`, `git remote -v`,
  `git submodule status --recursive`, and `git worktree list --porcelain`.
- [ ] Record canonical as the only write root.
- [ ] Record Desktop OPC and ivekit-v3 as read-only legacy sources.
- [ ] Record legacy-production-20260730 as a frozen production boundary.
- [ ] Verify no source command writes files or contacts a runtime service.

Expected pre-snapshot facts:

- canonical branch `codex/converact-platform-rename` is clean;
- Desktop legacy has staged, unstaged, and untracked work;
- ivekit-v3 legacy has unstaged and untracked work;
- frozen production is clean and has unpushed maintenance commits.

### Task 2: Define schemas and observe the RED gate

- [ ] Create the three schemas and invalid fixtures.
- [ ] Create `goal-00-contract.test.mjs` so it compiles each schema, rejects each
  invalid fixture, requires all final artifacts, and checks closure invariants.
- [ ] Run:

  ```bash
  node --test architecture-foundation/execution/goal-00/goal-00-contract.test.mjs
  ```

  Expected result: FAIL because the generated inventory, traceability, registry,
  and required Markdown artifacts do not yet exist. The invalid fixtures must
  already be rejected for the intended schema reason.

### Task 3: Generate the workspace inventory

- [ ] Implement `generate-goal-00.mjs` with read-only Git commands.
- [ ] Snapshot all commits reachable from each workspace HEAD.
- [ ] Snapshot every tracked/staged/unstaged/untracked path and ignored Git entry.
- [ ] Hash non-ignored file bytes, source inputs, status projections, sorted path
  manifests, and sorted requirement IDs with SHA-256. Self-referential G00 outputs
  use null content hashes inside their own inventory and are verified separately.
- [ ] Record unpushed commits, submodules, worktrees, Git storage, and tracked files
  at or above 10 MiB.
- [ ] Capture legacy/frozen status hashes before and after generation and fail if
  any changes.

Run:

```bash
node architecture-foundation/execution/goal-00/generate-goal-00.mjs
```

Expected result: the generator writes only G00 artifacts and reports unchanged
legacy and frozen status hashes.

### Task 4: Close normalized requirement traceability

- [ ] Preserve every R4 trace ID and status.
- [ ] Preserve every R5 delta ID and status.
- [ ] Map Platform R2 sections and Resolve R1 W0–W10.
- [ ] Map each legacy local-change path to at least one new Goal or a reasoned
  deferred/rejected disposition.
- [ ] Map every existing evidence artifact to the Goal that must re-qualify it.
- [ ] Derive G00–G17 Authority, dependencies, inputs, outputs, Evidence and Stop
  Gates from `goals/manifest.json` and each binding Goal file.
- [ ] Require zero duplicate IDs and zero unresolved requirements.

### Task 5: Freeze decisions, overlap, migration and status

- [ ] Write `execution-baseline.md` with replay commands and claim boundaries.
- [ ] Write `canonical-execution-root-decision.md` with the selected root,
  rejected alternatives, rollback, and no-delete rule.
- [ ] Write `overlap-and-authority-ledger.md` covering Authority, interfaces,
  state machines, durable models, SIP/RTP/media, AI, connectors, Engagement,
  Resolution, Collaboration, tests and documents.
- [ ] Write `file-level-migration-sequence.md` from exact legacy change rows.
- [ ] Write the status registry with separate current, target and
  production-eligible fields.

### Task 6: Verify GREEN

- [ ] Run the contract test again and require zero failures.
- [ ] Run Ajv validation for all three generated JSON documents.
- [ ] Recompute every binding/source hash and compare it to the record.
- [ ] Resolve every local Markdown link in G00.
- [ ] Verify sorted requirement counts and ID digest.
- [ ] Verify both legacy sources and frozen production retain their original
  status hashes, branches, and HEADs.
- [ ] Verify `git diff --name-only` contains only G00 paths.
- [ ] Run `git diff --check`.

### Task 7: Independent second-pass review

- [ ] Review the generated files without using generator assumptions as evidence.
- [ ] Compare raw Git commands with the inventory totals.
- [ ] Compare source machine-contract counts with trace closure.
- [ ] Check every Authority domain for a single writer.
- [ ] Check that no existing evidence was promoted to production eligibility.
- [ ] Record reviewer method, findings, resolutions and residual non-claims in
  `independent-review.md`.

No delegated reviewer is used in this task because thread policy forbids spawning
one without explicit user authorization. Independence therefore means a separate
rule-based verifier and a fresh second-pass review, not a claim of human review.

### Task 8: Narrow commit boundary

- [ ] Display the exact changed and staged G00 paths.
- [ ] Display validation commands and unresolved count.
- [ ] Stage exact paths only; never use `git add .` or `git add -A`.
- [ ] Commit as:

  ```text
  docs(program): freeze execution baseline and traceability
  ```

- [ ] Do not push and do not start G01.

## 4. Completion proof

G00 can complete only when:

- all required artifacts exist;
- all schema, hash, link and closure tests pass freshly;
- every legacy requirement is mapped or explicitly rejected/deferred/superseded;
- unresolved and duplicate requirement counts are zero;
- legacy and frozen pre/post status hashes match;
- no product/runtime file changed;
- the independent review has no unresolved Authority, omission or work-protection
  finding;
- only exact G00 files are committed and no remote branch is changed.
