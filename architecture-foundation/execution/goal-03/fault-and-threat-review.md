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
| unknown send blindly retried | unknown state, query, repair lease/token/revision fence | local ledger tests |
| auth/SDP secret leak | raw values excluded from logs, metrics, evidence and error details | source review plus exact-campaign generated-secret scans passed |
| queue/connection exhaustion | hard capacities, deterministic 503/Retry-After, no unbounded waiter/task | `.53` native suites and exact 2-vCPU 1000-CPS controlled step passed; allocation and saturation frontier remain `not_run` |
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

1. TypeScript SipFoundation/effect source is a conformance/reference harness,
   not the elected live native writer path.
2. Exact `.53` wire, raw latency, SIPp/Asterisk interop, two-hour SIP-control
   and 2-vCPU capacity regression campaigns passed; rvoip differential,
   allocation and multi-core scaling remain separate future Gates. The soak is
   not RTP/media, recording or quality evidence.
3. Native Call/Leg and SipEffect port activation remains `G03-E16/not_run`;
   controlled PostgreSQL reference replay does not close it.
4. Native panic, process abort, OOM, disk/network loss and blocking-call
   campaigns have not run.
5. Fault/OOM and complete host-performance evidence have not run for the exact
   `.53` candidate. Retained `.42` results remain historical only.

All five remain visible in `evidence-index-v1.json` and prevent production
eligibility.
