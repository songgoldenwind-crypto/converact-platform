# G03 `.70` stale nonterminal recovery controlled evidence

Campaign ID: `converact-g03-stale-nonterminal-recovery-6abf714-11`

Captured: `2026-08-10T07:43:25Z`
Production eligible: `false`

## Scope

This bundle binds Converact Platform candidate
`6abf714ea8b71817e91fa9493e882c360050cf7f`, RustPBX
`6c49ee76baa54fdbf8f98020cc9bee158c7c15de`, rsipstack
`8318e97b1170de4e5245b120afec1cdf53e3d716` and rustrtc
`166c6d22984429eb6b509920c14fcd69f974f0b3` to patchset `ivekit.70`.

The focused physical test creates one `send_attempted` effect and one
`transport_accepted` effect through the production store, closes its pool,
waits the frozen database-clock stale interval, recreates the pool, and invokes
the exact-tenant/session/generation successor-fenced recovery batch. Each effect
must transition once to honest `unknown`; replay must return an empty batch;
claim and reconcile must still work after another pool recreation.

The test does not rewrite an effect timestamp, revision, identity, state or
constraint. The `.70` correction only gives the `unnest` input the distinct
`candidate_effect_id` name before the recovery `UPDATE ... RETURNING`. It does
not add a scan, task, allocation, lock, retry or state transition.

## Red-to-green result

Exact `.69` waited the real 31-second stale window and exposed PostgreSQL's
ambiguous-column error because both the target table and the update input used
`protocol_effect_id`. Its focused result was `1 passed; 1 failed`. Exact `.70`
retained the same database and test, changed only the candidate SQL identifier,
and passed `2/2` in `31.25s`. PostgreSQL emitted no ERROR, FATAL or PANIC during
the `.70` interval.

| Check | Exact result | Artifact |
| --- | --- | --- |
| local exact-patch contracts | `187 passed; 0 failed` | `verification.txt` |
| affected database/delivery gates | `117 passed; 0 failed` | `verification.txt` |
| G03 machine contract | `9 passed; 0 failed` | `verification.txt` |
| repository typecheck | exit `0` | `verification.txt` |
| exact `.69` physical RED | `1 passed; 1 failed`; ambiguous `protocol_effect_id` | `server-red.log` |
| exact `.70` physical GREEN | `2 passed; 0 failed`; `2,023` filtered; `31.25s` | `server-verify.log` |
| process boundary | pool close/recreate before recovery and before reconcile | exact Rust test bound by `source-manifest.txt` |
| final server boundary | nginx and all four PM2 applications stopped; only isolated healthy PostgreSQL running with no host port | `server-postflight.txt` |

## Environment disclosure

The exact runs used the pre-existing isolated PostgreSQL 16.14 container and a
Rust 1.94.1 offline build image on `ubuntu@101.42.7.139`. New source directories
were created for `.69` and `.70`; old source directories, stopped service
containers, images, volumes, databases and user data were not overwritten or
deleted. The only externally bound TCP listener in the final capture was SSH.

## Honest boundary

This is a controlled physical PostgreSQL proof for one recovery slice. It is
not a full RustPBX Linux suite, a real process crash, a two-node owner takeover,
live Call Core or Endpoint wiring, mixed-binary activation, image/wire
requalification, peer interoperability, long-call, fault/OOM, latency,
throughput, allocation or capacity evidence. Those items, live Native Authority,
`G03-E16-NATIVE-AUTHORITY`, independent final review and production eligibility
remain `not_run`.

No credential, authorization header, private key, token, database URL, secret
value or environment dump is retained in this bundle.
