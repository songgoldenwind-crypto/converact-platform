# AI outbound R1 RustPBX Agent-leg session evidence

## Scope

This controlled local record proves the exact wire seam between Converact commit
`e7129ad36ea4b09950d046db76f6239fceda839f` and the pinned RustPBX source commit
`6c49ee76baa54fdbf8f98020cc9bee158c7c15de` with the existing ivekit.85 queue plus
the candidate ivekit.86 patch.

It proves only that:

- customer `call.originate` uses the pinned RustPBX field names and carries an empty
  `extra_headers` object;
- the separate internal `call.leg_add` wire carries one bounded `agent_session_id`;
- RustPBX preserves that field through RWI and `CallCommand`;
- both dynamic-leg INVITE paths use one exact `X-Converact-Agent-Session` header builder;
- a missing binding emits no header, while empty, bad-prefix, CRLF and greater-than-255-byte
  bindings fail before header construction;
- the identifier's `Debug` representation is redacted.

Patch SHA-256:

```text
2d74cf189f7744494c26a7859864d53363664305a6e3347b98aaa2f09ae63bb2  rustpbx-converact-active-call-agent-session.patch
```

## Test-first evidence

The first exact-source test failed as expected because
`RwiCommandPayload::LegAdd` had no `agent_session_id` field:

```text
error[E0026]: variant `RwiCommandPayload::LegAdd` does not have a field named
`agent_session_id`
```

The header test then failed independently because the shared `invite_headers` builder did not
exist. After the minimum implementation, the following focused commands passed with Rust 1.94.1
and the pinned lockfile:

```text
cargo test --lib call::domain::command::tests::agent_session_id_accepts_only_the_bounded_header_safe_grammar --locked
1 passed; 2130 filtered out

cargo test --lib rwi::session::tests::agent_leg_request_preserves_the_platform_session_binding --locked
1 passed; 2130 filtered out

cargo test --lib proxy::agent_session::tests::invite_header_is_exact_and_absent_without_an_agent_binding --locked
1 passed; 2130 filtered out

cargo test --test dynamic_leg_e2e_test --no-run --locked
compiled successfully

cargo test --manifest-path server-rs/Cargo.toml -p converact-rustpbx-rwi-adapter --locked
client 3/3; envelope 6/6; doc tests 0/0
```

The eight RustPBX result files produced by applying the canonical patch to the indexed ivekit.85
baseline matched the already-tested candidate tree byte-for-byte. `bash -n` passed for the bumped
ivekit.86 build script, the eight RustPBX files passed scoped rustfmt with `skip_children=true`,
and the four platform adapter files passed scoped rustfmt. No broad regression suite was run.

## Explicitly not proved

- server or container execution: `not_run`;
- real customer SIP/PSTN answer and subsequent Agent leg creation: `not_run`;
- on-wire capture proving the header is absent on the customer INVITE and present only on the
  Agent INVITE: `not_run`;
- real Active Call reservation attachment, disclosure, ASR/TTS/LLM, RTP/SRTP media and barge-in:
  `not_run`;
- durable orchestration, unknown-result reconciliation, restart, multi-node and production:
  `not_run`.
