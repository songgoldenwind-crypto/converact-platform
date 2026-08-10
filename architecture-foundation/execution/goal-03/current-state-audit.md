# G03 Current-state Audit

Date: 2026-08-02; exact-candidate update: 2026-08-10
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
| Durable effect ledger | `effect-oracle.ts`; `postgres-effect-store.ts`; migrations `107`, `113`, `114` and `115`; native `.59` protocol-observation, `.60` derived-ACK, `.61` peer-ingress, `.62` peer-derived CANCEL, `.63` UAS-2xx owner, `.64` owner-retention and `.66` stale-nonterminal recovery patches | Reference and native implementations use closed v1/v2 wire-attempt facts, keep `transport_completed` distinct from peer `protocol_observed`, and use atomic prepare/observation transactions, repair fences and resource-bounded fixed shards; `.60` derives one parent-bound non-2xx ACK and rejects an Unknown parent; `.61` requires a private Endpoint-minted proof before a network event can become peer evidence; `.62` consumes one pre-registered capability to durably send and replay the matched CANCEL 200; `.63` creates one bounded UAS 2xx owner; `.64` retains that owner through the product transaction; `.66` adds an exact-tenant/session/generation, successor-epoch-fenced, database-clock and 100-row-bounded transition from stale `send_attempted`/`transport_accepted` to honest `unknown`; the native adapter and recovery entrypoint remain default-disabled | retain TypeScript as contract/reference evidence; local component gates pass, while physical PostgreSQL crash-window proof, live successor-owner wiring, live Call Core capability registration and native RustPBX endpoint activation remain `not_run` |
| Recovery | `sip-foundation/recovery.ts`; reciprocal dialog shadow/takeover sources; `.65` Native Call recovery identity patch; `.66` stale SipEffect recovery patch; `.67` immutable-ledger fixture correction; `.68` role-scoped fixture correction; `.69` database-clock fixture | The closed v2 capsule authenticates one canonical Native Call binding across both legs and advances owner/generation/revision fences exactly once. The stale-effect primitive uses a rolling partial index and one atomic bounded batch to preserve uncertainty as `unknown`; the physical case now waits the real database stale window without mutating effect time or identity; legacy v1 remains readable but cannot resume live authority | retain the single RustPBX Native Call registry as Authority; `.69` live owner fencing and physical restart evidence, real process-crash/two-node takeover, early-dialog and cross-Adapter recovery remain `not_run` |
| RustPBX/rsipstack runtime | `infra/converact/rustpbx/build.sh` and patch queue | RustPBX `6c49ee76…`, rsipstack `8318e97b…`, rustrtc `166c6d22…`, patchset `.69` is pinned; `.66` layers default-disabled indexed stale-effect recovery over `.65`, `.67` makes clock aging revision-safe, `.68` removes the administrator effect write, and `.69` replaces clock rewriting with the real minimum stale wait | `.69` local exact-patch gates pass `186/186`, affected TypeScript gates pass `121/121`, the G03 contract passes `9/9`, and typecheck passes. Exact `.68` Linux passed the bounded unit and reached the `updated_at >= prepared_at` guard, proving the remaining shortcut invalid; corrected exact `.69` Linux/physical-PostgreSQL verification remains `not_run`. The retained `.65` server candidate `1d05333…` passed RustPBX `2,015/0/8`, dialog-shadow `20/20`, rsipstack `311/311` and doctests `67/67`; old services were externally restarted, so it is not performance evidence. `.63` remains rejected; `.69` image/wire/latency/peer/long-call/capacity evidence and production activation remain `not_run` |
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
incremental `.69` source preserves the `.66` runtime and replaces the rejected
fixture shortcuts with the real minimum database-clock stale wait. Its local
exact-patch gates pass `186/186`, affected TypeScript gates pass `121/121`, the
G03 contract passes `9/9`, and typecheck passes. Exact `.68` Linux passed the focused unit and then
correctly rejected a timestamp earlier than `prepared_at`; corrected exact `.69`
physical PostgreSQL, Linux full suite and live successor-owner composition have
not run. The
following remain `not_run`:

- native Call/Leg and effect-writer activation;
- live Call Core capability registration, live matched-CANCEL/UAS-2xx response
  composition and restart/reconcile resumption; the `.64` component paths alone
  do not activate them;
- process-crash recovery of an in-flight UAS 2xx owner;
- real process-crash/two-node Native Call takeover using the v2 capsule;
- parent-Unknown reconciliation and derived-ACK live endpoint composition;
- live and physical-PostgreSQL proof of the indexed stale
  `send_attempted`/`transport_accepted` recovery after an observer-process
  crash, plus mixed-binary v1/v2 activation;
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
9. Wire the current `.69` matched-CANCEL capability holder and UAS-2xx owner through the
   live Endpoint path and reconciliation resume; close parent-Unknown and
   stale-nonterminal/UAS-owner crash recovery before the default-disabled `.69`
   gate can enter live endpoint composition. The v2 recovery capsule must remain
   the only path that restores the existing canonical Native Call identity;
   legacy v1 capsules fail closed for live resume.

## 5. Deletion and Migration Boundary

G03 does not delete rsipstack, replace the RustPBX dependency graph, activate
rvoip, or move live calls. Deletion is deferred until G06 proves new-call selection,
old-call drain, active-zero, unknown/repair zero and rollback-window closure.
