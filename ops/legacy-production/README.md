# Legacy production maintenance

This directory records the deployment facts for the old production line. Git commits represent source state; release manifests represent the actual multi-image, multi-Compose deployment.

## Boundaries

- The maintenance branch is `maintenance/legacy-production-20260730`.
- The isolated worktree is `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730`.
- Do not merge this branch into ivekit-v3 or any G00-G17 architecture branch.
- Do not deploy new-architecture code or migrations to the legacy server.
- Do not store passwords, keys, tokens, Cookies, authentication headers, raw idempotency keys, or runtime environment values here.
- A branch push never authorizes a build, migration, restart, configuration change, or deployment.

## Source lineage

The retained production base had no exact tree match among the reachable Git commits at reconstruction time. Commit `011de6f11a39aed14633e22f3ee5988dddc59038` is therefore an explicit orphan reconstruction and does not claim original Git ancestry.

Commit `f4027853eb45addab284928f4e1541f6dac3d1ff` applies the exact 13-file production media patch. The Cell/LiveKit control-recovery image uses another base image and remains a separately recorded component lineage until its source ancestry is proven.

## Workflow

1. Establish the current release, image IDs, Compose files, configuration fingerprints, migration state, rollback point, and exception expiry using read-only checks.
2. Reproduce the fault and add a focused regression test in this worktree.
3. Make one minimal, reversible commit without unrelated refactors or upgrades.
4. Build a candidate release and verify its checksums and base-only rollback locally.
5. Obtain separate authorization for push, production build, migration, configuration change, restart, or deployment as applicable.
6. Freeze and observe after deployment. Collect redacted evidence before rollback or another fix.
