# G02 controlled PostgreSQL restart evidence

## Classification

- Scenario: `database / restart`
- Run ID: `db-4fc7b59-01`
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
| Source commit | `4fc7b59b57958a2db0077a91c96bd68ac233f255` |
| Incremental source bundle SHA-256 | `e6b1b1a94fd7b05c13d248d4f7d39dfb61d2a381554d7a5282e9ce14ea2c3de2` |
| Harness config SHA-256 | `26bb9a35d6c66792fffaff3313f12cf0ee71df8572297497b1d95552f52887f9` |
| Raw-output manifest SHA-256 | `5820c5b917fb21a5e89011475944631cdea2727f7f6a7bcb31012a9c0f278210` |
| PostgreSQL image | `postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Node image | `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T18:23:23.943Z` |
| Completed | `2026-08-01T18:24:03.287Z` |

The exact source was transferred as a Git bundle and checked out detached and
clean. Node 24 was extracted from the pinned Node image and its binary hash was
recorded. Both database passwords were generated in memory for this run and
were neither printed nor written to evidence.

## Isolation and fault

- PostgreSQL had no published host port and remained on the Compose
  `internal: true` private bridge.
- The validation process resolved the private container address only for the
  campaign lifecycle.
- The actual fault was `docker compose stop --timeout 5 postgres`, followed
  by a failed database query and `docker compose start postgres`.
- The same container restarted from `2026-08-01T18:23:24.224241064Z` to
  `2026-08-01T18:23:33.322747133Z`.
- The measured fault window was `2026-08-01T18:23:32.021Z` through
  `2026-08-01T18:23:33.878Z`.

## Observed checks

| Check | Result |
| --- | --- |
| Migrations | Through `111_converact_platform_key_lifecycle` |
| Runtime RLS | Tenant A saw 1 own row, 0 Tenant B rows; no-context saw 0 |
| Cross-tenant write | Denied |
| Durable prepare | Inbox, accepted EffectReceipt and usage entry inserted |
| Actual outage | Query failed while PostgreSQL was stopped |
| Fresh-process recovery | PID changed from `3294869` to `3295292` |
| Inbox replay/conflict | Same digest replayed; changed digest rejected |
| Receipt progression | accepted replayed; completed and state-observed inserted |
| Billing replay/fence | usage replayed; stale writer rejected |
| Append-only | immutable update rejected |
| Synthetic transport | 1,485 sent; 1,485 received; 0 loss; 0 duplicate |
| Synthetic timing | 20 ms interval; 30,000 ms duration; maximum gap 24.074 ms |
| Fault crossing | established before, continuous during, completed after recovery |
| Cleanup | 0 campaign resources remained |
| Unrelated containers | Before/after snapshots byte-identical |

The acceptance contract returned eight passing checks:
`migration_runtime_rls`, `durable_prepare`, `actual_database_outage`,
`same_container_restart`, `process_restart_reconcile`,
`idempotency_writer_fence`, `append_only_history`, and
`synthetic_transport_and_cleanup`.

## Raw artifact integrity

The retained raw directory is
`/home/ubuntu/converact-validation/platform/.runtime/platform-fault-matrix/db-4fc7b59-01`
on validation host `101.42.7.139`. Post-run `sha256sum -c
raw-output.sha256` passed for every listed artifact:

| Artifact | SHA-256 |
| --- | --- |
| `unrelated-containers-before.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
| `unrelated-containers-after.tsv` | `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0` |
| `database-prepare.json` | `76287ef2dd17e51198bb3ee140c09f6360dd13d9ec68801a8f110bb71d4121a9` |
| `database-outage.json` | `69be3907aa0149a9ebfa2fece5102c857b14dae0f6517a94c7dfcfefef30e4e5` |
| `database-restart.json` | `ee3127f1b5f1f5795c2becd4cba24606bda15da75966e69c0233ad8d6b27c431` |
| `database-recover.json` | `9b6859b933eec03e03b6cf33ad22eb90eaba7026a6667bd3a4ecdcabc9d59c7d` |
| `synthetic-media.json` | `15b71aae4fdfd0f1d49bec27e1e111cb64c25c901fbcd67c12dd5e02abeeddb8` |
| `fault-window.json` | `49489d4b7980703ea955363eb350fab0929b7cb07d1eb433fe53db3357645709` |
| `runtime-role.log` | `ca588affa2fe110482a7bb3b13ee8bd7f0ca3de6ed594437637918c6c48c499d` |
| `migrations.log` | `74360e5967945b3cef1b739938a79fed6d83117bf117cb6bb53f8ec0993c0a59` |
| `postgres.log` | `151c79a9c1143dd3a7c900f6c817c0ba4a15053672ff3301e7e5009d3a9a11cd` |

The final evidence JSON and all JSON artifacts were also checked for
secret-shaped keys. The failed diagnostic runs `db-b22dcf2-01` and
`db-468ee27-01` remain failed diagnostics and are not accepted evidence.
