# Rust Runtime Migration Program Rules

These rules are additive to `goals/PROGRAM-RULES.md`. The stricter rule wins.

1. The canonical repository is
   `/Users/songjinfeng/Projects/converact-worktrees/platform` on the existing
   branch. Preserve all existing commits and all user dirty/untracked work.
2. Never reset, rebase, clean, discard, use `git add .` or `git add -A`, stage
   unrelated changes or push without explicit user authorization.
3. The historical dirty
   `architecture-foundation/execution/goal-03/evidence/raw/host-campaign-e4f8dd4-01/README.md`
   remains untouched and unstaged.
4. Running servers, containers, deployments, ports, databases and data are
   outside RM01. Local Docker and performance/load campaigns are forbidden.
5. Every new Converact-owned online server runtime behavior is Rust-first.
   TypeScript, Python and self-owned Go exceptions require an exact category in
   the migration contract and a deletion or model-executor boundary.
6. Migration is by vertical Authority slice. Durable dual-write, two active
   writers or a second business Authority are forbidden.
7. Every production behavior begins with a failing test, uses bounded work and
   ends with focused plus affected-suite verification and a narrow commit.
8. No legacy runtime is deleted until new-work routing, drain,
   query/reconcile, active-zero and rollback-window gates are evidenced.
9. Current, target and production eligibility stay distinct. Anything not
   directly proved remains `not_run`.
10. RM01 does not automatically start G04 or any other Goal.
