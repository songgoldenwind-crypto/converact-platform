# Speech Runtime Contract R1 Implementation Plan

**Goal:** Add the first provider-neutral Rust authority contract and pure lifecycle state machine
for realtime speech sessions without coupling Call authority to Active Call, Hugging Face, LiveKit
or one model vendor.

**Architecture:** `converact-voice-agent-contracts` owns bounded wire identities, audio frames,
fences, response leases and closed enum values. `converact-ai-outbound-core` owns a pure
`SpeechSession` aggregate; durable stores and provider adapters remain outside this slice. The
aggregate has no sockets, database access, tasks, locks or unbounded collections.

**Tech stack:** Rust 1.94.1, Serde, existing Converact workspace contracts, scoped Cargo tests and
Clippy.

---

### Task 1: Freeze bounded Speech Runtime wire contracts

**Files:**

- Modify: `server-rs/crates/voice-agent-contracts/src/id.rs`
- Create: `server-rs/crates/voice-agent-contracts/src/speech.rs`
- Modify: `server-rs/crates/voice-agent-contracts/src/lib.rs`
- Create: `server-rs/crates/voice-agent-contracts/tests/speech_runtime_contract.rs`

- [x] Add `AgentRunId`, `ChannelBindingId`, `SpeechSessionId` and `SpeechResponseId` through the
  existing bounded identifier macro.
- [x] Define distinct positive `SpeechControlFence` and `ResponseFence` values so control and
  response authority cannot be accidentally interchanged.
- [x] Define `SpeechSessionBinding` with tenant, interaction, Agent run, speech session, channel,
  session generation, media generation and control fence.
- [x] Define `ResponseLease` with response identity, context revision, lease generation, response
  generation and response fence.
- [x] Define `PcmAudioFrame` accepting only 8/16/24/48 kHz, one or two channels, non-empty signed
  16-bit little-endian payloads up to 60 ms, positive sequence and a monotonic capture timestamp.
- [x] Define closed lifecycle, write-outcome and normalized event enums using lower snake case
  Serde values.
- [x] Test exact serialization plus rejection of zero fences, unsupported audio geometry,
  malformed payload sizes and oversized frames.
- [x] Run:
  `cargo test --locked -p converact-voice-agent-contracts --test speech_runtime_contract`.

### Task 2: Implement the pure fenced session aggregate

**Files:**

- Create: `server-rs/crates/ai-outbound-core/src/speech_session.rs`
- Modify: `server-rs/crates/ai-outbound-core/src/lib.rs`
- Create: `server-rs/crates/ai-outbound-core/tests/speech_session.rs`

- [x] Write a failing happy-path test for `prepared_blocked -> active -> response -> cancelled ->
  closed`.
- [x] Write failing tests proving an old control fence cannot commit, write, create, cancel or
  close and an old response fence cannot cancel the current response.
- [x] Write a failing test proving audio sequence rollback is rejected, bounded queue overflow is
  reported as `dropped_overflow`, and a closed session returns `closed` without reviving state.
- [x] Implement `SpeechSession` as a pure aggregate with one optional current response and one last
  accepted audio sequence; do not add a global registry, background task, allocation per packet or
  provider-specific type.
- [x] Run:
  `cargo test --locked -p converact-ai-outbound-core --test speech_session`.

### Task 3: Verify and record the local contract slice

**Files:**

- Create: `architecture-foundation/ai-outbound/evidence/r1-speech-runtime-contract/README.md`
- Create: `architecture-foundation/ai-outbound/evidence/r1-speech-runtime-contract/verification.json`

- [x] Run the two precise test targets and scoped Clippy with warnings denied.
- [x] Run exact-file format checks and `git diff --check` without formatting unrelated modules.
- [x] Record only observed local results; keep physical PostgreSQL, Active Call, RustPBX,
  SIP/PSTN/media, HF/ASR/LLM/TTS Providers, latency, capacity and production as `not_run`.
- [x] Commit source/tests first, then commit the evidence separately with exact-file staging.
