# G02 bounded control-plane capacity evidence

## Classification

- Evidence ID: `G02-E13-CAPACITY`
- Run ID: `capacity-b5c500d-01`
- Status: `superseded_rejected`
- `production_eligible`: `false`
- Scope: production `BoundedWorkGate` active/pending admission plus retry/fanout rejection
- Host class: one fixed validation host

This run is retained only for failed-attempt transparency. Independent review
rejected it because the workload never attempted retry or fanout overflow and
the former evidence builder did not require an input `passed` status. It is
not accepted evidence and is not referenced by `G02-E13-CAPACITY`.

This result proves only the bounded platform control primitive on the measured
host and source. It is not SIP, RTP, media, Bridge, recording, AI/GPU,
mixed-cell, fleet, region or production capacity evidence. It is not a basis
for linear extrapolation to VOS-EQ or 100K acceptance.

## Exact identity

| Field | Value |
| --- | --- |
| Binding Goal SHA-256 | `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9` |
| Source commit | `b5c500da0ec82d54d2476aa8d7ffc917dc07dd43` |
| Base source bundle SHA-256 | `7e249fa2f5d7ef50ecdb733ba45d98095a1ab6c4394d303440be8e4614b5dc0b` |
| Fix source bundle SHA-256 | `2b949d6ba6658c17064c72078fad318a12d1d37340a89ae5401f2088a7235119` |
| Harness config SHA-256 | `75c23655df8f84af715b16a7d87e22653a4cc58c42da77426149e67843cf5451` |
| Raw-output manifest SHA-256 | `e591d28532177078c3e03b0ab842964ab85332cea3c8d7b52492d75e0b4c01d9` |
| Supplemental manifest SHA-256 | `9e13c1b39f26630c478748aed18399c75ef3368fde0bdc9e4f71cbf218f0de0e` |
| Final evidence JSON SHA-256 | `c607b63e743662a438badd50944b5e7c3b2a8802676bdc4b184ebbfe8b07f15d` |
| Execution identity JSON SHA-256 | `da7cac88d1754e5f4acc38fdbfd595d6d14fcf13fc2acb88335ef0c1efd534d2` |
| Node runtime reference | `node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Executed Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T23:36:00.196Z` |
| Completed | `2026-08-01T23:36:02.072Z` |

Both incremental bundles matched locally and remotely, passed `git bundle
verify`, and were applied to a clean detached validation checkout. The
campaign executed the same `BoundedWorkGate` exported by the platform runtime;
it did not use a substitute benchmark implementation.

## Workload and observed result

| Metric | Result |
| --- | ---: |
| Total acquisition attempts | 2,000,000 |
| Accepted | 1,600,000 |
| Bounded rejection | 400,000 |
| Duration | 1,224 ms |
| Configured active / observed maximum | 64 / 64 |
| Configured pending / observed maximum | 256 / 256 |
| Configured retry / observed maximum | 3 / 3 |
| Configured fanout / observed maximum | 8 / 8 |
| Sampled decision P99 | 1.615 microseconds |
| Event-loop delay P99 | 14.115 ms |
| RSS start / peak / end | 69,386,240 / 78,884,864 / 77,881,344 bytes |
| Final active/pending counters | 0 / 0 |

The workload first saturated both active and pending bounds, issued bounded
rejections while saturated, released every opaque lease, and then exercised
accepted acquire/release decisions through the remaining attempts. Retry and
fanout overflow are rejected before consuming active or pending capacity.
Counter integrity and the no-unbounded-queue assertion both passed.

## Isolation and failed-attempt disclosure

- All nine pre-existing containers were stopped before the run and remained
  stopped after it.
- Before/after container snapshots are byte-identical with SHA-256
  `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0`.
- The Campaign did not create, start, stop or delete containers, networks or
  volumes; the repository remained clean.
- Earlier Run ID `capacity-0eb7e88-01` failed after the workload, before
  execution identity/final evidence generation, because the hardware-identity
  `awk` format string was over-escaped. It was not accepted or relabelled. A
  failing regression test reproduced the defect; commit `b5c500d` fixed it and
  this new Run ID performed the complete rerun.

## Retained raw evidence

The repository retains the four raw-manifest artifacts plus final evidence,
identity and supplemental manifest under
`architecture-foundation/execution/goal-02/evidence/raw/capacity-b5c500d-01/`.
Both retained manifests pass `sha256sum -c`; the bounded evidence scanner
passed before finalization and a second local scan passed after transfer.

This run does not promote any Evidence status. The following remain `not_run`:
the aggregate dependency matrix,
backup/restore, rolling drain/node loss, real long Human Communication, region
recovery, native fuzz/sanitizer safety and all production eligibility.
