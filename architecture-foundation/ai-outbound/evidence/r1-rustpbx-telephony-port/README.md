# AI outbound R1 RustPBX TelephonyPort evidence

Date: 2026-09-01
Scope: local Rust contracts, loopback RWI and isolated exact-source patch tests
Production eligibility: `false`

## Source identities

- Converact parent commit: `5d13e012d9d0be462ae07b6b13574cd40bdfade3`;
- RustPBX source commit: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`;
- Active Call source commit: `6224d948cc0941ac48b4a5426477aeaf639c2e98`;
- RustPBX patch set: `ivekit.87`;
- `rustpbx-converact-call-inspect.patch` SHA-256:
  `6b5d213e77828042809c8719a8d84d2f563c2e79a02bd2420d9656b74c267e5b`.

## Proven

- `OutboundDialBinding` accepts only bounded destination, caller identity, timeout and trunk
  values, and redacts destination, caller and trunk values from `Debug`.
- The orchestrator loads that immutable binding before Agent reservation and customer dialing.
- The concrete Rust `RustPbxTelephony` emits the exact pinned `call.originate` request, requires
  the returned `call_id` to match, and observes answer through `session.inspect_call`.
- After answer, RustPBX owns creation of the Agent SIP leg through `call.leg_add`; Active Call's
  attachment operation is only an association/query confirmation and cannot create another leg.
- Hangup uses the stable Attempt identity for its action ID. A missing mutation receipt is
  `OutcomeUnknown` and is not replayed by the adapter.
- `session.inspect_call` performs one keyed lookup in the existing RustPBX call registry and
  returns an exact `CallInfo` object or `null`; it does not scan `session.list_calls`.
- The adapter has no process-local known-call collection, global lock, call-count scan or
  restart-sensitive terminal classification. A `null` result remains `NotFound`; only the
  orchestrator's already-answered/disclosed/conversing Attempt context may accept that absence as
  terminal during normal finalization. Reconciliation of an unknown mutation still returns the
  explicit observation for a later policy decision.
- Client configuration and command values remain bounded; public plaintext endpoints,
  credential-bearing URLs and malformed command identities fail closed.

## Test-first observations

Before the implementation, the focused compile/test seams failed independently because the core
had no dial binding, the RWI adapter had no concrete telephony type, and pinned RustPBX had no
`InspectCall` command. The final restart-safety test then failed four orchestrator cases with
`telephony_observation_unexpected` when the fake authority returned `NotFound`; this demonstrated
the old dependence on process-local terminal memory. A final redaction assertion also failed while
the dial binding still exposed `carrier-a` through `Debug`; the implementation now redacts it.

After the minimum implementation and removal of that memory, these focused commands passed with
Rust 1.94.1 and the workspace lockfile:

```text
cargo test -p converact-ai-outbound-core --test dial_binding --locked
2 passed

cargo test -p converact-ai-outbound-core --test orchestrator --locked
10 passed

cargo test -p converact-rustpbx-rwi-adapter --test client --locked
3 passed

cargo test -p converact-rustpbx-rwi-adapter --test envelope --locked
7 passed

cargo test -p converact-rustpbx-rwi-adapter --test telephony --locked
2 passed

cargo test -p converact-voice-agent-worker --test active_call_channel_agent --locked
8 passed

cargo test -p converact-voice-agent-worker --test tracer_bullet --locked
5 passed

cargo clippy -p converact-ai-outbound-core -p converact-rustpbx-rwi-adapter \
  -p converact-voice-agent-worker --all-targets --locked -- -D warnings
passed
```

The isolated pinned RustPBX source, with the canonical patch queue in the index and no unstaged
source difference, also passed:

```text
cargo test --lib inspect_call --locked
2 passed; 2131 filtered out
```

No broad regression suite was run for this narrow slice.

## Explicitly not proved

- a physical `AttemptStorePort::load_dial_binding` implementation and immutable database row:
  `not_run` (the port, validation and controlled fake exist);
- application composition, secret/config resolution and a running Worker using this concrete
  adapter: `not_run`;
- server or container build/deployment: `not_run`;
- real RustPBX or Active Call processes, SIP/PSTN signaling, carrier answer, RTP/SRTP audio,
  disclosure audibility, ASR/TTS/LLM, barge-in and recording: `not_run`;
- restart, multi-node, fault injection, performance, capacity, long-run and production:
  `not_run`.

No local Docker was used. No server service, container or deployed code was inspected, stopped,
restarted or changed. Pre-existing unrelated work remains outside this evidence and must not be
staged with the checkpoint.
