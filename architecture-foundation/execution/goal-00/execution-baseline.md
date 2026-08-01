# Goal 00 Execution Baseline

Captured at `2026-08-01T08:24:22.792Z`. This is a fact and protection baseline, not a
production-readiness claim.

## Binding identities

- [G00 binding Goal](../../../goals/goal-00-execution-baseline-and-traceability.md): `5f2eb42220067f8c0fe3d454351ace6000b5c3186d2607528bce4ada2c390fbf`
- [Program rules](../../../goals/PROGRAM-RULES.md): `97a1ab64f1deae1cb82072a6a4535e6a4bfbc4a13205c10253c58a399ce4a247`
- [Goal manifest](../../../goals/manifest.json): `28bd84f6e4ce1b74679cc55140a61d5b882474fedcc569e7bfc004270d4d1a55`

## Canonical decision

The only execution root is
`/Users/songjinfeng/Projects/converact-worktrees/platform`. The Desktop OPC and
ivekit-v3 trees are read-only legacy sources. The legacy production worktree is a
frozen production boundary. See the [root decision](./canonical-execution-root-decision.md).

Before G00 created its isolated files, the canonical branch was clean at
`7b3d9cfc3daa95f754a7daf675d86c7bbae68854`; its pre-work status projection was
`847918c55e51fc28a5d4e8f2e3562afea556808fa75e314341e287109b6b158d`.
The machine inventory intentionally captures G00's exact-path local outputs as
generated work and never confuses them with pre-existing user changes.

## Workspace facts

Counts are `tracked/staged/unstaged/untracked/ignored-matching`.

| Workspace | Requested path | Branch | HEAD | Ahead/behind | Counts | >=10 MiB |
| --- | --- | --- | --- | ---: | ---: | ---: |
| canonical | `/Users/songjinfeng/Projects/converact-worktrees/platform` | `codex/converact-platform-rename` | `7b3d9cfc3daa95f754a7daf675d86c7bbae68854` | 0/0 | 3303/0/0/17/21 | 0 |
| legacy_desktop | `/Users/songjinfeng/Desktop/opc` | `audit-and-archive-2026-06` | `896cf2be7ebb6980ea4329d4e3662e6fe7885d3b` | 55/0 | 1195/336/24/515/67 | 0 |
| legacy_ivekit | `/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3` | `codex/ivekit-v5-shared-foundation` | `49c21bd5d95d4959a57231b0cfcd3266c5a4cb3e` | 17/0 | 3222/0/39/5/40 | 0 |
| frozen_production | `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730` | `maintenance/legacy-production-20260730` | `0991dd515a563fab95b3de69b4c2f8276e6105d9` | 4/0 | 2975/0/0/0/3 | 0 |

Full path, commit, worktree, submodule, remote, storage, provenance and hash facts
are in [workspace-inventory-v1.json](./workspace-inventory-v1.json). Ignored entries
were not opened. Remote credentials, if any, are stripped. Self-referential G00
outputs use a null content hash inside their own inventory and are validated by the
separate contract test.

## Requirement closure

- Normalized requirements: 1474
- Mapped: 1436
- Deferred with explicit target/prerequisite: 37
- Superseded with rationale: 1
- Rejected: 0
- Unresolved: 0
- Duplicate IDs: 0

The complete rows and G00-G17 coverage are in
[requirement-traceability-v1.json](./requirement-traceability-v1.json). R5 inherits
the exact 362 R4 rows; the generator does not duplicate them. rvoip's 198 analyzed
capabilities and 14 replacement gates remain individually traceable through R4.

## Status boundary

The [status registry](./status-and-evidence-registry-v1.json) contains
18 Goal-level capabilities. G01-G17 remain
`not_run`; G00 artifacts being present is only `implemented_local`. Production
eligible true count is 0.

## Replay commands

From the canonical root, the read-only collection can be replayed with:

`git status --porcelain=v1 -z --untracked-files=all`,
`git ls-files -z`, `git log --all`, `git worktree list --porcelain`,
`git submodule status --recursive`, `git rev-list --all --count`, and
`git count-objects -vH`.

Regenerate only G00 artifacts with:

`node architecture-foundation/execution/goal-00/generate-goal-00.mjs`

Validate with:

`node --test architecture-foundation/execution/goal-00/goal-00-contract.test.mjs`

## Non-claims

No product code, runtime, server, container, database, feature flag or remote branch
was changed. No old benchmark, mock, loopback or artifact is promoted to the new
production baseline. No migration, delete, cherry-pick, push or G01 execution is
authorized by this document.
