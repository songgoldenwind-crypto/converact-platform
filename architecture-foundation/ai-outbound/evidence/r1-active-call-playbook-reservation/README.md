# AI outbound R1 Active Call Playbook reservation evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_loopback`
>
> Production eligibility: `false`

This record proves the bounded private-client contract for pinned Active Call `0.3.83`
`POST /api/playbook/run` at Converact commit
`738a6292f70ebf3d1e71906f2d9ded9710008dcc`.

## Observed scope

- inline Playbook content must have YAML front matter, excludes unsafe control characters and is
  bounded to 64 KiB;
- the request uses the exact pinned `/api/playbook/run` route and sends only `content`;
- upstream `to` and `type` are deliberately omitted so Active Call cannot become telephony or
  media-route authority;
- a successful bounded response produces a typed `ChannelAgentSessionId`;
- mutation timeouts and ambiguous responses become `OutcomeUnknown`, never an automatic retry;
- Playbook debug output is redacted;
- the pinned source checkout, tree and archive identity gate passed.

## Upstream limitation

The pinned endpoint chooses a random session ID and returns it only in the mutation response. Its
pending Playbook registry is not exposed by `/list`; stale entries are only removed by the
upstream five-minute cleanup. Therefore a lost response cannot be reconciled to one exact pending
reservation. This slice fails closed and forbids blind retry, but it does **not** satisfy the final
durable idempotent reservation contract. A platform-owned idempotency/session identity extension
or an equivalent queryable receipt remains required before production composition.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- Active Call private-client tests: 7 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed;
- exact pinned Active Call source gate: passed.

## Explicitly not run

- real Active Call process or Playbook parser/model/provider;
- Agent Release artifact resolution and component digest verification;
- idempotent/queryable pending reservation extension;
- RustPBX originate/bridge, SIP/PSTN or media;
- deployed runtime, performance, capacity, long-run and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
