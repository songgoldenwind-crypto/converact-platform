# AI outbound R1 human Handoff evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the first industry-neutral Rust `AI -> human -> AI` telephone Handoff slice at
Converact commit `8b79ef5b474eeaa35b544eedabd2c4272cd5aae1`. It proves the local domain,
durable command/receipt boundary, Worker orchestration and inert PostgreSQL Adapter. It does not
prove a real human seat, `RustPBX`, Active Call process, physical database, SIP/PSTN or media path.

## Observed scope

- a versioned, bounded and PII-minimized Context Packet is frozen before the human Leg effect;
- the source AI generation remains owner until an answered human Leg is observed and committed;
- human and resumed-AI ownership each advance the execution generation exactly once;
- exact replay does not repeat an already applied human dial or AI-session prepare effect;
- an unknown dial or AI resume outcome is queried with the same stable identity before progress;
- a definitive human-dial rejection aborts before ownership changes and replays without redialing;
- PostgreSQL access is tenant-transaction scoped, construction is inert, and runtime Debug output
  does not expose topology or credentials;
- the Worker consumes the PostgreSQL Adapter through the same vendor-free Rust durability port used
  by the controlled test double.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- Handoff Worker normal/replay/abort/unknown-query behavior: 4 passed, 0 failed;
- Handoff Core ownership and fence contracts: 3 passed, 0 failed;
- Handoff Store command/schema contracts: 3 passed, 0 failed;
- shared Voice Agent wire contracts: 6 passed, 0 failed;
- PostgreSQL inert-construction contract and Worker port binding: 2 passed, 0 failed;
- scoped Rust Clippy with warnings denied: passed;
- scoped Rust formatting check: passed.

## Explicitly not run

- physical PostgreSQL transaction/RLS/reconcile-lease integration;
- real `RustPBX` human originate/query/answer/terminate behavior;
- real Active Call pause/resume/session-generation behavior;
- real human seat, queue/ACD or supervisor workflow;
- SIP/PSTN, RTP/SRTP, recording continuity, DTMF, hold or transfer;
- LiveKit, browser, video or cross-channel Handoff;
- performance, capacity, long-run, fault campaign and production deployment;
- independent code review.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
