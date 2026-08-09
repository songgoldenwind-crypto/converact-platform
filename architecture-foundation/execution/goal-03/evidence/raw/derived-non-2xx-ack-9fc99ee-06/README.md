# G03 `.60` derived non-2xx ACK controlled evidence

Campaign ID: `converact-g03-derived-non-2xx-ack-9fc99ee-06`

Captured: `2026-08-09T20:45:26Z`
Production eligible: `false`

## Scope

This bundle binds the incremental `.60` exact-source patches to the first
protocol-derived egress path: one client INVITE parent may authorize one
transaction-layer ACK after an exact peer 300--699 response. It covers the
default-fail-closed derivation trait, exact parent/trigger/child validation, a
stable child Effect identity, cancellation/reconciliation latching, rejection
of a parent already in `unknown`, one-transaction PostgreSQL child preparation,
incremental patch replay and complete component library suites.

It does **not** prove a live RustPBX endpoint, an exact `.60` image, a remote SIP
peer, production traffic, a long call, rolling N/N+1 activation, crash recovery,
fault/OOM behavior or capacity. Those states remain `not_run`.

## Final controlled results

| Check | Exact result | Artifact |
| --- | --- | --- |
| rsipstack final Linux library suite | `302 passed; 0 failed` | `server-rsipstack-derived-r7.log` |
| RustPBX final Linux library suite | `2,002 passed; 0 failed; 8 ignored` | `server-rustpbx-derived-r15.log` |
| physical PostgreSQL atomic parent/child derivation | `1 passed; 0 failed` | `server-postgres-derived-ack-r6.log` |
| fresh `.59` baseline + `.60` incremental patch replay | both patches apply and reproduce all six exact final files | `verification.txt` |
| old-service preservation postflight | all pre-existing application containers/services stopped; only isolated G03 PostgreSQL running | `host-manifest.txt` |

The eight ignored RustPBX tests require separately selected external
prerequisites. The relevant PostgreSQL derived-ACK test was selected explicitly
and passed; ignored status is not counted as proof for the other seven tests.

## Attempt history retained

Failures are retained rather than overwritten:

- rsipstack `r1`: Cargo executable hidden by the first container mount;
- rsipstack `r2`/`r3`: offline registry cache did not contain `base64`;
- rsipstack `r4`: dependency-fetch run passed `302/302` before final hardening;
- rsipstack `r5`: login shell reset `PATH` and did not enter tests;
- rsipstack `r6`: pre-format exact source passed `302/302`;
- rsipstack `r7`: Rust 2021-format-final exact source passed `302/302`;
- RustPBX `r12`: offline registry cache did not contain `anyhow`;
- RustPBX `r13`: prior exact-source suite passed `2,001/0/8`;
- RustPBX `r14`: Unknown-parent regression included, pre-format patch passed `2,002/0/8`;
- RustPBX `r15`: final patch bytes passed `2,002/0/8`;
- PostgreSQL `r1`: wrong session identity failed the schema precondition;
- PostgreSQL `r2`: earlier exact source passed;
- PostgreSQL `r3`: the required unique run ID was absent and the harness failed;
- PostgreSQL `r4`: prior exact source passed with the run ID;
- PostgreSQL `r5`: pre-format patch binary passed `1/1`;
- PostgreSQL `r6`: final patch bytes and final binary passed `1/1`.

`remote-artifacts.sha256` binds every retained remote log. No credentials,
authorization headers, private keys or environment dumps are included. Test and
package names containing the word `password` are ordinary source identifiers,
not secret values.

## Honest boundary

Automatic 200-to-CANCEL, UAS-Core 2xx ACK ownership, parent-Unknown repair and
handoff, stale `send_attempted`/`transport_accepted` recovery, live endpoint
composition, mixed-binary activation, exact image/wire/peer/long-call/fault and
capacity campaigns all remain `not_run`. `G03-E15-REVIEW` and
`G03-E16-NATIVE-AUTHORITY` are not promoted.
