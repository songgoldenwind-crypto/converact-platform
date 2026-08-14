# G03 `.83` recovered-admission cleanup deadline — local functional evidence

- Campaign: `converact-g03-83-d86e23a-local-functional`
- Captured UTC: `2026-08-14T05:41:52Z`
- Canonical base HEAD: `d86e23a575e7446857c7248fec0c95e6e4eb33c7`
- Candidate patchset: `ivekit.83`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Candidate patch SHA-256: `489c4400fad54ac4062baf8a75e472a8e4e5016263f42c852e4f26df5268d34b`
- Rust toolchain: `1.94.1-aarch64-apple-darwin`
- Evidence class: local functional and source only
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.83` patch applies after `.82` and closes the remaining unbounded
media wait on recovered Active Call admission rejection.

- Invalid recovered-controller input and Active Call registry rejection both
  route media close through one private deadline helper.
- Production uses the existing 2-second recovered-media cleanup deadline.
  Successful cleanup and dependency-error handling are preserved; a stuck wait
  is cancelled and the original admission error returns so outer Dialog and
  owner cleanup can continue.
- Controller termination also uses the same helper, leaving one deadline
  primitive rather than two divergent implementations.
- No retry, worker, queue, Call registry, store, alternate Authority, global
  scan, ordinary new-Call hot-path work or media packet-path work is added.

Exact-source local results:

- focused deadline behavior regression: 1 passed, 0 failed;
- Rust dialog-shadow module: 12 passed, 0 failed;
- full RustPBX library: 2,114 passed, 0 failed, 12 external-prerequisite tests ignored;
- locked Rust library check and scoped rustfmt: passed;
- exact patch replay and candidate/source byte comparison: passed;
- affected current-patch static suite: 232 passed, 0 failed across 59 files;
- G03 generated machine contracts: 9 passed, 0 failed;
- repository TypeScript typecheck: passed.

## TDD provenance

The test-first regression references
`recovered_media_cleanup_before_deadline`. The first temporary compile attempt
could not resolve the copied candidate's sibling path dependencies; it is a
harness failure and proves no product behavior. After restoring the same pinned
rsipstack/rustrtc links, canonical RED failed with `E0425` because the helper
did not exist. GREEN proves an immediately completed Future and a pending
Future cancelled at a short test deadline, then binds production admission
cleanup to the frozen 2-second constant.

The first static rerun exposed one test that inspected only added patch lines
and four stale `.82`/2,113 generated-result expectations. The patch parser was
corrected to inspect unchanged context separately, and only the four expected
values were advanced to the already compiled `.83` truth. Canonical rerun
passed 232/232.

## Evidence boundary

Cancellation of the local Future does not prove that an external media service
releases an already created resource. No server was contacted for `.83`; no
running service, deployed source, container, configuration, data, volume or
port was read or changed. No Docker, load, latency, CPS, concurrency, capacity,
soak, allocation, 10K/100K or other performance command ran.

External media orphan reconciliation, live Endpoint rejection, real
task/process fault/OOM, real process restart/two-node takeover,
original-INVITE Oracle activation, Linux product-process execution, production
eligibility, `G03-E15-REVIEW` and `G03-E16-NATIVE-AUTHORITY` remain `not_run`.
