# G03 `.80` trusted recovered proof — local functional evidence

- Campaign: `converact-g03-80-d7e0b07-local-functional`
- Canonical base HEAD: `d7e0b07a7bf24728cb50afc839dab864cabede10`
- Candidate patchset: `ivekit.80`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack source: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- rustrtc source: `166c6d22984429eb6b509920c14fcd69f974f0b3`
- Candidate patch SHA-256: `b5bcf6a9f45dcd58f4d7dbafd9f97bcbe2df8c92f89c1c2708f48407f614eea8`
- Rust toolchain: `1.94.1-aarch64-apple-darwin`
- Evidence class: local functional only
- Production eligible: `false`
- Performance evidence: `false`

## Proven scope

The exact `.80` patch applies after `.79` and closes only the trusted
recovered-proof issuer component.

- The TypeScript takeover coordinator is a compatibility/fencing layer, not a
  Call Authority. It refuses takeover unless both authenticated capsule
  payloads are schema v2 and carry one identical canonical
  `NativeCallRecoveryBinding` hash.
- Rust opens the authoritative reciprocal A256GCM capsules, preserves the exact
  predecessor binding, derives the higher-owner-epoch successor identity and
  registers `NativeCallOwnerProof::Recovered { predecessor }` in both restored
  and finalization-only paths.
- Legacy v1, missing and split bindings fail closed. A request body, ordinary
  placement replay or one-leg value cannot self-declare recovery.
- The existing Unified RustPBX owner registry remains the sole Native Call
  Authority. No memory store, second registry, unbounded queue, per-Call task or
  fallback recovery path is added.

Exact-source local functional results:

- takeover coordinator suite: 10 passed, 0 failed;
- Rust dialog-shadow filter: 9 passed, 0 failed;
- exact trusted-proof Rust regression: 1 passed, 0 failed;
- full RustPBX library: 2,109 passed, 0 failed, 12 external-prerequisite tests ignored;
- locked Rust library check and scoped rustfmt: passed;
- exact patch application and static patch contracts: passed;
- repository TypeScript typecheck: passed;
- all 57 modified test files: 232 passed, 0 failed;
- G03 generated machine contracts: 9 passed, 0 failed.

## TDD provenance

The TypeScript RED test first produced 9 passes and one expected failure because
legacy/split capsule pairs were still claimable. The Rust RED build failed with
`E0425` because `recovered_native_call_authority` did not exist. GREEN added the
closed reciprocal-v2 gate and preserved predecessor/successor tuple.

The first repository typecheck after GREEN exposed a test-fixture literal
widening for `dialog_role`; annotating that fixture fixed the type error without
changing production behavior. The first aggregate modified-test run then had
231 passes and one stale `.79` machine-contract expectation; the expectation
was updated to the already generated `.80` truth and the canonical rerun passed
232/232. These failed development checks are retained here and are not reported
as passing product behavior.

## Evidence boundary

No server was contacted for `.80`; no running service, deployed source,
container, configuration, data, volume or port was read or changed. No Docker,
load, latency, CPS, concurrency, capacity, soak, allocation, 10K/100K or other
performance command ran.

The historical `.78` PostgreSQL result and `.79` recovered-admission result are
not relabelled as `.80` physical evidence. Real process restart reaching the
issuer and recovered capability Oracle, Active Call reconstruction, two-node
ambiguity recovery, live Endpoint activation, Linux product-process execution,
production eligibility, `G03-E15-REVIEW` and
`G03-E16-NATIVE-AUTHORITY` remain `not_run`.
