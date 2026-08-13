# G03 Current-state Audit

Date: 2026-08-02; exact-candidate update: 2026-08-14
Binding Goal: `G03` / `05ce7f940782ab0efcd013d413220d068a7d3be1bab981f2c2c4f6a6f2a217af`
Production eligibility: `false`

## 1. Entry Gate

G03 uses the later user-authorized gate-only amendment
`GATE-AMENDMENT-G02-G03-2026-08-02-V1`. G02's platform-foundation development
Gate is complete at `16ab4af98c5f3b453ad3d9bdd1ae5fe959a37720`; G02 remains
`blocked_external` for `G02-E09/E12/E14/E15`. G03 does not inherit those
claims and this audit does not mark G02 complete or production eligible.

## 2. Observed Current Implementation

| Slice | Exact current source | Observed status | G03 disposition |
| --- | --- | --- | --- |
| Product Call model | `src/agent-runtime/converact/voice/types.ts`; `state-machine.ts`; `call-service.ts` | `VoiceCall` is a durable Call intent/rebuildable control-plane projection with legacy string IDs | preserve product behavior, but never treat it or `provider_call_id` as native Call/Leg authority |
| SipFoundation seam | `src/agent-runtime/converact/voice/sip-foundation/*` | Exported Converact-owned types, bounded Protocol Session model, capability selection, route/wire binding and rsipstack-named conformance Adapter exist | retain as conformance/migration harness; native SIP authority stays inside RustPBX |
| Durable effect ledger | `effect-oracle.ts`; `postgres-effect-store.ts`; migrations `107`, `113`, `114` and `115`; native `.59` protocol-observation through `.72` exact-target reconciler supervision | Reference and native implementations use closed v1/v2 wire-attempt facts, separate transport and peer terminal meanings, atomic observation transactions, repair fences and bounded shards. `.66` adds successor-fenced stale-nonterminal recovery; `.71` gives each observation shard one fixed task. `.72` adds a separately default-disabled fixed-worker reconciler that accepts only an opaque, sealed, crate-private grant for one exact tenant/session/generation, one successor repair epoch and 1..100 exact ordered targets. The live durable Authority issuer remains `not_run`. The reconciler uses the existing composite primary key for bounded exact lookup and cannot scan, enumerate, mint/reuse an epoch or send SIP. Both in-memory and PostgreSQL claim paths validate the same maximum 512-byte `SipEffectRepairFence` | `.72` exact-source component tests pass `28/28`, the affected SipEffect suite passes `87 passed / 0 failed / 8 ignored`, and locked library check plus Rust formatting pass. The same focused test counts pass offline on the authorized Linux host under `evidence/raw/focused-linux-sip-effect-b3c9da0-14/`. Two sibling-module UI probes prove the sealed minting boundary with expected `E0603` and `E0451` compile failures. These results do not promote an evidence entry. Physical PostgreSQL exact-target claim, 10K/100K distractor query plans, authoritative issuer, durable completion sink, live Endpoint, process-crash/two-node, Linux full, fault/performance and production remain `not_run` |
| Recovery | `sip-foundation/recovery.ts`; reciprocal dialog shadow/takeover sources; `.65` Native Call recovery identity patch; `.66` stale SipEffect recovery patch; `.67` immutable-ledger fixture correction; `.68` role-scoped fixture correction; `.69` database-clock fixture; `.70` recovery SQL alias | The closed v2 capsule authenticates one canonical Native Call binding across both legs and advances owner/generation/revision fences exactly once. The stale-effect primitive uses a rolling partial index and one atomic bounded batch to preserve uncertainty as `unknown`; the physical case waits the real database stale window without mutating effect time or identity, and `.70` separates the unnest candidate id from the target table id before `RETURNING`; legacy v1 remains readable but cannot resume live authority | controlled `.70` stale-nonterminal pool-recreation recovery is under `evidence/raw/stale-nonterminal-recovery-6abf714-11/`; live owner fencing, real process-crash/two-node takeover, early-dialog and cross-Adapter recovery remain `not_run` |
| RustPBX/rsipstack runtime | `infra/converact/rustpbx/build.sh` and patch queue | RustPBX `6c49ee76…`, rsipstack `8318e97b…`, rustrtc `166c6d22…`, patchset `.74` is pinned. `.73` retains the matched-CANCEL pair; `.74` adds one Native Call-owned, default-disabled transaction-local gate for ordinary initial inbound-INVITE responses. Call-ID, INVITE CSeq, From, top Via, To base and one authority-generated local To tag are frozen before response finalization. Responses 101..699 require exact transaction and canonical wire binding; multiple provisional responses may precede one final. The builder field remains `None`; no product config or Endpoint-global gate activates it | `.74` focused functional checks pass Native response capability `17/17`, Native Call `13/13`, Active Call registry `24/24`, durable gate `39/39`, locked library check and scoped rustfmt. Full RustPBX `.74`, physical PostgreSQL, live Endpoint and isolated server functional verification remain `not_run`. The earlier zero-impact `.73` Linux rsipstack result `32/32` and unchanged service/source snapshots remain bound only to `.73`; `.74` does not inherit them. Successor-safe cleanup fencing, restart capability reconstruction, all performance/load/capacity/soak work and production eligibility remain `not_run` |
| Initial 100 Trying | `rsipstack-ivekit-single-trying.patch`; SIPp campaign sources | Exact `.53` image emitted exactly 100 Trying responses for 100 INVITEs; p99/max were 1/1 ms, with zero response retransmissions | `G03-E06` controlled evidence; no inherited `.42` promotion |
| SIP wire tests | frozen 22-case corpus and exact dual-binary replay | `.53` matches all 18 accepted semantics and applies four versioned malformed-input tightenings with zero unexplained differences | `G03-E07` controlled evidence; future rvoip differential remains `not_run` |
| rvoip runtime | no G03 runtime source dependency found | Not a parser, transaction, Dialog or transport production path | `not_run`; reserved for G06 layer-by-layer gates |

The TypeScript SipFoundation code arrived through commit `385521c` and its
PostgreSQL boundary was retained/hardened in later commits including `6c5d998`.
A source search finds the namespace export in `voice/index.ts`, but no current
`VoiceCallService` construction path elects `SipEffectOracle` as a live native
writer. The `RsipstackFoundationAdapter` materializes and validates model wire
facts; it does not parse or send production SIP. Therefore these files are
conformance/reference source, not proof of an activated production path.

## 3. Baseline Check

Before G03 implementation, the focused source and unit suite ran 103 tests with
103 passes and zero failures. It covered the TypeScript SipFoundation, effect
ledger, recovery eligibility, exact-source RustPBX/rsipstack patch contracts,
dual-leg CDR and dialog recovery. This is a local source/unit baseline only.

The controlled PostgreSQL role/RLS/restart replay and exact `.53`
wire/latency/interop/two-hour-control-call/2-vCPU capacity campaigns have run.
For `.59`, the fresh patch chain, exact RustPBX suite and six physical
PostgreSQL cases remain retained under
`evidence/raw/native-protocol-observation-fe4c38b-05/`. The `.60` exact sources
pass rsipstack `302/302`, RustPBX `2,002` passed with `0` failed and `8` ignored,
and the physical PostgreSQL atomic-derived-ACK case `1/1` on the authorized
isolated validation host. Its raw bundle is
`evidence/raw/derived-non-2xx-ack-9fc99ee-06/`. The incremental `.61` source
passes rsipstack `303/303`, its `67/67` compile-fail/doctest suite and RustPBX
`2,002/0/8` on the authorized server; its raw bundle is
`evidence/raw/peer-ingress-proof-701475a-07/`. None of these bundles proves live
endpoint composition or inherits `.53` image and traffic results. The `.62`
incremental source then passes rsipstack `306/306`, its `67/67`
compile-fail/doctest suite and RustPBX `2,006/0/8`; its component-only raw
bundle is `evidence/raw/peer-derived-cancel-56e0d42-08/`. The `.63` incremental
source passes local rsipstack `309/309`; its authorized-server rsipstack suite
and doctests pass, but the full RustPBX build fails because the product owner
does not cover `Uas2xxDeadlineExpired`. The `.64` retention fix is red/green
tested and passes rsipstack `311/311`, doctest `67/67`, and RustPBX
`2,008/0/8` both locally and on the authorized server. Its controlled raw
bundle is `evidence/raw/uas-2xx-retention-a85d249-09/`. The incremental `.65`
source passes the local exact-patch/static gates `191/191`, TypeScript capsule
tests `9/9`, the repository typecheck, and authorized-server exact-source
candidate `1d05333…`: RustPBX `2,015/0/8`, dialog-shadow integration `20/20`,
rsipstack `311/311` and doctests `67/67`. Its component-only bundle is
`evidence/raw/native-call-recovery-1d05333-10/`. An external mechanism restarted
old services during the run, so no performance claim is inherited. The
incremental `.70` source preserves the `.66` runtime, retains the real minimum
database-clock stale wait, and gives the update input its own candidate id. Its
local exact-patch gates pass `187/187`, affected TypeScript gates pass `121/121`,
the G03 contract passes `9/9`, and typecheck passes. Exact `.69` Linux passed the focused unit and real
stale wait, then stopped on PostgreSQL's ambiguous-column guard; corrected exact `.70`
passed the focused PostgreSQL recovery tests `2/2` in `31.25s`. Linux full suite
on the same exact `.70` source then passed RustPBX `2,016/0/9`, rsipstack
`311/311` and doctests `67/67` on the authorized server. The rsipstack run used
an isolated vendor copy after all 47 lockfile packages missing from the older
RustPBX vendor were verified against their exact Cargo.lock SHA-256; neither
lockfile nor the original vendor changed. The controlled bundle is
`evidence/raw/full-linux-suites-6abf714-12/`. Live successor-owner composition
has not run. Incremental `.71` now adds one fixed supervisor task per observer
shard. Its focused Rust tests pass `38/38`, exact patch gates pass `189/189`,
the G03 contract passes `9/9`, and typecheck passes. Its controlled Linux
component campaign passes RustPBX `2,022/0/9`, three focused regressions,
dialog-shadow `20/20`, rsipstack `311/311` and doctests `67/67`; raw logs,
including the first cache miss and the redundant network-component attempt,
are retained under `evidence/raw/full-linux-suites-1ebbd76-13/`. This is host
component requalification only and makes no live or process-crash claim.
Incremental `.72` adds a separately default-disabled exact-target reconciler.
Its fixed configured worker count and bounded queue accept an opaque, sealed,
crate-private one-shot grant scoped to one tenant, Protocol Session, generation
and successor repair epoch with 1..100 strictly ordered unique effect targets.
Each target binds its expected revision and identity hash; the claim returns
exact claimed and exhausted IDs. The existing
`(tenant_id, protocol_effect_id)` primary key provides bounded exact lookup
without tenant/session/global scans. Minting freezes a true monotonic expiry;
queue dwell consumes that window, and dequeue freezes one whole-millisecond
execution lease for the claim. Configured timeout is capped at a usable 29 s
and execution requires remaining lease strictly greater than timeout plus
500 ms. Submission after parent cancellation is rejected. A caught store or
oracle panic cancels the reconciler child supervision domain, stops all repair
workers and rejects future grants, so no worker reuses the shared dependencies;
the parent process and established Human Communication remain outside that
child cancellation. Process-local progress counts
advance after each confirmed durable reconcile or exhaustion and retain that
truth if later batch work fails transiently, terminally, permanently, by panic,
timeout or cancellation. Ordinary `FenceLost` or `Terminal` races consume the
superseded grant and keep the healthy reconciler workers available. Exact-source
`.72` tests pass `28/28`, the affected SipEffect suite passes
`87 passed / 0 failed / 8 ignored`, and locked library check plus Rust
formatting pass. The same two test counts and scoped formatting pass in the
offline controlled Linux campaign retained under
`evidence/raw/focused-linux-sip-effect-b3c9da0-14/`. No evidence entry is
promoted by these component results. The following remain `not_run`:

- native Call/Leg and effect-writer activation;
- product activation of the `.73` Native Call capability runtime, RustPBX-host
  matched-CANCEL execution and restart/reconcile resumption. The isolated
  Linux rsipstack server-transaction target passes `32/32`, but RustPBX host
  targets remain `not_run` after their lib-test compile reached the fixed
  2,560 MiB isolation ceiling. The Rust session composition exists but its
  builder entry remains default-disabled; UAS-2xx remains a separate
  unactivated owner path;
- `.74` ordinary response live Endpoint activation, physical PostgreSQL and
  isolated server functional verification. Local focused tests prove exact
  authority ordering, multiple provisional responses, one final response,
  frozen dialog identity, cancellation ambiguity and concurrent-revision
  `TransportUnknown`; they do not prove a deployed call path. The isolated
  `9775a79` attempt applied exact patches but executed no test because the
  RustPBX lib-test compile reached its 3,584 MiB cgroup and was killed. The
  ceiling was not raised; service and lower-source snapshots remained
  byte-identical. Raw attempt evidence is retained under
  `isolated-server-native-response-9775a79-16/` and the Gate stays `not_run`;
- process-crash recovery of an in-flight UAS 2xx owner;
- physical PostgreSQL `.72` exact-target claim/rollback and 10K/100K distractor
  query-plan proof;
- authoritative repair-grant issuer and durable per-target completion sink;
- real process-crash/two-node Native Call takeover using the v2 capsule;
- parent-Unknown reconciliation and derived-ACK live endpoint composition;
- live proof of indexed stale `send_attempted`/`transport_accepted` recovery
  after an observer-process crash, plus mixed-binary v1/v2 activation; the
  controlled pool-recreation case is proved but is not a real process crash;
- node loss, blocking syscall, native panic, OOM and process-abort campaigns;
- allocation and 2/4/8-core scaling (the retained 2-vCPU capacity result is a
  controlled regression baseline, not the complete performance Gate);
- carrier-specific interoperability beyond the retained SIPp and Asterisk peer;
- production eligibility.

## 4. Gaps to Close in G03

1. Strongly distinguish `CallId`, `LegId`, `ProtocolDialogId`, `TransactionId`,
   `MediaSessionId` and `InteractionId` while accepting current Call ID strings
   through an explicit compatibility boundary.
2. Keep the bounded TypeScript Leg model as conformance evidence, then bind the
   same semantics to the sole native RustPBX Call/Leg authority without a
   second active registry.
3. Expose the receipt semantic difference between local acceptance, primary
   protocol completion and state observed after `unknown` reconciliation.
4. Make Protocol Session drain reject new sessions, preserve old sessions and
   expose active-zero without forced hangup.
5. Freeze the complete raw-byte corpus and its hashes.
6. Bind all 143 G00 rows assigned to G03 exactly once, without evidence
   promotion.
7. Activate and prove the compiled Native Call/Leg control port and default-
   disabled SipEffect gate across every SIP direction; until then
   `G03-E16-NATIVE-AUTHORITY` stays `not_run`.
8. Wire only direction-specific protocol observations: inbound 2xx waits for a
   remote ACK, outbound 2xx creates a local ACK effect, and inbound Legs can
   never enter outbound fork selection.
9. `.73` wires the matched-CANCEL capability holder into the Rust session path
   behind a default-disabled builder entry. The zero-impact isolated Linux
   campaign proves the rsipstack server target `32/32`, with identical
   pre/post service and lower-source hashes; RustPBX host targets remain
   `not_run` under the safe memory ceiling. `.74` now wires ordinary 101..699
   response authority into the same default-disabled transaction-local gate,
   freezes one dialog identity and keeps ambiguous durable work for reconcile.
   Next close UAS-2xx and reconciliation resume. Close parent-Unknown and stale-
   nonterminal/UAS-owner crash recovery before product activation. The v2
   recovery capsule must remain the only path that restores the existing
   canonical Native Call identity; legacy v1 capsules fail closed for live
   resume.
10. Bind the `.72` reconciler to the durable Call/session Authority only after
    an exact grant issuer and durable per-target completion sink exist. Prove
    physical PostgreSQL all-or-nothing claims and 10K/100K distractor query
    plans before activation; local component tests cannot close those Gates.

## 5. Deletion and Migration Boundary

G03 does not delete rsipstack, replace the RustPBX dependency graph, activate
rvoip, or move live calls. Deletion is deferred until G06 proves new-call selection,
old-call drain, active-zero, unknown/repair zero and rollback-window closure.
