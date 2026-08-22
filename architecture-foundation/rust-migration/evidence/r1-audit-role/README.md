# RM01 R1 — isolated Rust Audit database-role evidence

Status: `implemented_offline_default_disabled`. This slice is not production
eligible. It does not create a Rust Audit pool, start a process, change the
Audit Authority route or activate a login automatically. The TypeScript Audit
service through `opc_runtime` remains the only active Audit Authority.

This checkpoint adds the explicit database security boundary needed before a
Rust Audit adapter can be wired. Migration 123 creates no `LOGIN` capability.
The packaged activation command is a manual, fail-closed gate and is not
present in a running Compose path.

## Exact role and capability model

- `converact_audit_runtime` starts `NOLOGIN`, `NOINHERIT` and `NOBYPASSRLS`.
  After an explicit successful activation it can select Audit events and call
  only the three Audit writer-fence/head/append wrappers. It cannot insert into
  either target table, call the generic Authority fence or access the head.
- `converact_audit_store_owner` is permanently `NOLOGIN`. It owns only those
  three wrappers and receives only the table and generic-fence capabilities
  needed inside them.
- `opc_runtime` keeps the legacy TypeScript read/append surface and the narrow
  legacy-allowed helper. It remains fenced by the active route, generation,
  lease and qualified target head from the preceding checkpoint.
- No role is a member of either dedicated role in either direction. The roles
  may not own unrelated objects, carry persistent settings, inherit an
  unreviewed `SECURITY DEFINER`, or receive ambient table, column, sequence,
  large-object, schema, database or default-ACL authority.

## Activation and hidden-execution gates

Activation runs as `opc_admin` in one transaction and enables `LOGIN` only
after the exact graph is accepted. The application does not concatenate the
raw secret: PostgreSQL `%L` returns the safely quoted statement, and the CLI
does not print it. Broader secret memory and logging qualification remains a
production gate.

The gate validates:

- exact role flags, zero memberships, zero role/database settings, exact
  owners, RLS policies, function owners, definer/invoker modes, fixed
  `search_path`, direct grantors and non-grantable ACL entries;
- one database-owner trust root and a `public` schema owned only by
  `opc_admin` or PostgreSQL 15+'s `pg_database_owner`, with no additional
  schema creator;
- no effective connection to another database, no current-database
  `CREATE`/`TEMPORARY`, no database authority for the no-login owner, and an
  exact direct current-database `CONNECT` grant on activation/re-entry;
- the exact two non-internal event-table triggers: the `BEFORE INSERT` legacy
  fence and the `BEFORE UPDATE OR DELETE` immutable guard; the head table has
  no non-internal trigger and neither target table has a rewrite rule;
- `session_replication_role` and its reset value are both `origin`, so an
  ambient replica mode cannot silently disable the legacy or immutable
  triggers;
- PostgreSQL 15+ parameter ACLs do not give `PUBLIC` or either dedicated role
  `SET`/`ALTER SYSTEM`, including for `session_replication_role`;
- global and `public`-schema default ACLs cannot restore ambient function,
  table, sequence or schema authority after activation.

The same review closed two pre-existing Platform Event activation gaps:
per-schema public function defaults and an untrusted `public` schema creator
now fail closed there as well.

## Packaging boundary

The standalone source policy, migration bundle and compiled service package
now contain migration 123 and `converact-init-audit-runtime-role`. This makes
the gate deliverable without making it active. There is no Compose service,
runtime pool, application route, worker loop or Rust process wired to this
login in this slice.

## Fresh direct verification

- Node 24.15.0 affected contracts: 67 passed, 3 explicitly skipped physical
  tests, 0 failed. TypeScript typecheck and `git diff --check` passed.
- Pinned Rust 1.94.1 workspace all-target tests passed; 20 isolated PostgreSQL
  tests retained explicit ignore gates. Strict Clippy, formatting and
  workspace documentation generation passed.
- The Audit role physical suite passed 1/1 on two distinct disposable
  PostgreSQL 14.18 clusters for fresh and through-122 upgrade paths. It covered
  membership, ownership, direct/effective/grantor ACLs, RLS, default ACLs,
  persistent settings, cross-database access, `SECURITY DEFINER`, hidden
  triggers/rules, `SET ROLE`, schema creator, large object and activation
  replay attacks.
- The existing Platform Event role fresh/through-119 upgrade regression passed
  1/1 on two disposable PostgreSQL 14.18 clusters.
- The rolling TypeScript Audit writer fence passed 1/1 through migration 123.
- The ignored Rust Audit physical test passed 1/1 through migration 123 using
  the activated dedicated runtime role and a separate admin seed connection.
- A disposable offline standalone context installed, compiled and emitted all
  19 required operational entrypoints, including the Audit activation CLI.
- Independent exact-tree review found zero code submit blockers for this
  default-disabled slice. The reviewer did not mutate Git or operate a server,
  Docker or staging environment.

The first Rust physical invocation used the wrong working directory for its
Node bootstrap import and failed before product code ran. It was discarded as
harness evidence and rerun from the repository root. A standalone verifier was
also rerun with the canonical prefixed environment key so its generated context
was isolated under `/private/tmp`; only the corrected runs count above.

No remote host, pre-existing product service, container, Docker daemon, load
test or performance campaign was used or changed. Only disposable local
PostgreSQL processes were started and stopped. The historical dirty G03
evidence file remained untouched by this slice and reviewer and was not staged.

## Remaining gates (`not_run`)

- an actual PostgreSQL 16 fresh install and through-122 upgrade, including the
  `pg_database_owner` and `pg_parameter_acl` branches; production activation is
  forbidden until this passes on the pinned production image;
- the production server-config/reset-value preflight for
  `session_replication_role=origin`;
- Rust Audit pool/process wiring, health/readiness, credentials, TLS, `pg_hba`,
  connection policy, secret rotation and memory handling;
- application-layer tenant authorization before setting the shared database
  role's tenant GUC;
- shadow comparison, Authority prepare/commit, new-work cutover, old
  TypeScript writer drain, reconcile, active-zero and source/deployment
  deletion;
- a formal head-aware reverse handoff and crash/restart/CommitUnknown/two-node
  qualification;
- production upgrade/rollback rehearsal, monitoring, fleet/fault, capacity,
  performance and production qualification.
