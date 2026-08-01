# G02 controlled PostgreSQL restart evidence — final-source rerun

## Classification

- Scenario: `database / restart`
- Run ID: `db-4f9ea6f-01`
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
| Source commit | `4f9ea6f94a8e0740975c801aff5a6a180124a62b` |
| Incremental source bundle SHA-256 | `383719938e86665993cb9d42fe27c7eb259f91408ff4b2119e600a28bcd57384` |
| Bundle prerequisite | `86bf9255f7be597677bc3fb086e824b50db782eb` |
| Harness config SHA-256 | `9bafde0ca05604b878cb7c03e36be5a2a99238431e4b48d56c9c7eadf6acb088` |
| Raw-output manifest SHA-256 | `c095c7a7c026cfd0b87e432f2037ccd6414368431dc607d652716f856442ea98` |
| Supplemental manifest SHA-256 | `d723d44bfbb110926c24334266a1956f31ea28661a51e05c2a4ca4e74ca43bea` |
| Final evidence JSON SHA-256 | `884b29f45f29254ff4ecfb3fb432b4c8a7752d246615a85fe52e863e84a4544e` |
| Execution identity JSON SHA-256 | `2acd3b6ce27440a88c3491f68b43fc6d6c6455e877c26b76e31e859c484103c5` |
| PostgreSQL image | `postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Node image | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T21:56:56.323Z` |
| Completed | `2026-08-01T21:57:35.504Z` |

The incremental Git bundle declared the previously verified `86bf925`
checkout as prerequisite and contained the exact source above. Local and remote
bundle SHA-256 matched; `git bundle verify` passed; the validation checkout was
clean. Node and both image identities were verified before execution.
Campaign-only database passwords were generated in memory and were neither
printed nor retained.

## Isolation, fault and cleanup

- Before execution, the server repository was clean and all nine pre-existing
  containers were stopped.
- The campaign used only Compose project `converact-g02-db-4f9ea6f-01`;
  PostgreSQL exposed no host port and used an internal private bridge.
- The same PostgreSQL container start time changed from
  `2026-08-01T21:56:56.618135944Z` to
  `2026-08-01T21:57:05.534710386Z`.
- The measured outage window was `2026-08-01T21:57:04.181Z` through
  `2026-08-01T21:57:06.082Z`.
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
| Fresh-process recovery | PID changed from `3356314` to `3356742` |
| Inbox replay/conflict | Same digest replayed; changed digest rejected |
| Receipt progression | Accepted/completed replayed; state-observed inserted |
| Billing replay/fence | Exact usage replayed; stale writer rejected |
| Append-only | Immutable update rejected |
| Synthetic transport | 1,484 sent; 1,484 received; 0 loss; 0 duplicate |
| Synthetic timing | 20 ms interval; 30,000 ms duration; maximum gap 22.729 ms |
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
`architecture-foundation/execution/goal-02/evidence/raw/database-restart-db-4f9ea6f-01/`.
Both manifests verify from the committed files. The bounded secret scanner
passed all 21 raw artifacts and both supplemental JSON files.

| Artifact | SHA-256 |
| --- | --- |
| `database-outage.json` | `69be3907aa0149a9ebfa2fece5102c857b14dae0f6517a94c7dfcfefef30e4e5` |
| `database-outage.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-prepare.json` | `8e4da866e75f6e8cdca5e648e87794d3d762e61ec0933cea5d9b7d378cedd31b` |
| `database-prepare.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-recover.json` | `6118d4523ee263e53b234c85410629e13cd42e668ae419e64605beef2dc2fcc2` |
| `database-recover.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-restart.json` | `8fbc447481e7191eb2744ec7711a8e6de4b6ca9aa2505c6620c3ce247f8495ed` |
| `database-restart.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fault-window.json` | `4fbc9d44a7c71c5cbc926144dd341f0faa0ef2fce8306d69ec8829df5c398dc8` |
| `migrations.log` | `74360e5967945b3cef1b739938a79fed6d83117bf117cb6bb53f8ec0993c0a59` |
| `postgres-down.log` | `40b7a538d0b92e7a9276b5b5334d1c5804926d8f7f1c640f647049a575f814d6` |
| `postgres-start.log` | `08d10b5f232b20fe0c279131ca27fcf39087b10f90f41ddb61f75e4179c7da8e` |
| `postgres-stop.log` | `cb1f6a5b457ffac8995ea64806bdb2d1e7c5ab77df2a8e9f43127127cd14d5b8` |
| `postgres-up.log` | `96574abc6d7383cf03bfed68863f96ff64f8708c2f8735eb51a9fa9c061212c9` |
| `postgres.log` | `67127d19fd5af8a701810acfa9dfa90a51f73780585d748bd5e37b250f76ff70` |
| `runtime-role.log` | `ca588affa2fe110482a7bb3b13ee8bd7f0ca3de6ed594437637918c6c48c499d` |
| `synthetic-media-ready.json` | `33eb8e61998cfb17994524cb70c6e3d352df2e0dbfd01176a3a694f992bcc652` |
| `synthetic-media.json` | `53a0111938c291d7b9f0c87e27e17033fac5c14afabc7ac27f4094a2995975e8` |
| `synthetic-media.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `unrelated-containers-after.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
| `unrelated-containers-before.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
