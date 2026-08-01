# G02 controlled PostgreSQL restart evidence

## Classification

- Scenario: `database / restart`
- Run ID: `db-d8cd864-01`
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
| Source commit | `d8cd86458e35b85ea543888ac17c06afee4e0507` |
| Incremental source bundle SHA-256 | `8b873b37f6062f4f60af7f199dfc070bce9780f155f58f8abf6facb76a9b25dc` |
| Harness config SHA-256 | `9bafde0ca05604b878cb7c03e36be5a2a99238431e4b48d56c9c7eadf6acb088` |
| Raw-output manifest SHA-256 | `994a2916a5d61cabf39342a62d025b3bfff638302b2fe2ea5dd072ff66ff5f84` |
| PostgreSQL image | `postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Node image | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T19:42:20.678Z` |
| Completed | `2026-08-01T19:43:00.074Z` |

The exact source was transferred as an incremental Git bundle whose prerequisite
was the server's already verified `4fc7b59b57958a2db0077a91c96bd68ac233f255`
checkout. The bundle was verified, the target was checked out detached and
clean, and the full commit identity was checked before execution. Node 24 was
previously extracted from the pinned Node image and its binary hash was checked
again. Both database passwords were generated in memory for this run and were
neither printed nor written to evidence.

## Isolation and fault

- PostgreSQL had no published host port and remained on the campaign's
  `internal: true` private bridge.
- All nine pre-existing server containers were stopped before the campaign.
- The campaign used only the dedicated Compose project
  `converact-g02-db-d8cd864-01`.
- The actual fault was `docker compose stop --timeout 5 postgres`, followed by
  a failed database query and `docker compose start postgres`.
- The same container restarted from `2026-08-01T19:42:20.969540003Z` to
  `2026-08-01T19:42:30.176737221Z`.
- The measured fault window was `2026-08-01T19:42:28.883Z` through
  `2026-08-01T19:42:30.714Z`.
- Cleanup left zero campaign containers, networks, and volumes. The complete
  unrelated-container snapshots before and after were byte-identical, and no
  container was running after the campaign.

## Observed checks

| Check | Result |
| --- | --- |
| `migration_head` | `112_converact_platform_history_receipt_integrity` |
| Runtime RLS | Tenant A saw 1 own row, 0 Tenant B rows; no-context saw 0 |
| Cross-tenant write | Denied |
| Durable prepare | Inbox, accepted receipt, completed receipt and usage entry inserted |
| Receipt-backed billing | Usage referenced the exact persisted completed receipt, digest, typed source key and derived billing effect ID |
| Actual outage | Query failed while PostgreSQL was stopped |
| Fresh-process recovery | PID changed from `3315125` to `3315542` |
| Inbox replay/conflict | Same digest replayed; changed digest rejected |
| Receipt progression | Accepted and completed receipts replayed; state-observed inserted |
| Billing replay/fence | Exact usage replayed; stale writer rejected |
| Append-only | Immutable update rejected; restrictive tenant history FKs were active |
| Synthetic transport | 1,487 sent; 1,487 received; 0 loss; 0 duplicate |
| Synthetic timing | 20 ms interval; 30,000 ms duration; maximum gap 22.062 ms |
| Fault crossing | Established before, continuous during, completed after recovery |
| Cleanup | 0 campaign resources remained; unrelated containers unchanged |

The acceptance contract returned eight passing checks:
`migration_runtime_rls`, `durable_prepare`, `actual_database_outage`,
`same_container_restart`, `process_restart_reconcile`,
`idempotency_writer_fence`, `append_only_history`, and
`synthetic_transport_and_cleanup`.

## Raw artifact integrity and secret scan

The retained raw directory is
`/home/ubuntu/converact-validation/platform/.runtime/platform-fault-matrix/db-d8cd864-01`
on validation host `101.42.7.139`. Before promotion, the exact-source scanner
read every one of the 21 bounded directory artifacts, rejected binary/symlink/
oversized input and credential-shaped keys or values, then wrote the sorted
manifest. A separate `sha256sum -c raw-output.sha256` verification passed after
cleanup.

| Artifact | SHA-256 |
| --- | --- |
| `database-outage.json` | `69be3907aa0149a9ebfa2fece5102c857b14dae0f6517a94c7dfcfefef30e4e5` |
| `database-outage.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-prepare.json` | `22423a2aaa41f9e0bcf6bee3178e05368bf204667504b9a412c7209ae1b71092` |
| `database-prepare.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-recover.json` | `7b01c933c0021d30e350feb9d4089d8e5fadf37aa5c817116d3aa294da54faba` |
| `database-recover.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `database-restart.json` | `bc81787d9ceb562375e7833ec3d148e54a2670a2f10712d6eef1b5e1688c69ea` |
| `database-restart.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fault-window.json` | `8d4bc179f43d7af1262dd4642ac4ea0068f258185be13a6202c4808a0171deb0` |
| `migrations.log` | `74360e5967945b3cef1b739938a79fed6d83117bf117cb6bb53f8ec0993c0a59` |
| `postgres-down.log` | `35d832ad3434f7dd9c586277acb6b98029ef501f2daa490ff6e482eb1a9a740c` |
| `postgres-start.log` | `f44e8786e3f5e4a39dc6004c3d701937f23d681de4aab2eb2e0288f4471c4f8a` |
| `postgres-stop.log` | `4b9ea2b806bdc5661adbf288e5ed27f0655b3b2b0cd6bb5e37d64550680d3bfe` |
| `postgres-up.log` | `87ed06ddc992c850c121b7b63b47a0d1caed9a937be805b8501c5df7422a54f3` |
| `postgres.log` | `6f62f7930f1445849d4a54105e698fac45fb06b5ce96433296746240c4428580` |
| `runtime-role.log` | `ca588affa2fe110482a7bb3b13ee8bd7f0ca3de6ed594437637918c6c48c499d` |
| `synthetic-media-ready.json` | `e1eec1c9fdc414db05155d8e3f464073a3fbd9a279017762f4a202bf8bd82461` |
| `synthetic-media.json` | `db8a0072570f5f4a04284a076fded365e92111dbcf03c3aebceaec79d7c907ea` |
| `synthetic-media.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `unrelated-containers-after.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
| `unrelated-containers-before.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |

The final controlled evidence JSON SHA-256 is
`8b2bed2be7e086605a97d7a9c397e41655ed9245b24e98449db990bc025dd391`.
