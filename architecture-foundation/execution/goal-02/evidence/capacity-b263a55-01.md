# G02 bounded control-plane capacity evidence

## Classification

- Evidence ID: `G02-E13-CAPACITY`
- Run ID: `capacity-b263a55-01`
- Status: `verified_controlled`
- `production_eligible`: `false`
- Scope: production `BoundedWorkGate` active/pending admission and actual retry/fanout overflow rejection
- Host class: one fixed validation host

This result proves only the bounded platform control primitive on the measured
host and exact source. It is not SIP, RTP, media, Bridge, recording, AI/GPU,
mixed-cell, fleet, region or production capacity evidence. It is not a basis
for linear extrapolation to VOS-EQ or 100K acceptance.

## Exact identity

| Field | Value |
| --- | --- |
| Binding Goal SHA-256 | `742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9` |
| Source commit | `b263a55a975704f852b53a3da6eaba711307b07b` |
| Incremental source bundle SHA-256 | `05f3f6cbb26c39924ecded39770f08173aa69b5128f6ca43943227b2ae3b23d5` |
| Harness config SHA-256 | `e264114cfa3bcffef4a33de025043aad7d7c47188dbe62bd8436fe0696b506b5` |
| Raw-output manifest SHA-256 | `0afc449f460f015d0e6d9e952af2aefbb31882eaebe83743ed9cfa1ddbe0b826` |
| Supplemental manifest SHA-256 | `f3dc4dc7aa5cfa7e5066fc29d555a0bad0fb6e36085e111976e36e00dd97d3e0` |
| Final evidence JSON SHA-256 | `283623e8096a172035899a212db479a65076e382ae7956778fc7aa073cb1b0d8` |
| Execution identity JSON SHA-256 | `32a9701089c5e18986b9a0a8963c21c77a43067daf0bbed23edb22b38380cb4a` |
| Node runtime reference | `node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` |
| Executed Node binary | `v24.18.0`; SHA-256 `41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c` |
| Host | `VM-0-3-ubuntu`; Linux 6.8.0-71-generic x86_64; 2 vCPU; 7.5 GiB RAM |
| Clock | UTC wall clock; Node monotonic performance clock; `kvm-clock` kernel clocksource |
| Started | `2026-08-01T23:57:48.530Z` |
| Completed | `2026-08-01T23:57:50.331Z` |

The incremental bundle required the already verified `b5c500d` validation
checkout, contained `b263a55` as `HEAD`, passed `git bundle verify`, and was
applied to a clean detached checkout. The campaign executed the same
`BoundedWorkGate` exported by the platform runtime; it did not use a substitute
benchmark implementation.

## Workload and observed result

| Metric | Result |
| --- | ---: |
| Total acquisition attempts | 2,000,000 |
| Accepted | 1,400,000 |
| Total bounded rejection | 600,000 |
| Active/pending saturation rejection | 400,000 |
| Retry-exhausted rejection (`retry=4`, limit `3`) | 100,000 |
| Fanout-exceeded rejection (`fanout=9`, limit `8`) | 100,000 |
| Duration | 1,070 ms |
| Configured active / observed maximum | 64 / 64 |
| Configured pending / observed maximum | 256 / 256 |
| Configured retry / maximum accepted / maximum attempted | 3 / 3 / 4 |
| Configured fanout / maximum accepted / maximum attempted | 8 / 8 / 9 |
| Configured / observed retained lease maximum | 320 / 320 |
| Requests queued at completion | 0 |
| Sampled decision P99 | 1.474 microseconds |
| Event-loop delay P99 | 18.629 ms |
| RSS start / peak / end | 85,671,936 / 94,875,648 / 92,569,600 bytes |
| Final active/pending counters | 0 / 0 |

The workload saturated both admission bounds, issued all three rejection
classes, and verified that retry/fanout rejection did not change admission
counters. Every request returned an immediate decision; retained leases never
exceeded the configured combined bound and all were released. Counter
integrity and the derived no-unbounded-queue assertion both passed.

## Independent-review remediation

Independent review rejected predecessor Run `capacity-b5c500d-01` because it
did not actually exercise retry/fanout overflow and its builder could promote
an input marked `failed`. Red tests reproduced both failures. Commit `b263a55`
requires `status=passed`, requires positive per-reason counts whose sum matches
the total, executes retry `4` and fanout `9`, verifies rejection leaves
admission counters unchanged, and derives the bounded-queue assertion from
immediate-decision and retained-lease measurements. This run is a complete new
execution on that exact source; predecessor raw material remains retained but
is explicitly `superseded_rejected`.

## Isolation and retained raw evidence

- All nine pre-existing containers were stopped before the run and remained
  stopped after it.
- Before/after snapshots are byte-identical with SHA-256
  `813f75653746be1a506520dea825fc8462595a207be99b072f1b72e9152ca4d0`.
- The campaign created, started, stopped and deleted no container, network or
  volume; the validation checkout remained clean.
- Both retained manifests pass `sha256sum -c`; the bounded evidence scanner
  passed on-host and a second scan passed after transfer.

Raw evidence is retained under
`architecture-foundation/execution/goal-02/evidence/raw/capacity-b263a55-01/`.
The aggregate dependency matrix, backup/restore, rolling drain/node loss, real
long Human Communication, region recovery, native fuzz/sanitizer safety and
all production eligibility remain `not_run`.
