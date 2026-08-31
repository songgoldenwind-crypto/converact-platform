# R1 Active Call complete channel-agent port evidence

Date: 2026-09-01
Scope: local Rust contracts, loopback HTTP and isolated exact-source overlay only
Production eligibility: `false`

## Proven

- The Rust `ActiveCallChannelAgent` implements the complete outbound `ChannelAgentPort` boundary:
  exact tenant/Agent Release artifact resolution, stable session reservation, SIP-leg attachment
  observation, media readiness, mandatory disclosure command, disclosure completion observation,
  explicit conversation start and terminal observation.
- The disclosure command uses the stable channel-agent session ID as its exact `playId`.
- The pinned Active Call overlay remains silent until a positive-duration `TrackEnd` with that exact
  `playId`, after which the explicit start mutation can enter `started`.
- Same-session control work is serialized without a global lock across network I/O. A concurrent
  reservation replay emits one external reservation mutation.
- Per-session bindings reject tenant, Attempt, Agent Release and Call identity drift. Mutation
  timeouts remain `OutcomeUnknown`; earlier observations and `not_found` cannot clear disclosure or
  start uncertainty and cannot authorize a blind retry.
- Media readiness alone cannot bypass the required platform Call attachment before disclosure.
- Artifact resolution happens before a session binding is inserted. Interleaved resolver failure
  and success cannot leave a successful reservation in an orphaned binding.
- Local session tracking is bounded. It does not create a background task, global scan, media-path
  allocation or server-side TypeScript authority.

## Precise local verification

| Check | Result |
|---|---:|
| Node overlay anchor/idempotence tests | 3 passed |
| isolated transformed Active Call tests | 3 passed, 255 filtered |
| Active Call client tests | 11 passed |
| Active Call lifecycle decoder tests | 2 passed |
| worker reservation adapter tests | 2 passed |
| complete `ChannelAgentPort` loopback tests | 8 passed |
| adapter + worker scoped Clippy with warnings denied | passed |
| transformed-source `rustfmt` and `git diff --check` | passed |
| canonical pinned source checkout | clean at required commit/tree |

The upstream full-crate Clippy baseline was not rerun for this slice. The earlier exact-source
attempt remains recorded as 266 unrelated pre-existing lint findings; no clean upstream-Clippy
claim is made.

## Not proven

- a running Active Call process or RustPBX injecting `X-Converact-Agent-Session`: `not_run`;
- a real SIP/PSTN leg, RTP/SRTP audio, provider ASR/TTS/LLM, barge-in or intent quality: `not_run`;
- callee-audible disclosure, recording capture/continuity and policy sufficiency: `not_run`;
- physical PostgreSQL effect intent, restart/multi-node recovery and private-header mTLS: `not_run`;
- deployed runtime, performance, capacity, long-run and production eligibility: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
