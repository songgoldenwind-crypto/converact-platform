# AI outbound R1 Agent Release reservation binding evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the Campaign-selected immutable Agent Release binding at Converact commit
`fc0e3fcc426f567000d939f754e62a315124d810`.

## Observed scope

- the Worker resolves the exact published Release referenced by the running Campaign before any
  channel-agent reservation or telephony mutation;
- the reservation request carries both the typed `AgentReleaseId` and its canonical Release
  `content_hash` rather than only a `CallAttemptId`;
- only a lowercase 64-character SHA-256 digest can cross the execution boundary;
- the Core test double observes the exact Release binding before dial;
- the Worker tracer bullet proves that the reservation binding equals the Campaign Release;
- a missing Campaign or Release still prevents telephony mutation.

This does not prove that the private Active Call process loaded the corresponding Prompt, Flow,
Knowledge, Tool, Speech, Compliance, Outcome or Evaluation artifacts. That physical artifact
resolution and runtime composition remains a separate gate.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- AI outbound Core orchestration and Release binding: 6 passed, 0 failed;
- Worker Campaign-to-reservation binding: 5 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed.

## Explicitly not run

- real Active Call process, Playbook loading or artifact resolution;
- real RustPBX originate/bridge and SIP/PSTN/RTP/SRTP media;
- physical PostgreSQL repository composition;
- provider/model calls, audio, intent quality and customer outcome;
- deployed runtime, performance, capacity, long-run and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
