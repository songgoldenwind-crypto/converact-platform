# Active Call Handoff Adapter R1 implementation plan

> **Status:** `controlled_loopback_contract_passed / physical_media_switch_not_run /
> production_not_run`

**Goal:** Replace the `ChannelAgentHandoffPort` test double with a bounded Rust adapter for the
pinned Active Call process, without treating playback commands as Agent ownership or media-routing
authority.

## Source facts and boundary

The pinned Active Call `0.3.83` source exposes:

- `GET /list`, which proves only that a session is currently registered;
- `POST /command/{id}`, whose success proves only that a command was accepted by the broadcast
  channel;
- `interrupt`, which removes current server-side playback;
- `pause` and `resume`, which affect only the current file/TTS playback track.

It does not expose a durable paused/resumed Agent state, command execution receipt, Converact
generation fence or RustPBX media-owner observation. Therefore this adapter must not use
Pause/Resume as proof of AI/human ownership.

## Frozen behavior

1. `prepare_ai_resume` queries the exact replacement `ChannelAgentSessionId`. An active session is
   ready for the already-existing Handoff prepare contract; a missing session is deterministically
   `NotApplied`.
2. `query_ai_resume` performs the same read-only query and never creates or resumes a second
   session.
3. `GenerationCommit` carries the exact AI session bound to the committed Handoff state.
4. A committed human generation sends one non-graceful `interrupt` to the previous AI session to
   remove residual playback. A committed AI generation sends no Pause/Resume command: the model
   requires a new session, and RustPBX media activation remains the authority for making it audible.
5. Command acceptance is only cleanup notification delivery. Timeout, ambiguous response,
   rejection or invalid response makes the Handoff reconcile-required; it is not recorded as
   successful output suppression.
6. Provider errors remain low-cardinality and contain no endpoint, tenant, customer or transcript.
7. The adapter does not expose Active Call Hangup, REFER, Bridge or direct Tool execution.

## Minimal TDD sequence

1. Add focused loopback tests for replacement-session readiness, missing-session rejection and
   human-generation interrupt delivery.
2. Add the session identity to `GenerationCommit` and implement `ActiveCallHandoffPort` over the
   existing `ActiveCallClient`.
3. Run only the new adapter test, the existing Handoff runtime test, scoped format and scoped
   Clippy.
4. Record local controlled evidence. Real Active Call, RustPBX media switching, SIP/PSTN, audio,
   human seat, physical PostgreSQL and production remain `not_run`.

## Completion boundary

R1 proves only the concrete private-process Handoff adapter contract. It does not prove that an
answered human can hear or speak to a real caller. Human/AI media activation must be implemented
and observed through the RustPBX media authority before the physical Handoff can be marked passed.

The controlled result is recorded in
[R1 Active Call Handoff Adapter evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-handoff-adapter/README.md).
