# Converact rename completion audit — 2026-07-31

## Conclusion

The active platform rename is complete and locally verified at commit
`a3e9e5a18bc08156e3c25d59e94cc95c19bec676` on
`codex/converact-platform-rename`.

Converact is now the authoritative public product, repository, package,
configuration, documentation, and active source identity. The verifier reports:

- `rename = 0`
- `unclassified = 0`
- `compatibility = 13645`
- `historical = 6791`
- `external = 0`

The remaining OPC/iveKit spellings are classified compatibility or historical
artifacts. Frozen wire/API/schema/database/event/idempotency/metrics/evidence/source/
patch/release identifiers were not silently renamed.

## Repository identity

| Item | Verified value |
| --- | --- |
| Repository | `songgoldenwind-crypto/converact-platform` |
| Visibility | private |
| Default branch | `main` |
| Origin | `https://github.com/songgoldenwind-crypto/converact-platform.git` |
| Legacy product URL | `songgoldenwind-crypto/opc-platform` resolves to the renamed repository |
| Rename branch | `codex/converact-platform-rename` |
| Subject commit | `a3e9e5a18bc08156e3c25d59e94cc95c19bec676` |

The separate `songgoldenwind-crypto/opc` repository is not the product repository
renamed by this change and was not modified.

## Verification

The authoritative machine-readable record is
`docs/evidence/converact-rename-local-verification-2026-07-31.json`.

Key results:

- full Node suite: 4,790 tests; 4,775 passed; 0 failed; 15 skipped;
- post-commit naming and frozen-contract gate: 18/18 passed;
- TypeScript typecheck passed;
- frontend, agent panel, reference client, SDK, and generated standalone context
  builds passed;
- Python AI-agent suite: 75/75 passed;
- Go provider gateway, component hook, LiveKit owner, LiveKit Egress, and Tinode
  owner suites passed;
- Rust component hook and voice-media suites passed with the two explicitly
  ignored gates below;
- checksum-verified Helm v3.18.4 lint passed for all three charts;
- staged and working-tree whitespace checks passed.

Each local raw log is bound by SHA-256 in the machine-readable evidence. The raw
logs are local execution artifacts under `/private/tmp`; their hashes, commands,
outcomes, and non-claims are the durable audit record.

## Explicit non-claims

The following remain `not_run`:

- production/server/container/database deployment;
- local Docker or Compose CLI execution;
- real-environment media and capacity acceptance;
- SDK registry publication;
- official G.729 ITU reference-vector verification;
- the ignored voice-media 100K bounded-state stress gate;
- archival of the old local OPC workspace.

The direct `services/converact-service` build command is `not_applicable`, not a
failure: that directory is a source-generation template and intentionally has no
`src` directory. Its supported generated-context verifier passed with 424 source
files and 17 Converact entrypoints.

## Frozen production boundary

`/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730` remains
clean at `0991dd515a563fab95b3de69b4c2f8276e6105d9` on
`maintenance/legacy-production-20260730`. This rename task did not change that
worktree, any server, or any running container.

The legacy local OPC workspace is intentionally not archived yet. Goal 00 requires
a full file-level ledger for every staged, unstaged, and untracked artifact before
that externally destructive step can be considered safe.
