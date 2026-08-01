# G02 controlled PostgreSQL restart evidence

## Classification

- Scenario: `database / restart`
- Run ID: `db-9166ad9-01`
- Status: `verified_controlled`
- `production_eligible`: `false`
- `real_human_media`: `false`
- Media probe: bounded synthetic UDP transport only
- Aggregate G02 dependency matrix: `not_run`

This record accepts one isolated PostgreSQL restart scenario only. It does not
promote the aggregate DB/event/object-store/PKI/KMS/DNS/config/clock/AI/GPU/
recording/provider/observability/node matrix, real long Human Communication,
capacity, restore, drain, region recovery, DR, or production eligibility.

## Exact identity

| Field | Value |
| --- | --- |
| Binding Goal SHA-256 | `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9` |
| Source commit | `9166ad93f626d47b823383677868131fcfb2015f` |
| Base source bundle SHA-256 | `2c8b57990c82eaf1537cac97e4ae1afd639118a0ce05967f28e900c33a035451` |
| Incremental source bundle SHA-256 | `d977b63033d68aac787c657a00e9b540ab759795a457f869992c1f90fef10d13` |
| Harness config SHA-256 | `9bafde0ca05604b878cb7c03e36be5a2a99238431e4b48d56c9c7eadf6acb088` |
| Raw-output manifest SHA-256 | `86be66466e8242903306009f66f97e49f7565715e094d4851705dbcce15c46c1` |
| PostgreSQL image | `postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Node image | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T20:26:44.509Z` |
| Completed | `2026-08-01T20:27:23.827Z` |

The exact source was transferred in two verified Git bundles. The base bundle
ended at `87454294db4af17f054cabda5b7e21dcbf718230`; the incremental bundle
declared that commit as its prerequisite and ended at the source commit above.
The target was checked out detached and clean, and full source identity was
checked before execution. Node 24 was extracted from the pinned Node image and
its binary hash was verified. Both database passwords were generated in memory
for this run and were neither printed nor retained in evidence.

An earlier `db-8745429-01` attempt failed before fault injection with
PostgreSQL `42P18` because advisory-lock parameters lacked explicit SQL types.
That attempt was not promoted. It cleaned up to zero campaign resources and
zero running containers. Commit `9166ad9` added the exact type annotations and
this fresh run exercised the corrected source.

## Isolation and fault

- PostgreSQL had no published host port and remained on the campaign's
  `internal: true` private bridge.
- All nine pre-existing server containers remained stopped.
- The campaign used only the dedicated Compose project
  `converact-g02-db-9166ad9-01`.
- The actual fault was a bounded PostgreSQL stop, a confirmed failed query while
  down, and restart of the same PostgreSQL container.
- The same container start time changed from
  `2026-08-01T20:26:44.951394187Z` to
  `2026-08-01T20:26:53.866425381Z`.
- The measured fault window was `2026-08-01T20:26:52.531Z` through
  `2026-08-01T20:26:54.412Z`.
- Cleanup left zero campaign containers, networks, and volumes. The unrelated
  container snapshots before and after were byte-identical, and no container
  was running after the campaign.

## Observed checks

| Check | Result |
| --- | --- |
| `migration_head` | `112_converact_platform_history_receipt_integrity` |
| Runtime RLS | Tenant A saw 1 own row, 0 Tenant B rows; no-context saw 0 |
| Cross-tenant write | Denied |
| Durable prepare | Inbox, accepted receipt, completed receipt and usage entry inserted |
| Receipt-backed billing | Usage referenced the exact persisted completed receipt, digest, typed source key and derived billing effect ID |
| Actual outage | Query failed while PostgreSQL was stopped |
| Fresh-process recovery | PID changed from `3328885` to `3329313` |
| Inbox replay/conflict | Same digest replayed; changed digest rejected |
| Receipt progression | Accepted and completed receipts replayed; state-observed inserted |
| Billing replay/fence | Exact usage replayed; stale writer rejected |
| Append-only | Immutable update rejected; restrictive tenant history FKs were active |
| Synthetic transport | 1,483 sent; 1,483 received; 0 loss; 0 duplicate |
| Synthetic timing | 20 ms interval; 30,000 ms duration; maximum gap 23.625 ms |
| Fault crossing | Established before, continuous during, completed after recovery |
| Cleanup | 0 campaign resources remained; unrelated containers unchanged |

The acceptance contract returned eight passing checks:
`migration_runtime_rls`, `durable_prepare`, `actual_database_outage`,
`same_container_restart`, `process_restart_reconcile`,
`idempotency_writer_fence`, `append_only_history`, and
`synthetic_transport_and_cleanup`.

## Raw artifact integrity and secret scan

The validation-host source directory was
`/home/ubuntu/converact-validation/platform/.runtime/platform-fault-matrix/db-9166ad9-01`.
An independently reviewable, byte-identical copy of the 21 manifest-bound
artifacts and the original manifest is retained at
`architecture-foundation/execution/goal-02/evidence/raw/database-restart-db-9166ad9-01/`.
The exact-source scanner read every bounded artifact, rejected binary, symlink,
oversized, credential-key and credential-value content, and wrote the sorted
manifest. A second local `sha256sum -c raw-output.sha256`-equivalent
verification passed after transfer.

| Artifact | SHA-256 |
| --- | --- |
| `database-outage.json` | `69be3907aa0149a9ebfa2fece5102c857b14dae0f6517a94c7dfcfefef30e4e5` |
| `database-outage.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-prepare.json` | `d7a3dcc42e36984ad73ce42cee7ebbd533cece54de335c7a9bb8b7dd60fd6874` |
| `database-prepare.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-recover.json` | `ea5ee8ab1213bf31ad5c744b9c4c80b166f93d49f1b27c44ff114608d07cf88f` |
| `database-recover.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-restart.json` | `2a3a9652fbb764f63416a4ccbdf23a8b257422c587c1a7c7755037a080aa1bb3` |
| `database-restart.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fault-window.json` | `2bea7aa58c0829d67ddc884d11759e0b9c71acc0a7551a07a818cbb4466f13a9` |
| `migrations.log` | `74360e5967945b3cef1b739938a79fed6d83117bf117cb6bb53f8ec0993c0a59` |
| `postgres-down.log` | `54fc3e1ebb9148d43079dff6aa4182a1745f62e6b25b7cf018704089f9c7f864` |
| `postgres-start.log` | `086f49d7281fabdb7f2068a7938d817f2574a8e8bb912e3b81f0ca21acd44de5` |
| `postgres-stop.log` | `c8d192844fd8956762f8da04a88470f216fc3e88d64a26d2a1c845ba657e1272` |
| `postgres-up.log` | `fc984f1376e384156e8fbb4a9d7dd108bb57755be53444dc7b7a78a05427d648` |
| `postgres.log` | `db895d8cdc1605faa0fff179daf712ad545ac58853308243d64bd07ca51571fe` |
| `runtime-role.log` | `ca588affa2fe110482a7bb3b13ee8bd7f0ca3de6ed594437637918c6c48c499d` |
| `synthetic-media-ready.json` | `196e4f5065e6d0541680bfaa67847b6925ad4e4b28813b03e6765bd7c15dc001` |
| `synthetic-media.json` | `e495fac55a4aa73cca05bf52061e13bfba75a10061301735dd8ec9c7ffa8f3d4` |
| `synthetic-media.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `unrelated-containers-after.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
| `unrelated-containers-before.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |

The final controlled-evidence JSON SHA-256 was
`a3dd21d3597b75cf261fb48ada52b9d719f22ec927d535c2e2d803f05b581259`;
the separately captured execution-identity JSON SHA-256 was
`d9c67fb419643b1859e01c84db2050c109315308b0221035f09cb9dfa672debe`.
