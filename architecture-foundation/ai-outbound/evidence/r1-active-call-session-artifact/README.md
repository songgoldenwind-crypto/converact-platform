# AI outbound R1 Active Call session and artifact evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `exact_source_review`
>
> Production eligibility: `false`

This record covers Converact commits `25532a27`, `a64f052d`, `9787dc50` and `de462ff0`
against pinned Active Call `0.3.83` commit
`6224d948cc0941ac48b4a5426477aeaf639c2e98`, tree
`9521ad341fb992ba6d491eb217983df8cf85d2cf`.

## Proven locally

- an indeterminate Agent reservation freezes the Attempt as `outcome_unknown` before customer
  dialing and is not repeated;
- the platform derives a deterministic `ChannelAgentSessionId` from tenant, physical Attempt and
  the exact Agent Release identity/content hash;
- tenant, Attempt or Release drift changes that identity;
- the reservation request carries the platform-selected identity and a mismatching acknowledgement
  freezes the Attempt before RustPBX originate;
- the reservation carries every exact Agent Release component digest, not only Release ID and
  aggregate content hash;
- an Active Call Playbook artifact accepts only bounded upstream framing plus an exact declared
  canonical digest, retains the exact Release binding and redacts document content from `Debug`.

The artifact boundary does **not** claim that a Playbook was deterministically compiled from the
eight Release component payloads. A trusted resolver, component payload store and compiler revision
are still required for that proof.

## Exact-source integration finding

The pinned SIP path is not yet safe to present as a complete `ChannelAgentPort`:

- inbound SIP uses the Active Call dialog ID as its session ID;
- the matched SIP Playbook is passed directly, so the current pending reservation is not the
  authoritative Playbook for that SIP leg;
- `PlaybookRunner::run` invokes `on_start` immediately, which can begin the greeting/business
  conversation before Converact has durably completed mandatory disclosure.

The next real integration slices are therefore: artifact resolver and reservation adapter, explicit
SIP-leg/session binding, then an armed-to-start lifecycle gate after disclosure. No no-op attach or
false media-ready observation was added.

## Scoped verification

The machine-readable ledger is [verification.json](./verification.json). Fresh scoped results:

- AI outbound orchestrator: 9 passed, 0 failed;
- stable session derivation: 2 passed, 0 failed;
- Worker Release/session reservation binding: 1 passed, 0 failed;
- Playbook artifact boundary: 2 passed, 0 failed;
- Core and Worker Clippy with warnings denied: passed;
- pinned Active Call source/archive/cleanliness gate: passed.

## Explicitly not run

- component payload retrieval and deterministic Playbook compilation;
- real Active Call process, provider, SIP/PSTN or media;
- SIP-leg/session binding and disclosure-complete lifecycle gate;
- durable Active Call reservation state, restart recovery and atomic pending-to-active transition;
- performance, capacity, long-run and production deployment.

No local Docker or server was used. No running service, container or server code was read or
changed. Pre-existing unrelated work was not staged.
