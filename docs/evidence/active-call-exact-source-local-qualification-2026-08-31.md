# Active Call exact-source local qualification — 2026-08-31

## Scope

This evidence covers only the source identity, local build and locally runnable tests for the
development candidate `active-call@6224d948cc0941ac48b4a5426477aeaf639c2e98`. It does not make the
candidate production-eligible and does not close dependency, license or runtime integration gates.

## Source identity

`scripts/verify-active-call-source.sh` independently checked the clean detached checkout and the
downloaded archive against `infra/converact/active-call/source-lock.json`:

```text
active-call source_identity=pass commit=pass tree=pass detached=pass clean=pass archive=pass size=pass files=pass manifests=pass
```

The check did not modify the pinned checkout.

## Exact archive build and tests

The verified archive was extracted into a newly created temporary directory. Rust `1.94.1` then
ran:

```text
cargo generate-lockfile
shasum -a 256 Cargo.lock
cargo test --locked
```

The generated dependency lock SHA-256 was:

```text
1a662959faa9c4449d99be6e037771fca9c31d9588fab001165aeab9542f7539
```

The exact source compiled successfully. Before Cargo stopped at the failing integration-test
binary, the observed result was 320 passed, 2 ignored and 2 failed tests. Both failures were in
`tests/sip_integration_test.rs`:

- `test_sip_invite_call` — external `sipbot` executable was not found;
- `test_sip_options_ping` — external `sipbot` executable was not found.

No source assertion failed. Because the external `sipbot` prerequisite was unavailable, the
overall upstream test gate is `blocked_external`, not passed. Test binaries ordered after that
failure by Cargo remain `not_run` in this evidence.

## Remaining gates

| Gate | Status | Reason |
| --- | --- | --- |
| source identity | passed | Checkout and archive matched the frozen lock. |
| local build | passed_local | The exact archive compiled with the generated lock. |
| upstream test suite | blocked_external | Two SIP integration tests require missing `sipbot`; later binaries are not proved. |
| dependency closure review | not_run | Lock generation is evidence, not an audit. |
| license review | not_run | Upstream declares MIT but the pinned tree has no license file. |
| Converact runtime integration | not_run | No deployed service or real call was changed or exercised. |
| production eligibility | false | Required review and integration gates remain open. |
