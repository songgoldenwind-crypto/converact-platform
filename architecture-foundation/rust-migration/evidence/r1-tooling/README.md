# RM01 R1 — dry-run-first Authority migration tooling evidence

Status: `implemented_offline`, not production eligible.

This checkpoint adds a closed Rust request model, a read-only query/reconcile
path, pure dry runs, exact-confirmation mutations and a one-shot operator
binary over the previously committed atomic `PostgresRouteStore`. It does not
route a current runtime or operate a running server.

## Safety contract

- A request document is always parsed as `dry_run`; the closed parser rejects
  both `execution` and `confirmation_sha256` fields. Query and reconcile
  cannot be promoted to apply.
- The confirmation digest binds schema version, exact tenant/Authority/
  partition, command kind, operation, request hash, expected generation,
  expected revision and every command-specific field. Prepare also binds the
  internally hashed lease capability.
- The reusable tooling library and CLI both reject an `apply` document.
  Mutation requires the separate fixed argument sequence
  `--apply --confirmation-sha256 DIGEST`; the in-file document must still be
  the equivalent dry-run request, and only the explicit external promotion
  method can construct an apply request.
- Every request file is opened once with `O_NOFOLLOW`, `O_CLOEXEC` and
  `O_NONBLOCK`. The same descriptor must be a regular file owned by the
  effective process user, have no group/other permission bits and be no more
  than 64 KiB before bounded UTF-8 decoding.
- A prepare request accepts the raw 256-bit lease capability only long enough
  to validate and hash it. The validated request, durable command, debug
  output, result and receipt contain only its digest.
- Apply calls the atomic store exactly once. A database error or outer apply
  deadline is reported with exit code 2 as `status: unknown`,
  `mutation_performed: null` and `reconcile_required: true`; there is no
  mutation retry loop.
- Connections, session setup, PostgreSQL lock/statement/idle-in-transaction
  waits, execution and connection shutdown all have explicit deadlines.
- PostgreSQL input is restricted to an absolute local Unix-socket path and
  passwordless discrete fields. The client cannot prove which authentication
  method the PostgreSQL server selected. Exact HBA peer mapping and operator
  OS/DB identity are deployment prerequisites and remain `not_run`.

Prepare/commit can target either Rust or TypeScript with a strictly newer
owner epoch, so rollback remains a new generation instead of reviving a stale
writer. Drain, mark-active-zero and retire remain forward-only fenced
transitions.

## Direct offline verification

On 2026-08-14 an isolated temporary PostgreSQL 14.18 cluster was migrated
through root migration 117. A non-superuser test login inherited only the
capability roles needed for migration and runtime test calls. Three physical
tests passed. The disposable harness used trust authentication, so it is not
evidence of a production HBA/peer mapping:

1. dry-run, wrong confirmation, one apply, exact replay, receipt reconcile and
   unknown receipt without blind retry;
2. prepare dry-run preserving `shadow:1`, capability hashing and atomic apply
   to `prepare:2`;
3. the real CLI with an out-of-band confirmation, followed by a concurrent
   route-row lock: it returned bounded `unknown`, then resolved the existing
   receipt after unlock without a second revision change.

The third test completed the locked call in about 2.4 seconds under a 2-second
database lock timeout and a 6-second outer execution deadline. This is a
functional boundedness assertion, not a performance or capacity claim.

The temporary cluster was created below a validated `mktemp` directory,
stopped and removed. It did not use Docker or contact a running server.

Three independent review rounds closed at `0 Critical / 0 Important`. The
first round found one Critical and two Important issues in request-file
handling, authentication wording and deadline/unknown-outcome behavior. The
second round found one Important reusable-parser apply bypass. Each finding
was reproduced or converted to a regression test before correction; the final
review found no remaining blocking issue.

Running-server validation, HBA/peer deployment policy, operator packaging,
fleet/AZ recovery, load, capacity, performance and production eligibility all
remain `not_run`.
