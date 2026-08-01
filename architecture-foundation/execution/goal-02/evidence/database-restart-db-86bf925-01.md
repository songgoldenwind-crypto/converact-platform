# G02 controlled PostgreSQL restart evidence — final-source rerun

## Classification

- Scenario: `database / restart`
- Run ID: `db-86bf925-01`
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
| Source commit | `86bf9255f7be597677bc3fb086e824b50db782eb` |
| Incremental source bundle SHA-256 | `3e7d4312dee483a6af850ee2db2d1b3fb3b9818663f8f0df12e94417a5dce439` |
| Bundle prerequisite | `3108ecf03d850a2c97f88e1507982305b0b522fa` |
| Harness config SHA-256 | `9bafde0ca05604b878cb7c03e36be5a2a99238431e4b48d56c9c7eadf6acb088` |
| Raw-output manifest SHA-256 | `cda01c982c78804ddfd74ae8de29ba1f6e4bb422cfab23103b6958c50122ec1e` |
| Supplemental manifest SHA-256 | `d208fc5070a837c897b1694e556de70930c73deab812dacb4b75b4e822445222` |
| Final evidence JSON SHA-256 | `ba483a6a6560f7a472ea75bc0a6d711f190012efff859b6f5ccfb8c74ef2b032` |
| Execution identity JSON SHA-256 | `8205508328fd608627d33477a2d21b8954c4a25f5cbc17703efa273154f0e257` |
| PostgreSQL image | `postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Node image | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T21:31:57.887Z` |
| Completed | `2026-08-01T21:32:37.083Z` |

The incremental Git bundle declared the previously verified `3108ecf`
checkout as prerequisite and contained the exact source above. Local and remote
bundle SHA-256 matched; `git bundle verify` passed; the validation checkout was
clean. Node and both image identities were verified before execution.
Campaign-only database passwords were generated in memory and were neither
printed nor retained.

## Isolation, fault and cleanup

- Before execution, the server repository was clean and all nine pre-existing
  containers were stopped.
- The campaign used only Compose project `converact-g02-db-86bf925-01`;
  PostgreSQL exposed no host port and used an internal private bridge.
- The same PostgreSQL container start time changed from
  `2026-08-01T21:31:58.173455842Z` to
  `2026-08-01T21:32:07.118363449Z`.
- The measured outage window was `2026-08-01T21:32:05.778Z` through
  `2026-08-01T21:32:07.683Z`.
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
| Fresh-process recovery | PID changed from `3348594` to `3349020` |
| Inbox replay/conflict | Same digest replayed; changed digest rejected |
| Receipt progression | Accepted/completed replayed; state-observed inserted |
| Billing replay/fence | Exact usage replayed; stale writer rejected |
| Append-only | Immutable update rejected |
| Synthetic transport | 1,480 sent; 1,480 received; 0 loss; 0 duplicate |
| Synthetic timing | 20 ms interval; 30,000 ms duration; maximum gap 23.893 ms |
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
`architecture-foundation/execution/goal-02/evidence/raw/database-restart-db-86bf925-01/`.
Both manifests verify from the committed files. The bounded secret scanner
passed all 21 raw artifacts and both supplemental JSON files.

| Artifact | SHA-256 |
| --- | --- |
| `database-outage.json` | `69be3907aa0149a9ebfa2fece5102c857b14dae0f6517a94c7dfcfefef30e4e5` |
| `database-outage.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-prepare.json` | `9d738bc888c0a65f1b0b57bcd7a31ae4bbcfa20e6873210f62a327f325c5191e` |
| `database-prepare.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-recover.json` | `74e59245da2358d7db095c64db9a22460745e7fca04667bc149d455cad9a0e0d` |
| `database-recover.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-restart.json` | `a16a787bc75005ad5d1e3db9b60d3773491affbaf70f8c36d78298ac7a01c1e6` |
| `database-restart.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fault-window.json` | `af8da69614c95f40f423adcdf54158333ff4b650ed77fae5bfa77423604c9c39` |
| `migrations.log` | `74360e5967945b3cef1b739938a79fed6d83117bf117cb6bb53f8ec0993c0a59` |
| `postgres-down.log` | `9d86031d04030c2fa34a633892871002fb8275a31f58bb2474e846419d525c0d` |
| `postgres-start.log` | `5511bda86b597a7db88a83f564a4d245e75ab94fe58a8119ab8871eca5e3b49d` |
| `postgres-stop.log` | `fdbaeaa534cefe385016d69252a36aaabc93f331a58e6d2cd466fe2e0c8eaef7` |
| `postgres-up.log` | `a6185796122363393e65321fad40cb0ee82a83bb233da6b8e3d5c9220e1440aa` |
| `postgres.log` | `565a771a65cf7167cfd180e26ee5a23c29f51da9680362d90225c46ad08bfc24` |
| `runtime-role.log` | `ca588affa2fe110482a7bb3b13ee8bd7f0ca3de6ed594437637918c6c48c499d` |
| `synthetic-media-ready.json` | `3ecf638c023d22cf053bb2aedd98c7d337cbc69527b57db09f80605e8aec18e0` |
| `synthetic-media.json` | `a04d70d4beff82810983bd64242d7ab4eea06b6f8d569208471532dada16ed97` |
| `synthetic-media.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `unrelated-containers-after.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
| `unrelated-containers-before.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
