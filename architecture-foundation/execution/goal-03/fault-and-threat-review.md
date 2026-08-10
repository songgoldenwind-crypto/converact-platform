# G03 Fault and Threat Review

Status: design review complete; dynamic fault campaigns tracked as `not_run`
Production eligibility: `false`

## 1. Protected Assets

- one Call/Leg/Business Dialog writer and its owner fence;
- prepared SIP bytes, route/candidate identity and effect receipts;
- tenant isolation and idempotency namespace;
- Protocol Dialog/transaction correlation;
- authentication, TLS and media-key confidentiality;
- existing Call availability under new-call overload;
- CDR and external-effect uniqueness.

## 2. Threats and Controls

| Threat | Required control | Current evidence boundary |
| --- | --- | --- |
| forged Edge metadata | strip all external internal headers; rebuild six allowed fields after strong Edge identity | contract/source only; live mTLS campaign not inherited |
| request smuggling or parser differential | original bytes + hash, closed limits, conflicting singleton rejection, shared corpus | exact `.53` rsipstack differential replay verified; future rvoip Adapter replay `not_run` |
| Call-ID, provider reference or UUID confused with business Call | distinct types; a module-issued projection adapter may attest an exact legacy tenant/ID match, but only native RustPBX may adopt the candidate; provider/SIP IDs never become CallId | local role/identifier tests; native binding `not_run` |
| stale/split-brain owner | positive epoch, generation, expected revision and durable CAS | local logic/source tests; fleet partition `not_run` |
| duplicate visible effect | idempotency key + exact prepared bytes + receipt replay | native isolated PostgreSQL transition/repair tests and restart verified; live SIP dispatch `not_run` |
| unknown send blindly retried | unknown state, query, repair lease/token/revision fence | `.57` native gate and ledger tests; live endpoint activation `not_run` |
| repair worker enumerates or takes cross-session authority | only an opaque/sealed crate-private minting surface can create the one-shot grant for one exact tenant/session/generation, one successor repair epoch and 1..100 exact ordered target IDs/revisions/identity hashes; worker cannot scan, mint/reuse epochs or send SIP | `.72` isolated local reconciler `28/28`, affected SipEffect `87 passed / 0 failed / 8 ignored` and sibling UI probes with expected `E0603`/`E0451`; live durable Authority issuer, physical PostgreSQL and activation `not_run` |
| partial/stale repair claim mutates an ambiguous subset | existing composite primary key exact-target lookup; one transaction returns exact claimed/exhausted IDs; any missing/stale/locked target is `FenceLost` and rolls back; true monotonic expiry includes queue dwell and freezes one whole-ms execution lease at dequeue; usable timeout is at most 29 s and remaining lease must be strictly greater than timeout + 500 ms | `.72` local source/tests only; physical PostgreSQL rollback and 10K/100K distractor query-plan proof `not_run` |
| cancelled or panicked reconciler accepts/reuses authority | reject submit after parent cancellation without queue-counter churn; a caught port panic cancels the reconciler child token, stops every repair worker and rejects new grants so shared dependencies are never reused; parent Call/Human Communication remains outside the child domain | `.72` local TDD only; process-crash/two-node and live supervision `not_run` |
| later batch failure erases confirmed progress | increment process-local reconciled/exhausted counters immediately after each confirmed durable reconcile/exhaustion, including before later transient, `Terminal`, permanent, panic, timeout or cancel outcomes | `.72` local TDD only; durable completion sink and restart-persistent metrics `not_run` |
| auth/SDP secret leak | raw values excluded from logs, metrics, evidence and error details | source review plus exact-campaign generated-secret scans passed |
| queue/connection exhaustion | hard capacities, deterministic 503/Retry-After, no unbounded waiter/task | `.58` local bounded-gate and direction-key tests plus the `.53` exact 2-vCPU 1000-CPS controlled step passed separately; `.58` host allocation and saturation frontier remain `not_run` |
| inbound UAS emits a local ACK or enters outbound fork selection | direction is part of the transition key; inbound 2xx waits in `awaiting_ack`; fork registration/selection is outbound-only | `.58` TypeScript/native focused tests; live endpoint activation remains `not_run` |
| malicious object/accessor/proxy input | closed own-data snapshots and bounded copies | existing local SipFoundation tests |
| async callback continues after registry failure | Call registry invokes no callbacks; only fenced bounded dequeue, supervised execution and fenced re-entry | G03 unit/source evidence required |
| fork winner leaves early sibling ringing | register every branch before INVITE; winner receipt contains bounded per-Leg CANCEL effects and atomically marks siblings terminating | G03 race unit evidence required |
| retransmitted 2xx revives a terminating winner | preserve `terminating`; emit one idempotent ACK-then-BYE effect under the same Call fence | G03 race unit evidence required |
| Adapter callback reenters open/drain | reserve ID/capacity before callback; opening reservation counts as active; same-ID reentry fails closed | G03 local reentrancy tests; host fault campaign `not_run` |
| schema downgrade or shadow writer | schema/writer registries disabled until activation receipt; exact writer role | source/migration tests; physical activation `not_run` |

## 3. Failure-domain Truth Table

| Failure | Allowed result | Forbidden claim |
| --- | --- | --- |
| one Call actor/event handler panic while process remains alive | contain failure, fence that Call's mutation, preserve other registry entries | automatic successful Call recovery without receipt |
| one Protocol worker panic | supervisor observes terminal worker result; existing unrelated Calls remain indexed | process-wide safety without native test |
| blocking DNS/store call | bounded deadline, reject new work, preserve established media | infinite wait or growing waiter list |
| durable store loss | 503 new Call; bounded repair; ordinary established RTPengine media may continue | business fact committed without durable ACK |
| Unified RustPBX abort/OOM/kill | control and in-process registry are lost; external RTPengine ordinary forwarding may continue degraded | “existing Call registry survives process OOM” |
| embedded media worker failure | only affected decode-required Edge may interrupt; ordinary external RTPengine Edge is independent | whole Call called healthy when mandatory Edge is broken |
| RTPengine loss | affected ordinary media interrupts and is reconciled | SIP control health renamed media continuity |

The single-process boundary has a hard physical limit: an unrecoverable OOM,
abort or kill cannot preserve in-process memory. G03 therefore proves only
worker/task containment inside a surviving process and durable reconstruction
after process loss. Any stronger claim would be false.

## 4. Native/Unsafe Gate

Before any rvoip/native/unsafe parser slice becomes eligible, it needs exact
source and features, ABI review, fuzz/sanitizer results, bounded allocation,
panic/segfault containment decision, core-dump policy, SBOM/provenance and an
independent review. G03 introduces no rvoip/native slice, so this remains
`not_run`, not “not applicable forever”.

## 5. Performance Abuse Review

- lookup tables are bounded and expected O(1);
- timer work is amortized O(1) or bounded O(log N);
- fork-winner and other per-Call scans are bounded by hard branch/Leg/Dialog
  limits (fork branches at most 32);
- no request or timer path scans all Calls;
- no SIP/RTP message creates an unbounded task;
- retransmission reuses frozen bytes;
- metrics labels exclude tenant, Call ID, URI, phone, IP and raw cause text;
- durable store, object storage, Provider and general event bus never enter RTP
  packet processing.

CPU/allocation regressions still require same-source host evidence. Passing a
microbenchmark or citing rvoip upstream numbers cannot close that Gate.

## 6. Residual Risks

1. TypeScript SipFoundation/effect source is a conformance/reference harness;
   the `.71` native composition and fixed observation supervisor are compiled,
   host-requalified but default-disabled, and therefore are not yet an elected
   live writer path.
2. Exact `.53` wire, raw latency, SIPp/Asterisk interop, two-hour SIP-control
   and 2-vCPU capacity regression campaigns passed; rvoip differential,
   allocation and multi-core scaling remain separate future Gates. The soak is
   not RTP/media, recording or quality evidence.
3. Native Call/Leg and all-direction SipEffect endpoint activation remains
   `G03-E16/not_run`; local adapter tests and controlled PostgreSQL replay do
   not close it.
4. Native panic, process abort, OOM, disk/network loss and blocking-call
   campaigns have not run.
5. Fault/OOM and complete host-performance evidence have not run for the exact
   `.72` candidate. Retained `.53` evidence is scoped to its exact source, and
   `.42` results remain historical only.
6. `.72` exact-target reconciliation remains default-disabled. Normal
   `FenceLost`/`Terminal` races are classified as superseded and keep healthy
   workers available. A caught port panic cancels the whole reconciler child
   domain, stops every repair worker and rejects new grants; parent-
   cancelled submission fails stopped, and process-local progress retains every
   confirmed durable reconcile/exhaustion even when later batch work fails.
   The authoritative issuer, durable completion sink,
   physical PostgreSQL exact-target/10K/100K plan, live Endpoint,
   process-crash/two-node and Linux full campaigns remain `not_run`.

All six remain visible in the G03 status artifacts and prevent production
eligibility.
