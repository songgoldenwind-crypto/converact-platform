# AI outbound R1 durable Tool runtime evidence

> Recorded: 2026-09-01
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the first complete local Rust control path from an immutable Agent Release Tool
manifest to an authorized, durable and replay-safe Tool result returned to the exact Active Call
session. The verified source checkpoint is Converact commit
`bbbd6a3b6c98c1356d56029175c12dcf61aca7b6`.

## Observed scope

- Agent publication accepts one bounded Tool manifest and rejects a digest that differs from the
  Agent Release `tool_schema_hash` before invoking the persistence port;
- PostgreSQL validates every registered Tool schema and writes the Agent Release plus its immutable
  Tool manifest in one tenant transaction;
- runtime authority resolves only the exact tenant, Agent Release, Tool name and revision frozen by
  that manifest;
- the worker composes the Release authority, schema validator, Tool Broker, durable Tool Action
  store, PostgreSQL business provider and exact Active Call result port;
- `customer.lookup` and idempotent `task.create_follow_up` execute through typed Rust adapters;
- ambiguous mutation outcomes reconcile by the same Tool call id and do not repeat the mutation;
- the runtime role has only `SELECT, INSERT` permission for immutable Tool manifests; update and
  delete remain prohibited by the database guard.

## Fresh verification

The exact command ledger is [verification.json](./verification.json). Fresh scoped results were:

- PostgreSQL manifest/schema/atomic-authoring contract tests: 9 passed, 0 failed;
- physical PostgreSQL test target: compiled, execution not run;
- worker HTTP/runtime/composition tests: 17 passed, 0 failed;
- worker binary check: passed;
- scoped PostgreSQL and worker Clippy with warnings denied: passed.

## Explicitly not run

- physical PostgreSQL integration and migrations against a running database;
- real Active Call process and pinned-source wire exchange;
- real RustPBX originate, SIP/PSTN, RTP/SRTP or media call;
- real external CRM/task provider, credentials, quotas and network failure behavior;
- real ASR, model and TTS providers;
- deployed runtime, browser flow, performance, capacity, long-run and fault campaign;
- independent code review and production deployment.

No local Docker was used. No server service, container or deployed source was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
