# AI outbound R1 Active Call reservation adapter evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_loopback`
>
> Production eligibility: `false`

This record proves the bounded Rust client contract at Converact commit
`7c4fce07a380d60f9689e4e35ea57eb6d8e327f8` for the exact-source Active Call
reservation overlay.

## Observed scope

- the platform-selected `ChannelAgentSessionId` is sent with the bounded inline Playbook while
  upstream `to` and `type` remain absent;
- a success response is accepted only when it returns the exact requested session identity;
- a mutation timeout or response-identity drift remains `OutcomeUnknown` and is never retried by
  the client;
- a bounded read-only query distinguishes `Pending`, `Active` and `NotFound` and retries only
  transport/server-unavailable observations;
- `NotFound` remains a typed observation and does not itself authorize a second mutation;
- malformed, oversized, identity-drifting or unknown-state query responses fail closed.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). The scoped TDD
cycle first failed because the stable-ID API, query method and state type did not exist, then passed:

- Active Call private-client tests: 9 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed.

## Explicitly not run

- real overlaid Active Call process or HTTP listener;
- durable Worker mutation intent, query-after-timeout composition or restart reconciliation;
- pending-to-active atomicity;
- Agent Release artifact resolution and exact component digest verification;
- RustPBX originate/bridge, SIP/PSTN, RTP/SRTP or audio;
- deployed runtime, performance, capacity, long-run and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
