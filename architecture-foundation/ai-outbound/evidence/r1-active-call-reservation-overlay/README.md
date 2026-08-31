# AI outbound R1 Active Call reservation overlay evidence

> Recorded: 2026-08-31
>
> Evidence class: `exact_source_overlay` + `local_contract`
>
> Production eligibility: `false`

This record proves the narrow build-time overlay at Converact commit
`ab0ec6aae3c62fce01afa1ebabfcf8a0ce94707a` against pinned Active Call `0.3.83`
commit `6224d948cc0941ac48b4a5426477aeaf639c2e98`, tree
`9521ad341fb992ba6d491eb217983df8cf85d2cf`.

## Observed scope

- the overlay refuses any source checkout whose commit or tree differs from the pinned identity;
- the same overlay can be applied twice without changing the already-overlaid source;
- `POST /api/playbook/run` accepts an optional platform-owned, bounded `session_id`;
- the same session ID and Playbook content replay successfully, while changed content returns
  `409 Conflict`;
- `GET /api/playbook/reservations/{session_id}` reports the in-process `pending` or `active` state;
- requests that omit `session_id` retain the upstream random-ID behavior;
- the canonical pinned development checkout remains clean and unmodified.

## Deliberate limits

The overlay does not make `pending_playbooks` durable. The pinned upstream also removes a pending
Playbook before installing its active-call guard, so this evidence does not claim an atomic
`pending -> active` observation. A query `404` can be transient or follow a process restart; it is
not proof that no call-side effect exists and cannot authorize a blind retry. Converact must first
persist its own mutation intent and reconcile unknown outcomes.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- exact commit/tree overlay application twice: passed;
- transformed Rust formatting and diff check: passed;
- focused transformed-source tests: 2 passed, 0 failed;
- Goal manifest/schema/hash binding: 1 passed, 0 failed;
- canonical pinned source checkout cleanliness: passed.

## Explicitly not run

- real Active Call process, HTTP listener, Playbook parser/model/provider or restart;
- atomic pending-to-active handoff or durable Active Call reservation storage;
- Rust Adapter stable-ID/query composition and unknown-outcome reconciliation;
- Agent Release artifact resolution and exact component digest verification;
- RustPBX originate/bridge, SIP/PSTN, RTP/SRTP or audio;
- deployed runtime, performance, capacity, long-run and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
