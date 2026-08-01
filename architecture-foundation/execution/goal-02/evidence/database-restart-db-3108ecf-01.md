# G02 controlled PostgreSQL restart evidence — final-source rerun

## Classification

- Scenario: `database / restart`
- Run ID: `db-3108ecf-01`
- Status: `verified_controlled`
- `production_eligible`: `false`
- `real_human_media`: `false`
- Media probe: bounded synthetic UDP transport only
- Aggregate G02 dependency matrix: `not_run`

This record accepts one exact-source PostgreSQL restart scenario only. It does
not promote the aggregate DB/event/object-store/PKI/KMS/DNS/config/clock/AI/GPU/
recording/provider/observability/node matrix, real long Human Communication,
capacity, restore, drain, region recovery, DR, or production eligibility.

## Exact identity

| Field | Value |
| --- | --- |
| Binding Goal SHA-256 | `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9` |
| Source commit | `3108ecf03d850a2c97f88e1507982305b0b522fa` |
| Incremental source bundle SHA-256 | `70f598ce98b3c4a4bcf9c72c662200e073c8a2426c9df5671382a86215fc87b0` |
| Bundle prerequisite | `9166ad93f626d47b823383677868131fcfb2015f` |
| Harness config SHA-256 | `9bafde0ca05604b878cb7c03e36be5a2a99238431e4b48d56c9c7eadf6acb088` |
| Raw-output manifest SHA-256 | `3126db0ecf3f6b29196b082423bacdb09486a97a9b2940d296586a5861809055` |
| Supplemental manifest SHA-256 | `c0ddccfa86a6e6233b09f2d571e9d985a71af1df8d829cdf1ea76c451e883c3d` |
| Final evidence JSON SHA-256 | `cebebbcdee00995c1e6de56adcf2a5b74d5974ddadb987cfc70e0aaf9a26635f` |
| Execution identity JSON SHA-256 | `d19e2f5b76ab5e0a9b4ee680d2e4f2e9ce7338b1e9ba9730ee47ea810bae758b` |
| PostgreSQL image | `postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Node image | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T21:08:18.950Z` |
| Completed | `2026-08-01T21:08:58.065Z` |

The incremental Git bundle declared the previously verified `9166ad9`
checkout as prerequisite and contained the exact source above. Local and remote
bundle SHA-256 matched; `git bundle verify` passed; the detached validation
checkout was clean. Node and both image identities were verified before
execution. Campaign-only database passwords were generated in memory and were
neither printed nor retained.

## Isolation, fault and cleanup

- Before execution, the server repository was clean and all nine pre-existing
  containers were stopped.
- The campaign used only Compose project `converact-g02-db-3108ecf-01`;
  PostgreSQL exposed no host port and used an internal private bridge.
- The same PostgreSQL container start time changed from
  `2026-08-01T21:08:19.232048277Z` to
  `2026-08-01T21:08:28.117370564Z`.
- The measured outage window was `2026-08-01T21:08:26.777Z` through
  `2026-08-01T21:08:28.675Z`.
- Cleanup left zero campaign containers, networks and volumes; zero containers
  were running; the unrelated before/after snapshots were byte-identical; the
  validation repository remained clean.

## Observed checks

| Check | Result |
| --- | --- |
| `migration_head` | `112_converact_platform_history_receipt_integrity` |
| Runtime RLS | Tenant A saw 1 own row, 0 Tenant B rows; no-context saw 0 |
| Cross-tenant write | Denied |
| Durable prepare | Inbox, accepted receipt, completed receipt and usage entry inserted |
| Receipt-backed billing | Usage referenced the exact completed receipt and billing effect |
| Actual outage | Query failed while PostgreSQL was stopped |
| Fresh-process recovery | PID changed from `3340943` to `3341365` |
| Inbox replay/conflict | Same digest replayed; changed digest rejected |
| Receipt progression | Accepted/completed replayed; state-observed inserted |
| Billing replay/fence | Exact usage replayed; stale writer rejected |
| Append-only | Immutable update rejected |
| Synthetic transport | 1,483 sent; 1,483 received; 0 loss; 0 duplicate |
| Synthetic timing | 20 ms interval; 30,000 ms duration; maximum gap 23.52 ms |
| Fault crossing | Established before, continuous during, completed after recovery |
| Cleanup | 0 campaign resources; unrelated containers unchanged |

All eight acceptance checks passed: `migration_runtime_rls`,
`durable_prepare`, `actual_database_outage`, `same_container_restart`,
`process_restart_reconcile`, `idempotency_writer_fence`,
`append_only_history`, and `synthetic_transport_and_cleanup`.

## Retained raw evidence

The repository retains the byte-identical 21 manifest-bound artifacts, original
manifest, final evidence JSON, execution identity JSON and supplemental
manifest under
`architecture-foundation/execution/goal-02/evidence/raw/database-restart-db-3108ecf-01/`.
Both manifests verify from the committed files. The bounded secret scanner
passed all 21 raw artifacts and both supplemental JSON files.

| Artifact | SHA-256 |
| --- | --- |
| `database-outage.json` | `69be3907aa0149a9ebfa2fece5102c857b14dae0f6517a94c7dfcfefef30e4e5` |
| `database-outage.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-prepare.json` | `ea55d280af32ea61164811afefc735540c1bbac99fbfcbd4d030e10ab0740eee` |
| `database-prepare.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-recover.json` | `ccfc72c2f2597a6111581c5b024dfd082a001e9d2301cfa6158a1399b3829acf` |
| `database-recover.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-restart.json` | `4c0901ed08255235a75933e5c5bd1f185df65933743b5958b5232ef87cca3fc8` |
| `database-restart.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fault-window.json` | `ff0f29a476c3b26dced50b4e4e08dea78f3442c42b485c5cc4d400946a1a6660` |
| `migrations.log` | `74360e5967945b3cef1b739938a79fed6d83117bf117cb6bb53f8ec0993c0a59` |
| `postgres-down.log` | `7564d6e87a43dbd0f358445afe9d42c85912fd6c47643c40cbf1b6c28a2abd10` |
| `postgres-start.log` | `0fe33c16f4e700a5dbba40661201e36c78cb860f47e19e223bb2631cd7365cb5` |
| `postgres-stop.log` | `fbe6ef04751298e044fcb6535b65e258e9d9f6badf439bb1e86faed5f9cae5a9` |
| `postgres-up.log` | `3eeac3060820e049a0c430a2d0e7e0a695dad2cc4990c9e2645becc20994d557` |
| `postgres.log` | `28a37ac0f9ab26865d6b9b0f8e183be7b09f5f6d4ac50fa18a472b071b4a8285` |
| `runtime-role.log` | `ca588affa2fe110482a7bb3b13ee8bd7f0ca3de6ed594437637918c6c48c499d` |
| `synthetic-media-ready.json` | `e3637068576d90bcadf2cd48fe04894c017921e9476299a4a5c74515d68a0bd9` |
| `synthetic-media.json` | `03d4dffcaddfdbe77328129666d2d85e99a2e3b3cca188648185af33592e6cd7` |
| `synthetic-media.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `unrelated-containers-after.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
| `unrelated-containers-before.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
