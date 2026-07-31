# Wave 1 HOMER HEP enabled/disabled A/B server validation

> Beijing report date: 2026-07-25
> Campaign UTC start: 2026-07-24T17:10:01Z
> Result: `controlled_failed`
> Capacity claim: `none`

## 1. Decision

The balanced same-hardware campaign closes the previously unexecuted HEP
enabled/disabled A/B gate without converting a shared-host observation into a
production capacity claim.

- At 400 CPS both disabled and enabled repetitions completed all 8,000 calls
  with zero failure, remaining call or retransmission. Enabled HEP persisted
  exactly 64,000 of 64,000 expected rows in both repetitions.
- At 700 CPS both disabled and enabled repetitions completed all 14,000 calls
  with zero failure, remaining call or retransmission. Enabled HEP persisted
  exactly 112,000 of 112,000 expected rows in both repetitions.
- At 900 CPS the first enabled repetition completed 17,988 of 18,000 calls,
  failed 12 calls and produced 624 retransmissions. The second enabled
  repetition completed all 18,000 calls without retransmission and persisted
  exactly 144,000 of 144,000 HEP rows, but route P95/P99 were
  151.003/330.006 ms and therefore exceeded the existing 150/250 ms route
  latency contract.

HEP is therefore functionally complete through the two clean 700-CPS
repetitions on this host. The 900-CPS point is not qualified. The campaign
also shows that always-on full SIP duplication has material CPU cost, so
production needs an explicit high-water shedding or trace-disable policy
before physical capacity qualification.

## 2. Fixed inputs

| Input | Value |
| --- | --- |
| Server | `64.225.122.227`, shared four-vCPU Linux boot domain |
| Campaign | `hep-ab-20260724T171001Z-1ffffe9a` |
| Duration / repetitions | 20 seconds / 2 |
| CPS points | 400, 700, 900 |
| Ordering | balanced; repetition 1 starts disabled, repetition 2 starts enabled |
| Calls | SIPp INVITE transaction ending in 486, no RTP |
| Expected HEP cardinality | 8 rows per successful clean call |
| Runner SHA-256 | `817b5bab99b36eacc957f36e45045d80b268ba60bef8e2e7e93120df8646c3dc` |
| SIPp binary SHA-256 | `8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef` |
| SIPp scenario SHA-256 | `970324a194b40851f5a651b6ef92335895c929050b6064b5352c7a4eb42798f8` |
| HEP enabled config SHA-256 | `a1a30cc203e01b5b865b84b54a4d87fd60594a69f75eaa3d8f42119bf2b801cb` |
| HEP disabled config SHA-256 | `2b5f273e6999ea26d64a2e063006fdc86f110270aa21e9e72c74591aacc6b482` |
| HOMER image | `sha256:fe0d45edc33c23b5047258690ca7ecf95bed93a164d7cfdb9ab499cbc83c893d` |
| HEP edge image | `sha256:7f07e0f0e5d5b1736f91b4e05a4ae984f7ed1511355b29318825b17bd7f2a762` |

The generator, HEP edge, HOMER, PostgreSQL, baseline Kamailio, RustPBX,
authenticated Router and CDR PostgreSQL all shared the same host. Resource
measurements can identify this campaign's local boundary, but cannot isolate a
single component's physical frontier.

## 3. Evidence rules

Each run used a campaign-unique Call-ID prefix. HEP rows were counted with
`session_id LIKE '<run-id>-%'`, so rows from earlier tests and background
traffic could not contaminate the result.

A clean functional repetition requires:

- expected successful calls;
- zero failed and remaining calls;
- zero retransmissions;
- exact Router and CDR deltas;
- a zero SIPp exit code;
- exact HEP cardinality when HEP is enabled.

Exact HEP cardinality is meaningful only when the SIP transaction has no
retry. Retransmissions can legitimately create more captured SIP messages than
the nominal eight rows per successful call. The first enabled 900-CPS
repetition therefore remains a failed call-path sample; its 144,650 rows
against a nominal 143,904 are not interpreted as HEP loss or duplication by
the collector.

The machine evaluator records functional checks. This report additionally
applies the existing route latency contract of P95 <= 150 ms and
P99 <= 250 ms; it does not rewrite the immutable machine evidence.

## 4. Raw results

| CPS | Rep | HEP | Calls | Failed / remaining | Retrans | Route P95 / P99 ms | HEP actual / nominal | Result |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 400 | 1 | disabled | 8,000 / 8,000 | 0 / 0 | 0 | 6 / 8 | 0 / 0 | pass |
| 400 | 1 | enabled | 8,000 / 8,000 | 0 / 0 | 0 | 9 / 14 | 64,000 / 64,000 | pass |
| 400 | 2 | disabled | 8,000 / 8,000 | 0 / 0 | 0 | 6 / 10 | 0 / 0 | pass |
| 400 | 2 | enabled | 8,000 / 8,000 | 0 / 0 | 0 | 11 / 16.001 | 64,000 / 64,000 | pass |
| 700 | 1 | disabled | 14,000 / 14,000 | 0 / 0 | 0 | 72.001 / 159.002 | 0 / 0 | pass |
| 700 | 1 | enabled | 14,000 / 14,000 | 0 / 0 | 0 | 61.001 / 99.002 | 112,000 / 112,000 | pass |
| 700 | 2 | disabled | 14,000 / 14,000 | 0 / 0 | 0 | 29.001 / 46.001 | 0 / 0 | pass |
| 700 | 2 | enabled | 14,000 / 14,000 | 0 / 0 | 0 | 34.001 / 65.001 | 112,000 / 112,000 | pass |
| 900 | 1 | disabled | 18,000 / 18,000 | 0 / 0 | 0 | 230.004 / 645.011 | 0 / 0 | latency failed |
| 900 | 1 | enabled | 17,988 / 18,000 | 12 / 0 | 624 | 846.014 / 1,650.03 | 144,650 / 143,904 | failed |
| 900 | 2 | disabled | 18,000 / 18,000 | 0 / 0 | 0 | 31.001 / 80.001 | 0 / 0 | pass |
| 900 | 2 | enabled | 18,000 / 18,000 | 0 / 0 | 0 | 151.003 / 330.006 | 144,000 / 144,000 | latency failed |

## 5. A/B aggregates

The latency values below are medians of two repetitions. CPU values are the
mean of each repetition's maximum Docker CPU sample and are diagnostic only.

| CPS | Disabled P95 / P99 ms | Enabled P95 / P99 ms | P95 / P99 delta | HEP-edge CPU disabled / enabled | HOMER CPU disabled / enabled |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 400 | 6 / 9 | 10 / 15.001 | +4 / +6.001 ms | 42.385% / 61.515% | 8.615% / 56.605% |
| 700 | 50.501 / 102.502 | 47.501 / 82.002 | -3 / -20.5 ms | 83.270% / 88.325% | 14.140% / 67.200% |
| 900 | 130.503 / 362.506 | 498.509 / 990.018 | +368.006 / +627.512 ms | 85.625% / 94.645% | 11.885% / 78.115% |

At 400 CPS the order-balanced samples are stable enough to attribute a local
HEP overhead of approximately 4 ms at P95 and 6 ms at P99. The HEP edge's
average maximum CPU rises by 19.13 percentage points and HOMER's by 47.99
points.

At 700 CPS the HEP edge already averages 83.27% maximum CPU when tracing is
disabled and 88.325% when enabled. The apparent negative latency delta changes
with repetition order and is not a performance improvement; it is shared-host
variance close to saturation. The valid conclusion is call and HEP
completeness, not a precise latency advantage.

At 900 CPS both the disabled and enabled samples vary widely. One enabled
sample fails calls and retransmits, while the other exceeds the route latency
contract. This point is rejected.

## 6. Operational decision

1. HEP remains fail-open and outside SIP/RTP admission and readiness.
2. Full trace can remain enabled for controlled validation and moderate load.
3. Production must expose low-cardinality HEP queue/drop/high-water metrics
   and disable or sample trace before the edge reaches its safe CPU reserve.
4. A trace transition must not restart or drain established SIP/RTP sessions.
5. A later independent-host campaign must repeat the A/B with long steady
   windows before assigning a production safe CPS.

After the campaign, the active HEP edge configuration was restored to the
enabled SHA-256 above with mode/owner `0600:10001:10001`. HOMER, its PostgreSQL
catalog and the HEP edge were running with restart count zero and no OOM.

## 7. Evidence

| Artifact | SHA-256 |
| --- | --- |
| `wave1-homer-hep-ab-server-validation-2026-07-25.json` | `7a59272bf78584bd2cb9ea7b6aedecc90942c9cd09b8ea1c0dca5064e229a17c` |

The immutable server evidence remains at:

```text
/opt/opc-wave123-validation-20260722/runtime/
  homer-hep-ab-formal-clean-20260725-170957/
```

## 8. Remaining gates

The following remain `not_run` and are not implied by this A/B. Isolated
retention and compaction are covered separately by
`wave1-homer-retention-compaction-server-validation-2026-07-25.md`.

- HEP high-water shedding, rate limit, deliberate packet loss and live trace
  transition;
- long soak and PostgreSQL writer failover;
- independent generator/SUT hosts and a production safe-capacity frontier;
- target Kubernetes, dual Zone and multi-Cell deployment;
- Cell-10K, MIX-100K, multi-architecture Registry publication, SBOM, signature
  and provenance.
