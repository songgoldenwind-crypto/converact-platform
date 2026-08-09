# Goal 03 SIP/Call Foundation — Detailed TDD Plan

The filename is retained from the binding Goal; execution begins 2026-08-02.
Every step uses exact file staging, does not push, does not touch frozen
production, and does not start G04. Controlled campaigns may use only the
authorized validation host and must preserve its pre-existing stopped
containers.

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
- UUID/`vcall_*` compatibility requires the module-issued adapter bound to the
  constructor-branded exact concrete `PostgresVoiceCallStore`, native-private
  composition, captured trusted query and an exact tenant/ID match;
  caller lookups, records, prototype spoofs and own-method overrides fail;
- the adapter attests a control-plane projection and derives only a candidate;
  `VoiceCall`, `provider_call_id`, the TypeScript Leg registry and TypeScript
  SipFoundation cannot claim live native Authority;
- all six types reject whitespace, empty and oversized values;
- deterministic IDs resist component-boundary ambiguity;
- one Call supports bounded multiple Legs and Dialog history;
- restored Call generation is explicit; stale owner/generation/revision and
  conflicting duplicate fail closed;
- duplicate event ID/hash replays without revision change;
- CANCEL racing 2xx produces ACK-then-BYE;
- fork membership is registered before INVITE and bounded per attempt;
  selection rejects non-2xx status and returns per-Leg CANCEL effects for every
  remaining early sibling; winner/non-winner, atomic transfer selection,
  held-transfer abort and re-INVITE do not create ambiguous state or duplicate
  ACK; a terminating winner cannot be revived by a new/retransmitted 2xx;
- mailbox/timer/Leg/Dialog mutations share the authority fence and their limits
  reject new work while preserving existing state;
- the Call registry exposes no callback execution seam; bounded dequeued work
  executes only in a supervised worker and re-enters through the same fence.

Minimal conformance/reference implementation files:

- `src/agent-runtime/converact/voice/foundation-identifiers.ts`
- `src/agent-runtime/converact/voice/voice-call-id-authority.ts`
- `src/agent-runtime/converact/voice/call-leg-state-machine.ts`
- exact exports from `voice/index.ts`

Complexity: expected O(1) Call/Leg lookup and ordinary transition. Fork winner
selection is O(branches in that attempt), with a hard ceiling of 32, and
explicit reconciliation is O(bounded Legs). No global scan/task/database
access.

The TypeScript registry is not deployed as a second active Call registry. Its
semantics must later be bound to the native RustPBX process under
`G03-E16-NATIVE-AUTHORITY`.

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
- native effect-writer activation is a separate failing gate; PostgreSQL
  reference behavior alone cannot satisfy it.

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
5. Native Call/Leg/effect binding tests; the `.61` RustPBX port includes a
   direction-keyed UAS/UAC state model, closed v2 wire-attempt facts and
   separate transport/protocol receipts plus one parent-bound non-2xx ACK
   derivation. Network peer observations additionally require the private,
   zero-sized Endpoint ingress proof. The gate remains default-disabled; retain activation `not_run`
   until automatic 200-to-CANCEL, UAS-2xx ownership, parent-Unknown and stale-
   nonterminal crash recovery, and fixed observer/reconciler supervision are
   wired through the live endpoint.
6. repository typecheck.
7. Generate raw output, command/source manifest and SHA-256 evidence with no
   secrets.

Update only evidence entries proved by these commands. Local verification does
not by itself promote physical PostgreSQL, real peer, long call, host fault/OOM
or performance evidence.

## 5. External/Host Campaigns

These run only when their prerequisites are deliberately provided; absence
does not stop independent offline work. The physical PostgreSQL restart/replay
campaign, the `.59` six-case native PostgreSQL component campaign, the `.60`
atomic-derived-ACK case and the `.61` peer-ingress source suites completed on
the authorized validation host. They remain within
`G03-E05-POSTGRES = verified_controlled` and do not qualify the remaining
campaigns:

- PostgreSQL role/RLS, physical restart, receipt replay, atomic v2 transition,
  repair exhaustion and database-clock skew (completed controlled slices;
  mixed-binary rolling N/N+1 remains outside this evidence);
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
