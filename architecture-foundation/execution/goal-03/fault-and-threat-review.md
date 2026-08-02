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
| request smuggling or parser differential | original bytes + hash, closed limits, conflicting singleton rejection, shared corpus | corpus created; Adapter differential replay `not_run` |
| Call-ID confused with business Call | distinct checked types and digest-derived Protocol Dialog ID | G03 unit evidence required |
| stale/split-brain owner | positive epoch, generation, expected revision and durable CAS | local logic/source tests; fleet partition `not_run` |
| duplicate visible effect | idempotency key + exact prepared bytes + receipt replay | local ledger tests; physical restart `not_run` |
| unknown send blindly retried | unknown state, query, repair lease/token/revision fence | local ledger tests |
| auth/SDP secret leak | raw values excluded from logs, metrics, evidence and error details | source review; runtime secret scan `not_run` |
| queue/connection exhaustion | hard capacities, deterministic 503/Retry-After, no unbounded waiter/task | local tests; host saturation distribution `not_run` |
| malicious object/accessor/proxy input | closed own-data snapshots and bounded copies | existing local SipFoundation tests |
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
- per-Call scans are bounded by hard Leg/Dialog limits;
- no request or timer path scans all Calls;
- no SIP/RTP message creates an unbounded task;
- retransmission reuses frozen bytes;
- metrics labels exclude tenant, Call ID, URI, phone, IP and raw cause text;
- durable store, object storage, Provider and general event bus never enter RTP
  packet processing.

CPU/allocation regressions still require same-source host evidence. Passing a
microbenchmark or citing rvoip upstream numbers cannot close that Gate.

## 6. Residual Risks

1. Current SipFoundation source is not proved as the elected live production
   writer path.
2. The complete wire corpus has not yet been captured through current rsipstack.
3. Physical PostgreSQL schema activation and crash replay have not run.
4. Native panic, process abort, OOM, disk/network loss and blocking-call
   campaigns have not run.
5. SIPp/real peers, long call and host performance evidence have not run.

All five remain visible in `evidence-index-v1.json` and prevent production
eligibility.
