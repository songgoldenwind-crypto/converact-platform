# AI outbound R1 tracer-bullet evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the first bounded Rust AI-outbound control slice at Converact commit
`e20324c6302d5f021922d4df62d5067ba7872f62`. It does not prove a live Active Call process,
RustPBX, SIP/PSTN, provider, PostgreSQL runtime, recording, performance, capacity, long-run or
production deployment.

## Observed scope

- immutable Agent Release and Campaign/Attempt state rules;
- fail-closed compliance, pre-dial Agent reservation and mandatory disclosure ordering;
- durable intent-before-effect and unknown-outcome/reconcile semantics;
- bounded Active Call command/event normalization using pinned upstream fixtures;
- bounded RustPBX RWI v1 commands, secret-safe endpoint policy and uncertain timeout semantics;
- tenant-scoped internal inspection, idempotent reconcile receipt, readiness and drain admission;
- one controlled Attempt reaching `completed`, with disclosure, two final transcript segments and
  outcome `customer_interested`;
- a TypeScript compatibility-only mapping into the Rust projection without writer activation.

The controlled Telephony and Channel Agent ports are deterministic test doubles. Therefore the
result cannot be promoted to `controlled_integration`, `real_sip_pstn`, `real_provider` or
`production`.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh results were:

- Rust tests: 55 passed, 0 failed across the six scoped packages/suites;
- TypeScript compatibility: 3 passed, 0 failed;
- scoped Rust Clippy with warnings denied: passed;
- Rust formatting check: passed;
- pinned Active Call source identity: all reported checks passed.

## Explicitly not run

- PostgreSQL runtime integration and migration against a server;
- live RustPBX RWI session;
- live Active Call process and media session;
- real SIP/PSTN/trunk/provider call;
- recording/CDR linkage and complete final transcript projection;
- Tool Broker/Action Receipt execution;
- AI -> Human -> AI handoff;
- knowledge, memory, summary, evaluation and dashboard;
- HF SpeechRuntime overlap replacement;
- performance, capacity, long-run, fault campaign and production deployment.
- independent human/agent code review (scoped Clippy and local self-review passed, but are not an
  independent review).

No local Docker was used and no server service, container or deployed code was changed by this
verification.
