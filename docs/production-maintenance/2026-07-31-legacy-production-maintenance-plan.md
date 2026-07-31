# OPC/iveKit Legacy Production Maintenance Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the exact old production source lineage, create an isolated long-lived maintenance worktree and branch in opc-platform.git, and publish the branch without changing the production server.

**Architecture:** Treat Git commits as source facts and a separate release manifest as the multi-image deployment fact. Match the retained server source snapshot against reachable Git trees; use the exact commit when proven, otherwise create an explicitly orphaned reconstruction baseline. Apply the exact deployed media payload as a narrow commit and retain the control-recovery payload as a separately verified component lineage.

**Tech Stack:** Git 2.49 worktrees, SSH read-only source streaming, SHA-256 manifests, Node.js 22 test runner, TypeScript/tsx, JSON release manifests.

---

### Task 1: Create a sterile evidence staging area

**Files:**
- Create: `/Users/songjinfeng/Documents/Codex/2026-07-31/opc-legacy-production-maintenance/work/reconstruction/base-source/`
- Create: `/Users/songjinfeng/Documents/Codex/2026-07-31/opc-legacy-production-maintenance/work/reconstruction/deployed-release/`

- [ ] **Step 1: Confirm all protected worktrees are unchanged before starting**

Run:

```bash
git -C /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3 status --short --branch
git -C /Users/songjinfeng/Desktop/opc status --short --branch
```

Expected: both may be dirty, but their exact status is captured and neither path is used as a write target.

- [ ] **Step 2: Create only the dedicated staging directories**

Run:

```bash
mkdir -p /Users/songjinfeng/Documents/Codex/2026-07-31/opc-legacy-production-maintenance/work/reconstruction/base-source
mkdir -p /Users/songjinfeng/Documents/Codex/2026-07-31/opc-legacy-production-maintenance/work/reconstruction/deployed-release
```

Expected: both directories exist under the maintenance task, outside every Git worktree.

- [ ] **Step 3: Stream the retained base source over SSH without changing the server**

Run a read-only `tar -cf -` on
`/opt/opc-ivekit-goal3/source-im-final8-3f1a7d3ab2f3` and extract it into
`work/reconstruction/base-source`. Do not copy any server secret directory, runtime env file,
container filesystem, database data, or SSH material.

Expected: the local tree is approximately 41 MB and has the same top-level source layout as the retained snapshot.

- [ ] **Step 4: Copy only non-sensitive deployed release evidence**

Copy these exact files from
`/secure/releases/production-media-20260730-d98663222dff`:

```text
evidence/base-payload.sha256
evidence/deployment-contract.sha256
evidence/hotfix-image.txt
evidence/hotfix-payload.sha256
evidence/payload.patch
evidence/release-metadata.env
evidence/restore-point.sha256
hotfix/Dockerfile.opc
hotfix/api-hotfix.override.yml
hotfix/cell-owner.override.yml
hotfix/livekit-owner.override.yml
hotfix/payload.paths
hotfix/runbook.md
hotfix/validate.mjs
```

Copy the three non-secret files under each of:

```text
/secure/releases/cell-admission-terminal-20260730-932282a2a121/hotfix
/secure/releases/control-recovery-20260730-c32e8f369583/hotfix
```

Expected: no `.env`, key, token, cookie, authentication header, restore-point archive, or server secret is copied.

### Task 2: Prove source safety and Git ancestry

**Files:**
- Create: `work/reconstruction/base-source-inventory.sha256`
- Create: `work/reconstruction/source-tree-comparison.txt`

- [ ] **Step 1: Run filename and content secret scans without printing matched values**

Scan for private-key headers, credential/token formats, non-placeholder password assignments,
and sensitive filename extensions. Output only matching file paths and counts.

Expected: no private key, runtime credential, production env file, token, Cookie, or authentication header is eligible for commit. Template files such as `.env.example` and Kubernetes secret templates are reviewed as placeholders before staging.

- [ ] **Step 2: Generate a deterministic source inventory**

Run:

```bash
find work/reconstruction/base-source -type f -print0 |
  LC_ALL=C sort -z |
  xargs -0 shasum -a 256 > work/reconstruction/base-source-inventory.sha256
```

Expected: the manifest contains only file paths and SHA-256 values; it contains no file contents.

- [ ] **Step 3: Compute the snapshot Git tree in a temporary repository**

Initialize a temporary Git repository inside `work/reconstruction/tree-probe`, copy the
snapshot into it mechanically, stage all non-ignored source files, and record `git write-tree`.

Expected: a stable SHA-1 tree ID is produced without writing objects to opc-platform.git.

- [ ] **Step 4: Compare the tree ID with every reachable opc-platform commit**

Compare the probe tree ID against:

```bash
git -C /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3 rev-list --all
```

Expected: exactly one of these outcomes is recorded:

- `exact_commit=<full SHA>` when a reachable commit has the identical tree; or
- `exact_commit=none` and `reconstruction=orphan` when no identical tree exists.

No “nearest” commit is treated as exact.

### Task 3: Create the isolated maintenance worktree and baseline

**Files:**
- Create: `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730/`
- Create branch: `maintenance/legacy-production-20260730`

- [ ] **Step 1: Read and follow the target snapshot AGENTS.md and CLAUDE.md**

Expected: repository-local rules are loaded before creating or editing tracked files.

- [ ] **Step 2: Confirm the target path and branch do not already exist**

Run:

```bash
test ! -e /Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730
! git -C /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3 show-ref --verify --quiet refs/heads/maintenance/legacy-production-20260730
! git -C /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3 show-ref --verify --quiet refs/remotes/origin/maintenance/legacy-production-20260730
```

Expected: all three checks return success.

- [ ] **Step 3: Create the worktree according to the ancestry result**

If Task 2 found an exact commit:

```bash
git -C /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3 worktree add \
  -b maintenance/legacy-production-20260730 \
  /Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730 \
  "$(sed -n 's/^exact_commit=//p' /Users/songjinfeng/Documents/Codex/2026-07-31/opc-legacy-production-maintenance/work/reconstruction/source-tree-comparison.txt)"
```

If Task 2 recorded `reconstruction=orphan`:

```bash
git -C /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3 worktree add \
  --orphan -b maintenance/legacy-production-20260730 \
  /Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730
```

Then copy the verified base snapshot into the empty orphan worktree.

Expected: the new worktree is on only `maintenance/legacy-production-20260730`; existing worktrees retain their original HEAD and status.

- [ ] **Step 4: Commit the reconstructed base only when needed**

For an orphan reconstruction, stage the source tree after the secret scan and run:

```bash
git commit -m "reconstruct: import verified production base snapshot"
```

The commit message body records the full base image ID
`sha256:530e6e3345c0801cfb0ed73b6356b43f78f97344696d12677d567711551484ea`,
server snapshot path, inventory checksum, and the fact that original Git ancestry was not proven.

Expected: the commit contains only verified source files and no release hotfix.

### Task 4: Reconstruct the deployed media hotfix

**Files:**
- Modify: the exact 13 paths listed by `hotfix/payload.paths`
- Create: `docs/production-maintenance/2026-07-31-legacy-production-maintenance-design.md`
- Create: `docs/production-maintenance/2026-07-31-legacy-production-maintenance-plan.md`

- [ ] **Step 1: Verify the base payload before applying the patch**

For every line in `evidence/base-payload.sha256`, verify that an expected file has the recorded
SHA-256 or is explicitly `ABSENT`.

Expected: all 13 base states match. Any mismatch stops the task; the patch is not applied.

- [ ] **Step 2: Check and apply the exact deployed patch**

Run:

```bash
git apply --check work/reconstruction/deployed-release/production-media/evidence/payload.patch
git apply work/reconstruction/deployed-release/production-media/evidence/payload.patch
```

Expected: only the 13 payload paths change.

- [ ] **Step 3: Verify the resulting hotfix payload**

Verify every line in `evidence/hotfix-payload.sha256` and verify:

```text
payload manifest = 835137d340dab140c3b716a268ee262dd8e400eac5bb5ef93e93c47818b56a34
patch SHA-256   = ff66992c068e8a59858369bec146a12e94f9982f1b87235d59a09128966e4068
payload count   = 13
```

Expected: all payload files match the running image labels.

- [ ] **Step 4: Add the approved design and this implementation plan**

Copy the two approved maintenance documents from the task output directory into
`docs/production-maintenance/`. Do not copy runtime access notes or any credential-bearing file.

- [ ] **Step 5: Commit the exact media hotfix**

Commit the 13 payload paths separately from documentation:

```bash
git commit -m "fix(media): retain production hotfix 20260730"
```

Then commit the maintenance documentation:

```bash
git commit -m "docs(ops): record legacy production maintenance line"
```

Expected: the hotfix commit is narrow and auditable; the documentation commit contains no runtime secret.

### Task 5: Record the multi-image deployed release

**Files:**
- Create: `ops/legacy-production/README.md`
- Create: `ops/legacy-production/releases/production-media-20260730-d98663222dff/release-manifest.json`
- Create: `ops/legacy-production/releases/production-media-20260730-d98663222dff/evidence/*.sha256`
- Create: `ops/legacy-production/releases/production-media-20260730-d98663222dff/evidence/payload.patch`

- [ ] **Step 1: Write the release manifest**

The JSON records these proven current facts:

```json
{
  "schemaVersion": 1,
  "releaseId": "production-media-20260730-d98663222dff",
  "status": "current",
  "deploymentVerifiedAt": "2026-07-31T09:19:23Z",
  "components": {
    "opc": {
      "imageTag": "ivekit/opc:production-media-20260730-835137d340da",
      "imageId": "sha256:a7cefdc4fb22c46495fc78d9ee7d89776f7ece28fac6dc41d60146bef788fb0d"
    },
    "cellAdmissionAndLiveKitOwner": {
      "imageTag": "ivekit/opc:production-media-control-recovery-c32e8f369583",
      "imageId": "sha256:f1b388dabe30540fb8d7d9d17a4bff39afb71ec5196b8d497378307146081307"
    },
    "livekit": {
      "imageId": "sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963"
    }
  },
  "temporaryExceptions": {
    "nonMtlsRecordedExpiry": "2026-08-02T10:06:34.133Z",
    "enforcement": "unknown",
    "alert": "unknown"
  },
  "browserAcceptance": "not_run_after_recovery"
}
```

The final manifest also lists Compose override paths, payload checksums, rollback artifact checksum,
database migration evidence status, and explicit unknown/not_run fields. It contains no credential.

- [ ] **Step 2: Retain only safe release evidence**

Copy checksum manifests and `payload.patch` into the release directory. Reference encrypted restore
material by server path and SHA-256; do not commit the encrypted archive itself.

Expected: `git grep` finds no server runtime env values, credentials, private keys, tokens, Cookies,
authentication headers, or raw idempotency keys.

- [ ] **Step 3: Record control-recovery as a separate component lineage**

Record the 2-file control payload hashes and base image ID in the release manifest. Do not apply those
files to the main OPC branch until their exact base tree is proven. Mark its source reconstruction as
`pending_provenance` rather than guessing a commit.

- [ ] **Step 4: Commit release evidence**

Run:

```bash
git add ops/legacy-production
git commit -m "docs(release): bind deployed legacy production facts"
```

Expected: the commit changes only `ops/legacy-production/`.

### Task 6: Run local verification

**Files:**
- Verify: all reconstructed source, media payload and release evidence

- [ ] **Step 1: Install dependencies without rewriting the lockfile**

Run:

```bash
npm ci --ignore-scripts
```

Expected: install succeeds and `git status --short` shows no tracked dependency changes.

- [ ] **Step 2: Run the focused production hotfix tests**

Run:

```bash
node --import tsx --test --test-concurrency=1 \
  test/production-media-hotfix-20260730.test.ts \
  test/production-media-hotfix-deployment-contract.test.ts \
  test/production-media-hotfix-migration-guard.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run focused placement and LiveKit tests**

Run:

```bash
node --import tsx --test --test-concurrency=1 \
  test/ivekit-cell-admission-ledger.test.ts \
  test/ivekit-component-node-admission.test.ts \
  test/ivekit-media-call-placement.test.ts \
  test/livekit-deployment-preflight.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 4: Verify repository cleanliness and isolation**

Run:

```bash
git status --short --branch
git diff --check
git log --oneline --decorate -5
git -C /Users/songjinfeng/Projects/opc-worktrees/ivekit-v3 status --short --branch
git -C /Users/songjinfeng/Desktop/opc status --short --branch
```

Expected: the maintenance worktree is clean; protected worktree statuses match Task 1.

### Task 7: Publish the maintenance branch without deploying

**Files:**
- Update remote ref: `origin/maintenance/legacy-production-20260730`

- [ ] **Step 1: Re-run the secret and release-evidence scans**

Expected: zero credential-bearing tracked files and zero unresolved manifest contradictions.

- [ ] **Step 2: Push only the named maintenance branch**

Run:

```bash
git push --set-upstream origin maintenance/legacy-production-20260730
```

Expected: the remote branch is created; no tag, release, image, workflow dispatch or deployment is created.

- [ ] **Step 3: Verify the remote ref**

Run:

```bash
git ls-remote --heads origin refs/heads/maintenance/legacy-production-20260730
```

Expected: the remote SHA equals local HEAD.

- [ ] **Step 4: Report the exact boundary**

Report the branch, worktree, baseline provenance outcome, commit SHAs, verification results and remaining
`pending_provenance` items. Explicitly state that the production server was not modified.
