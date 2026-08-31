# AI outbound R1 generic Tool Adapter evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the first industry-neutral Rust business Tool Adapter slice at Converact
commit `a965f50f89ef649acfe0115723fae87f74dedbbf`. It proves typed dispatch behind an already
authorized Tool Action; it does not prove a real CRM, task system, network Provider or production
deployment.

## Observed scope

- `customer.lookup` accepts a bounded `customer_id`, is compile-time restricted to the query
  effect class, and maps a typed customer directory observation to a bounded Tool result;
- `task.create_follow_up` accepts bounded typed arguments, is compile-time restricted to the
  mutation effect class, and passes the exact `ToolCallId` to the Provider as its idempotency key;
- an ambiguous follow-up create result remains `OutcomeUnknown`; reconciliation invokes Provider
  `query` with the same key and does not repeat the mutation;
- Provider ports do not receive URLs, credentials, SQL, shell commands, Agent state, Policy,
  Approval or Receipt authority;
- unknown capability names, effect-class mismatches and malformed typed arguments fail closed.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- generic Adapter behavior tests: 2 passed, 0 failed;
- Tool Broker Core contract tests: 4 passed, 0 failed;
- scoped Rust Clippy with warnings denied: passed;
- Rust formatting check: passed.

## Explicitly not run

- real customer directory, CRM or task Provider;
- Provider authentication, network retries, quotas and external error mapping;
- physical PostgreSQL integration;
- real Active Call, RustPBX, SIP/PSTN or media call;
- external approval service;
- performance, capacity, long-run, fault campaign and production deployment;
- independent code review.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
