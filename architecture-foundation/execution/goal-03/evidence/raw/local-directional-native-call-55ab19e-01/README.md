# G03 directional Native Call lifecycle — local component evidence

## Scope and status

- status: `verified_local_component`
- production eligibility: `false`
- canonical source base: `55ab19efb8cf916e44448ed8549ad151584d91b5`
- exact Rust patch base: `c1471a6de6b2aeb6acab9c1007d58c581b0554a7`
- target patchset: `restsend/rustpbx:0.3.16@ivekit.58`
- patch SHA-256: `8adc462074bf832307ce915ec65f271ee5d6883bc1f658537eb34b4ae8b4f202`
- date: `2026-08-09` (`Asia/Shanghai`)

This slice proves only the direction-aware UAS/UAC Native Call state model, immutable
authoritative leg direction, deterministic contract generation, and exact patch replay.
It does **not** promote SIP peer interoperability, long-call, crash/restart, host capacity,
latency distribution, or production eligibility; those remain `not_run` unless separately
bound by the G03 evidence index.

## TDD red observations

Before implementation, the focused TypeScript model tests failed because an inbound leg
could accept outbound `start_invite` and because the inbound events/states did not exist.
The exact Rust compile failed on the same missing directional variants. A separate registry
test then failed because a compatibility update could relabel an authoritative outbound Leg
as inbound. No runtime implementation was accepted until these failures were reproduced.

## Green verification

| Check | Result |
| --- | --- |
| TypeScript directional Call/Leg and static patch suite | `18 passed; 0 failed` |
| G03-related RustPBX/rsipstack/rustrtc static suite, including Call/Leg | `308 passed; 0 failed` |
| G03 machine-contract suite | `9 passed; 0 failed` |
| TypeScript typecheck | exit `0` |
| exact Rust Native Call tests | `11 passed; 0 failed` |
| exact Rust active registry tests | `24 passed; 0 failed` |
| exact RustPBX full library suite | `1980 passed; 0 failed; 5 ignored` |
| exact RustPBX binary check (`cross`, locked/offline) | exit `0` |
| exact RustPBX library Clippy (`cross`, locked/offline, no deps) | exit `0`; existing upstream warnings retained |
| patch forward apply on exact `.57` base | pass |
| patch `git diff --check` | pass |

## Environment

- host: Apple M5, arm64, Darwin 25.2.0
- Rust: `rustc 1.94.1 (e408947bf 2026-03-25)`, LLVM 21.1.8
- Node.js: `v23.11.0`
- npm: `10.9.2`
- Cargo target cache: local isolated target directory; no local Docker was used

## Explicit open evidence

- live SIP-effect activation for every direction: `not_run`
- real SIP peer and carrier interoperability: `not_run`
- long-call and protocol-completion observation campaign: `not_run`
- crash/restart, drain/active-zero, clock jump/skew campaign for this patchset: `not_run`
- host latency/capacity/fault campaign for `ivekit.58`: `not_run`
- production eligibility: `false`
