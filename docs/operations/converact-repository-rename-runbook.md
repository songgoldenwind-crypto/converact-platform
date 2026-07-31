# Converact Repository Rename Runbook

## Status

- Operation: completed
- Completed at: `2026-07-31T12:59:52Z`
- Repository node ID: `R_kgDOTUjycw`
- Previous name: `songgoldenwind-crypto/opc-platform`
- Current name: `songgoldenwind-crypto/converact-platform`
- Visibility: private
- Default branch: `main`
- Server or container change: none
- Deployment requested or performed: none

This runbook records a repository identity change only. It is not evidence that the source, package,
image, workflow, or runtime naming migration is complete.

## Preconditions that were verified

The authenticated GitHub account had `repo` and `workflow` scope. Before the operation, the source
repository was private, used `main`, and had node ID `R_kgDOTUjycw`. The target name did not resolve to
an existing repository.

The following repository-owned dependencies were counted without printing values:

| Dependency | Pre-rename count | Post-rename count |
| --- | ---: | ---: |
| Repository webhooks | 0 | 0 |
| Actions secrets | 0 | 0 |
| Actions variables | 0 | 0 |

No workflow referenced a reusable Action through
`uses: songgoldenwind-crypto/opc-platform/...`. Active OCI labels, image identifiers, source
attestations, tests, and documentation that still use the old identity are recorded as pending in
the Converact rename inventory; they are migrated and verified in later bounded tasks.

GitHub documents that ordinary repository links and Git operations redirect after a rename, while
Actions addressed through the old owner/repository string do not. The latter must therefore always
be searched and updated explicitly:

- [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)

## Operation

The repository was renamed with:

```bash
gh repo rename converact-platform \
  --repo songgoldenwind-crypto/opc-platform \
  --yes
```

Post-operation inspection proved that the current repository retained node ID `R_kgDOTUjycw`,
private visibility, the complete Git identity, and `main` as its default branch.

## Local remote migration

Only each independent clone's `origin` metadata was changed. No worktree file, index, branch, commit,
or stash was modified.

| Clone root | Current `origin` | Dry-run fetch |
| --- | --- | --- |
| `/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3` | `https://github.com/songgoldenwind-crypto/converact-platform.git` | passed |
| `/Users/songjinfeng/Desktop/opc/.worktrees/livekit-acceptance` | `https://github.com/songgoldenwind-crypto/converact-platform.git` | passed |
| `/Users/songjinfeng/Desktop/opc/.worktrees/ivekit-v2` | `https://github.com/songgoldenwind-crypto/converact-platform.git` | passed |
| `/Users/songjinfeng/Desktop/opc/.worktrees/ivekit-v3` | `https://github.com/songgoldenwind-crypto/converact-platform.git` | passed |

The isolated Converact rename worktree and frozen production worktree share the first clone's Git
common directory and therefore inherited the same remote metadata update without file changes.

## Redirect and frozen-production verification

Both old and new HTTPS Git URLs resolved `HEAD` to `refs/heads/main` at
`ddddcd50cebd7eb5c07bf307d4c9f96814e8bca0` during the check. This proves the redirect at that point in
time; future verification must query both URLs again rather than inherit this result.

The frozen maintenance branch remained:

```text
refs/heads/maintenance/legacy-production-20260730
  b6a26269ce05570554d25281fb55ba2a16855450
```

The corresponding frozen worktree remained clean with tree
`69dd39f3c26e78d595d528e49c3eb6bc25e16427`. No production file, server release, runtime
configuration, image digest, container, or service was changed.

## Rollback

Rollback is a repository rename back to `opc-platform`, followed by restoring the four independent
clone remotes and rerunning the same repository-ID, redirect, dry-run-fetch, and frozen-tree checks.
Rollback must not rewrite commits or reset a worktree. It is required only if a non-redirecting
consumer cannot be migrated safely; ordinary old Git URLs are not themselves a rollback reason.

## Remaining migration gates

The repository rename does not authorize a deployment. Before this migration is accepted:

1. Active source, packages, workflows, images, charts, documentation, and product presentation must
   use Converact names.
2. Stable wire identifiers and supported legacy environment variables must pass explicit
   compatibility tests.
3. The naming verifier must report `rename=0` and `unclassified=0`.
4. Full local verification must pass and record failures or unexecuted external checks honestly.
5. The frozen production worktree and server must still match their recorded baselines.
