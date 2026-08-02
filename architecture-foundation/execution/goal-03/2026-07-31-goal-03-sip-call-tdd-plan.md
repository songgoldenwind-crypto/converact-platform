# Goal 03 SIP/Call Foundation — Detailed TDD Plan

The filename is retained from the binding Goal; execution begins 2026-08-02.
Every step uses exact file staging, does not push, does not touch production or
the validation host, and does not start G04.

## 1. Contract Slice

Files:

- `current-state-audit.md`
- `sip-call-foundation-design.md`
- four machine contracts and schemas
- `recovery-clock-drain-contract.md`
- `fault-and-threat-review.md`
- `source-test-path-map.md`
- `traceability-v1.json` and schema
- `evidence-index-v1.json` and schema
- `goal-03-contract.test.mjs`

Red/green:

1. Run the contract test before generating documents and record missing
   artifacts/schema/corpus failure.
2. Generate deterministic contracts and corpus.
3. Validate all schemas, hashes, amendment semantics, 143-row trace closure and
   zero production claims.

Commit intent: `docs(voice): freeze G03 sip call contracts`.

## 2. Identifier and Leg Slice

Test first: `test/converact-call-leg-foundation.test.ts`.

Failing cases:

- SIP Call-ID cannot be accepted as a CallId by implicit conversion;
- UUID/`vcall_*` compatibility requires an exact existing `VoiceCall`
  repository match and module-issued authority record; plain objects fail;
- all six types reject whitespace, empty and oversized values;
- deterministic IDs resist component-boundary ambiguity;
- one Call supports bounded multiple Legs and Dialog history;
- restored Call generation is explicit; stale owner/generation/revision and
  conflicting duplicate fail closed;
- duplicate event ID/hash replays without revision change;
- CANCEL racing 2xx produces ACK-then-BYE;
- per-attempt fork selection rejects non-2xx status; winner/non-winner, atomic
  transfer selection, held-transfer abort and re-INVITE do not create
  ambiguous state or duplicate ACK;
- mailbox/timer/Leg/Dialog mutations share the authority fence and their limits
  reject new work while preserving existing state;
- a synchronous exception or async-handler rejection is reported as failure
  and leaves unrelated Call registry entries intact.

Minimal implementation files:

- `src/agent-runtime/converact/voice/foundation-identifiers.ts`
- `src/agent-runtime/converact/voice/call-leg-state-machine.ts`
- exact exports from `voice/index.ts`

Complexity: expected O(1) Call/Leg lookup and transition; O(bounded Legs) only
for explicit reconciliation. No global scan/task/database access.

Commit intent: `feat(voice): add bounded call leg foundation`.

## 3. Receipt and Drain Slice

Tests first in the G03 test file and existing SipFoundation/effect suites:

- accepted/completed/state-observed classify from the persisted
  `(level, from_state)` tuple;
- illegal receipt combinations fail closed;
- start drain rejects only new Protocol Sessions;
- opening sessions reserve capacity before Adapter callbacks, close reentrant
  capacity windows and prevent false active-zero;
- existing sessions continue, release O(1), active-zero becomes observable;
- repeated drain is idempotent and a deadline never force-closes Calls;
- deterministic Retry-After bounds remain exact.

Minimal implementation files:

- `sip-foundation/effect-oracle.ts` semantic receipt classifier;
- `sip-foundation/session-registry.ts` drain state/counters;
- `sip-foundation/types.ts` stable result/error types.

Commit intent: `feat(voice): fence sip receipts and drain`.

## 4. Focused Verification and Controlled Evidence

Run serially:

1. G03 contract test.
2. New Call/Leg tests.
3. SipFoundation, effect and recovery tests.
4. Exact rsipstack/RustPBX patch contract tests.
5. repository typecheck.
6. Generate raw output, command/source manifest and SHA-256 evidence with no
   secrets.

Update only evidence entries proved by these commands. `not_run` remains for
physical PostgreSQL, real peer, long call, host fault/OOM and performance.

## 5. External/Host Campaigns

These run only when their prerequisites are deliberately provided; absence
does not stop offline work:

- PostgreSQL N/N+1 activation, role/RLS, kill/restart and receipt replay;
- SIPp + Asterisk/FreeSWITCH/baresip interoperability;
- `100 Trying`, final and 503 raw latency distribution;
- 2h control soak and long-call restart/drain;
- worker panic, blocking DNS/store, process abort and cgroup OOM;
- same-source CPU, memory, allocation, CPS and 2/4/8 scaling.

Each campaign freezes commit, source/binary/config, hardware, clocks, workload,
seed and raw outputs. Missing campaigns stay `not_run` and keep production
eligibility false.

## 6. Independent Review and Closure

Review the final diff for Authority, wire behavior, state/race completeness,
receipt semantics, recovery, boundedness, fault truthfulness and evidence
non-inheritance. Resolve all Critical/High/Important/Minor findings, rerun exact
verification, then make narrow closure commit(s). Do not start G04.
