# G03 Controlled PostgreSQL Restart Report

Status: `verified_controlled`
Production eligibility: `false`
Source commit: `a18229cde752e2fbd4a3ffa3b8d8a8cc7cef7beb`

## Campaign history

The first exact-source campaign, `converact-g03-pg-restart-a18229cd-01`,
completed the PostgreSQL, ACL, restart, replay, verification and cleanup steps,
but its final raw `docker inspect` byte comparison failed because Docker
returned the same bind mounts in a different array order. It was not promoted.
Normalization of only the unordered mount/bind collections produced identical
pre/post digests. A fresh campaign ID and fresh database were then used; no
failed-run database or result was reused.

The promoted campaign is `converact-g03-pg-restart-a18229cd-02`. It ran from a
SHA-bound source archive on the non-production validation host with pinned Node
and PostgreSQL image digests. The harness created only uniquely labelled
temporary resources and confirmed the nine pre-existing stopped containers
were semantically unchanged.

## Result

| Check | Result |
| --- | --- |
| Raw retained-file manifest | passed |
| Exact source/archive/probe identity | passed |
| PostgreSQL physical executor ACL | 1 passed, 0 failed |
| PostgreSQL outage query | failed as required, exit 2 |
| Same PostgreSQL system | system identifier unchanged |
| Actual restart | postmaster start time changed |
| Separate recovery process | process UUID and Node container ID changed |
| Pre-restart prepare replay | `replayed=true`, revision 4 |
| Pre-restart accepted Receipt replay | true, revision 4 |
| Observed transition and replay | revision 5, no duplicate Receipt |
| Effect / Receipt cardinality before cleanup | 1 / 4 |
| Cleanup | tenant/effect/receipt = 0/0/0; registries disabled |
| Campaign resource cleanup | containers/networks/volumes = 0/0/0 |
| Validation host after campaign | 9 total stopped, 0 running |
| Secret scan | passed |

The controlled evidence is retained under
`evidence/raw/postgres-restart-a18229cd-02/`. It qualifies only
`G03-E05-POSTGRES` as `verified_controlled`; it leaves all production and
unrelated external gates unchanged.
