# Canonical Execution Root Decision

## Decision

`/Users/songjinfeng/Projects/converact-worktrees/platform` is the sole execution
root for G00-G17. It is on `codex/converact-platform-rename` at baseline HEAD
`7b3d9cfc3daa95f754a7daf675d86c7bbae68854` and points to the sanitized Converact remote
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

- `/Users/songjinfeng/Desktop/opc`: rejected as an execution root because it is a
  dirty legacy source and a different repository identity.
- `/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3`: rejected because it is the
  dirty communication history source, not the renamed program root.
- `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730`: rejected
  because it is a frozen production boundary.
- Any old `converact` or `converact-v3` directory: rejected because the binding
  Goal names one canonical path and G00 found no reason to override it.

## Rollback and preservation

G00 performs no code migration. A future Goal may copy or absorb one audited file or
commit only after its Authority and tests are known. Rollback means removing only
that future Goal's new canonical commit or disabling its new-session rollout while
old sessions drain; it never means resetting, cleaning or editing a legacy source.
Legacy paths remain preserved until an explicit target Goal proves migration,
reconciles active state to zero and separately authorizes deletion.

## Change boundary

Only files beneath `architecture-foundation/execution/goal-00/` may differ in G00.
No push and no G01 start are part of this decision.
