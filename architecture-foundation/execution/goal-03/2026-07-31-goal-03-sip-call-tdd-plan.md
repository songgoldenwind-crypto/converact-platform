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
5. Native Call/Leg/effect binding tests; the current `.72` RustPBX port includes a
   direction-keyed UAS/UAC state model, closed v2 wire-attempt facts and
   separate transport/protocol receipts plus one parent-bound non-2xx ACK
   derivation. Network peer observations additionally require the private,
   zero-sized Endpoint ingress proof. The matched-CANCEL component path now
   requires one pre-registered peer-derived capability. One bounded UAS-2xx
   owner now retains the same frozen response and permit through exact ACK or
   64*T1, with no per-call task. The product layer retains that owner after
   module return and classifies deadline/initial-send failure explicitly. Local
   exact-source suites pass. The v2 HA capsule additionally authenticates one
   canonical `CallId`/`InteractionId`/provider reference across both legs and
   advances owner/generation/revision exactly once; legacy v1 remains readable
   but cannot resume live authority. The default-disabled stale-effect recovery
   additionally selects only one exact tenant/session/generation under a higher
   successor epoch, moves at most 100 expired nonterminal effects to honest
   `unknown` atomically, and relies on the rolling partial index; live owner
   wiring and real process-crash proof remain `not_run`. One fixed supervisor
   task now owns each observation shard, retries the same armed work with
   bounded backoff, restarts after an unwind panic, and preserves quarantine or
   armed work across permanent failure/cancellation. A separately
   default-disabled reconciler now accepts only an opaque/sealed crate-private
   one-shot grant whose minting surface is reserved for the durable Authority,
   binding one exact tenant/session/generation, one successor repair epoch and
   1..100 strictly ordered unique targets. It uses the existing composite primary key
   for bounded exact lookup/no scans, a fixed worker count and bounded queue, a
   true monotonic expiry that includes queue dwell, one whole-millisecond
   execution lease frozen at dequeue, a usable maximum timeout of 29 s and
   remaining database-relative lease strictly greater than timeout + 500 ms.
   It verifies exact claimed and exhausted IDs. Submission after parent
   cancellation is rejected; a caught store/oracle panic cancels the whole
   reconciler child domain, stops every repair worker and rejects new grants so
   the shared dependencies are never reused. Process-local counters advance for each confirmed durable reconcile or
   exhaustion and retain that progress if later batch work fails transiently,
   with `Terminal`, permanently, by panic, timeout or cancellation. Ordinary
   `FenceLost`/`Terminal` races are superseded without quarantining the worker.
   Isolated local tests pass `28/28`, the affected SipEffect suite passes
   `87 passed / 0 failed / 8 ignored`, both sibling privacy UI probes fail with
   their exact expected `E0603`/`E0451`, and locked library check plus Rust
   formatting pass. The gate
   remains default-disabled; retain activation `not_run` until
   its real Call Core holder, live Endpoint composition and reconciliation
   resume are wired, and until parent-Unknown, stale-nonterminal and in-flight
   UAS-owner crash recovery are closed. The authoritative issuer, durable
   completion sink, physical PostgreSQL exact-target claim, 10K/100K
   distractor query plans, process-crash/two-node and Linux full suites also
   remain `not_run`.
   The feature-first `.73` slice then splits one exact matched peer CANCEL on a
   Trying/Proceeding INVITE into two Rust transaction-local effects. A sealed
   child proof authorizes `200` to CANCEL as transport-terminal; a second child
   proof authorizes `487` to the original INVITE and holds its own protocol
   permit until matching ACK. A late CANCEL after an existing final receives
   only 200 and cannot authorize another final.
   Unified RustPBX Native Call authority reserves the exact pair before gate
   installation, and partial registration or installation conflict revokes
   the pair and closes the affected active Call in covered non-concurrent
   paths. Exact cleanup fencing against a concurrently installed successor Call
   and capability reconstruction after process restart remain activation
   blockers. Local exact-source tests
   pass full rsipstack `314/314`, full RustPBX
   `2063 passed / 0 failed / 9 ignored`, focused server transactions `32/32`,
   durable gate `39/39`, Native capability composition `8/8`, Active Call
   registry `24/24`, builder default disabled `1/1`, and both locked library
   checks. The ignored external-prerequisite cases remain `not_run`. This does
   not activate the runtime: ordinary provisional/final response intents are
   not yet issued. The isolated Linux rsipstack server target passes `32/32`;
   RustPBX host targets remain `not_run` after their lib-test compile reached
   the unchanged safe memory ceiling. Physical PostgreSQL, non-UDP transports,
   crash/restart and live product wiring remain `not_run`.
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
atomic-derived-ACK case, the `.61` peer-ingress suites and the `.62`
peer-derived CANCEL source suites completed on the authorized validation host.
The `.63` UAS-2xx rsipstack host suites pass, but the host exposed a RustPBX
exhaustive-match compile failure and therefore rejected that candidate. The
`.64` owner-retention correction passes the local and authorized-host full
component suites; the controlled raw bundle is
`evidence/raw/uas-2xx-retention-a85d249-09/`; it remains within
`G03-E05-POSTGRES = verified_controlled`.
The `.71` fixed observation-supervisor candidate also passes the complete
controlled Linux component suites at exact source `1ebbd765…`; its secret-
scanned raw logs and dependency-cache history are under
`evidence/raw/full-linux-suites-1ebbd76-13/`. This closes host component
requalification for `G03-E04-EFFECT` only. Reconciler supervision, live
Endpoint composition, real process crash and all performance/fault gates
remain open. Neither controlled component result qualifies the remaining
campaigns:

The `.72` exact-target reconciler has local and controlled offline focused-Linux
component proof: `28/28`, affected SipEffect
`87 passed / 0 failed / 8 ignored`, the two expected-code privacy UI probes,
locked check and Rust formatting. The focused raw bundle is
`evidence/raw/focused-linux-sip-effect-b3c9da0-14/`. It does not inherit `.71`
Linux full-suite evidence or promote any evidence
entry. Its physical PostgreSQL exact-target/rollback and 10K/100K query-plan
campaigns, authoritative issuer, durable completion sink, live Endpoint,
process-crash/two-node, Linux full, fault/performance and production gates stay
`not_run`.

The `.73` zero-impact host campaign is retained under
`evidence/raw/isolated-server-matched-cancel-4431270-15/`. The exact rsipstack
server-transaction target passes `32/32`. The RustPBX lib-test binary was not
produced because its compile received SIGKILL at the unchanged 2,560 MiB
isolation ceiling, so all RustPBX server targets remain `not_run`; no resource
limit will be raised against a host carrying existing services. Pre/post
service snapshots and lower-source hashes are identical, and the temporary
container/mounts are absent. This was correctness-only: no load, soak, CPS,
concurrency, capacity or performance command ran.

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
