# G02 controlled backup/restore evidence

## Classification

- Evidence ID: `G02-E10-RESTORE`
- Run ID: `restore-a517cf3-01`
- Status: `verified_controlled`
- `production_eligible`: `false`
- Scope: one frozen checkpoint through the production backup/restore path into a distinct empty target

This proves one controlled single-host restore rehearsal only. It does not prove
continuous-write PITR, cross-region recovery, split-brain handling, production
DR, long Human Communication, SIP/media capacity or the remaining dependency
fault matrix.

## Exact identity

| Field | Value |
| --- | --- |
| Binding Goal SHA-256 | `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9` |
| Source commit | `a517cf368bc25417c0f51870091e3306592b6fc4` |
| Incremental source bundle SHA-256 | `44fd216d5f4261c53f8a1f405cbcdd5727157a38b78fa23525baf828c576c28a` |
| Harness config SHA-256 | `9e3aaf41aa3630615b77615e6c1a2176e1ce4e3d658f4cb983f9e6d835ba5a7d` |
| Raw-output manifest SHA-256 | `b742d246dfdbcd1ee0765f9179d0d474583cfca2404773072f0a0feaf66a2f3a` |
| Supplemental manifest SHA-256 | `ceb69591366383ed4ed50e90d431a45a3a0b0672a94e1fb85610c75a0a75e2c7` |
| Final evidence JSON SHA-256 | `a7a1f657dbb56cc26e7a949d7506897f3ebe58735960451b8a69907f44a19dff` |
| Execution identity JSON SHA-256 | `8d1e05ba452f169755613de6b227180f1a52bf0302223f7fcd8d5b84d08ec667` |
| PostgreSQL image | `postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Node runtime reference | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Executed Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Campaign started / completed | `2026-08-02T00:52:31.378Z` / `2026-08-02T00:52:51.501Z` |

The successful harness preconditions bound execution to the recorded exact
source commit and a clean checkout. The host had no PostgreSQL client
installation, so the acceptance adapter invoked `pg_dump`, `pg_restore` and
`psql` inside the pinned PostgreSQL container while the production TypeScript
backup/restore functions owned manifests, guards, checksums, database sequencing
and object restore.

## Rehearsal lifecycle and result

1. A project-scoped source container ran migrations through
   `112_converact_platform_history_receipt_integrity`, real `opc_runtime` RLS,
   two tenants, one Inbox entry, accepted/completed EffectReceipts, one
   receipt-backed Usage entry and one object.
2. The production backup function produced a PostgreSQL custom archive,
   checksum-bound object manifest and complete marker. The source container,
   network and volume were removed before the target was started.
3. A different target container was created. Its public schema contained zero
   tables before restore.
4. One parent process started a monotonic `performance.now()` boundary, called
   the production restore function, rebuilt the runtime role through the normal
   initializer, launched a distinct child process for verification, and stopped
   the boundary only after that child completed.
5. The child process compared deterministic checkpoint and object digests,
   verified tenant RLS and confirmed the usage history still rejected mutation.
6. The target container, network and volume were removed; no validation Docker
   resource remained.

| Measurement | Result |
| --- | ---: |
| Source / target database IDs distinct | yes |
| Backup / restore / fresh verification process | `3403212` / `3403853` / `3404097` |
| Backup ID before / after | `restore-restore-a517cf3-01` / same |
| Target public tables before restore | 0 |
| Deterministic authority records | 6 / 6 |
| Authority digest before / after | `ccf4fee5b512188b1ff7c4a776ac1e315ed85b16de94970a6be3c7beefe640d7` |
| Objects before / after | 1 / 1 |
| Object digest before / after | `ac24f6e5792644388d4d9e8d4cbd6d36f299192921009cd20dcf7a299ce495d4` |
| Measured RPO | 0 ms |
| Measured monotonic RTO | 5,777 ms |
| RTO scope | restore + runtime-role initialization + fresh-process verification |
| Runtime RLS / append-only verification | passed / passed |
| Validation resources remaining | 0 |

The RTO excludes target-container boot and uses one process-local monotonic
boundary; wall time is used only for evidence timestamps. RPO 0 applies to this
intentionally quiescent checkpoint and must not be generalized to continuous
writes.

The custom archive was 1,599,004 bytes with SHA-256
`7c35bdcda8bebc24dc07c32fd6b7183ba7625d61d09748df42a55a9b202aa3c8`.
Its checksum-bound textual manifest is retained; the binary archive stays
outside Git and this record does not claim independently replayable archive
retention.

## Isolation and retained raw evidence

- All nine pre-existing containers were stopped before the rehearsal and
  remained stopped afterward.
- Before/after snapshots are byte-identical with SHA-256
  `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0`.
- Source and target container, volume and network counts were each zero after
  cleanup; no port was published.
- The raw manifest has 23 entries; the supplemental manifest has 27. Both pass
  `sha256sum -c`.
- The on-host evidence scan and an independent 28-file post-transfer scan
  passed.

Raw textual evidence is retained under
`architecture-foundation/execution/goal-02/evidence/raw/restore-a517cf3-01/`.
Dependency aggregation, drain/node loss, long real media, region recovery and
native-safety gates remain `not_run`.
