# AI outbound R1 Tool Action evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the first bounded Rust Tool Proposal → Policy/Approval → durable
prepare/execute/finalize → Action Receipt path at Converact commit
`91e8b5558faf61903beb7bee6f05ee29fb4928d8`. It does not prove a real Provider,
external approval service, physical PostgreSQL database, Active Call process, SIP/PSTN call,
performance, capacity or production deployment.

## Observed scope

- bounded canonical Tool Proposal arguments, digest and deadline validation;
- immutable Tool Revision, Schema, effect class, risk and registered Rust capability binding;
- high-risk mutation cannot be downgraded by an `Allowed` Policy response and cannot execute
  without an exact, live, non-revoked Approval;
- Store is the sole execute-permission authority: first execution order is
  `prepare -> execute -> finalize`, while exact replay never executes again;
- ambiguous Action outcome remains pending and subsequent work calls provider `query`, never a
  second `execute`;
- old-generation final evidence is `Historical` and cannot drive the current Agent;
- additive PostgreSQL/SQLite schemas contain tenant keys, Proposal/Approval evidence,
  accepted/completed/state-observed receipts, leases, RLS and bounded claim indexes;
- the PostgreSQL runtime wrapper owns tenant transactions; upper layers receive no raw SQL,
  transaction or credential capability;
- normalized Active Call `functionCall` maps through an Agent Release Tool binding into the
  Broker; only a current, exact `Consumable` receipt reaches the Agent result port.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- Rust behavior/schema/compatibility tests: 12 passed, 0 failed;
- PostgreSQL Store wrapper compile: passed;
- scoped Rust Clippy with warnings denied: passed;
- Rust formatting check: passed.

## Explicitly not run

- physical PostgreSQL migration and transaction integration;
- real CRM, order, payment, knowledge or Memory Action Adapter;
- external approval service;
- real Active Call process Tool round-trip and upstream Tool-result command;
- LiveKit or ViLTE Agent Tool round-trip;
- real RustPBX, SIP/PSTN/trunk/provider call;
- performance, capacity, long-run, fault campaign and production deployment;
- independent code review.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
