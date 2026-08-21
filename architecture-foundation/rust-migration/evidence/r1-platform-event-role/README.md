# RM01 R1 — Platform Event database role isolation evidence

Status: `implemented_offline_default_disabled`, not production eligible and not
wired into any running runtime.

This slice isolates the Rust Platform Event store behind one dedicated
PostgreSQL login and one non-login function owner. The login is created as
`NOLOGIN`; a separate explicit command validates the complete privilege graph
before setting a password and enabling `LOGIN`. Nothing in this slice changes a
server, container, deployed secret, connection pool or traffic route.

## Exact authority graph

- `converact_event_runtime` is `NOINHERIT`, has no memberships in either
  direction, reads the six Platform Event relations and receives privileged
  function capability only through the six reviewed `SECURITY DEFINER`
  wrappers. It has no raw table mutation,
  underlying Authority claim/release or object ownership capability.
- `converact_event_store_owner` is `NOLOGIN`, has no memberships and owns only
  those six wrappers. It receives the exact relation and underlying Authority
  function privileges needed by the wrappers, with no grant option.
- Every wrapper has the exact non-login owner, `SECURITY DEFINER`, fixed
  `search_path = pg_catalog, public, pg_temp`, no PUBLIC or third-party execute
  grant, and a target table protected by forced RLS with one exact tenant
  policy.
- Activation rejects direct, column and effective PUBLIC grants, extra
  policies, role membership, object ownership, grant options, privileged
  functions, schemas, databases, tablespaces, default ACLs, relations,
  sequences, large objects and catalog dependencies outside the closed graph.
  The graph is deliberately scoped to one database; effective CONNECT to any
  other connectable database fails closed. The cluster baseline therefore
  removes PUBLIC CONNECT/TEMP from `postgres`, `template1` and the target
  database before activation.
- Migration 120 revokes PUBLIC EXECUTE from every existing public-schema
  `SECURITY DEFINER` function and changes opc_admin's global function default
  so later migrations do not silently reintroduce PUBLIC EXECUTE. Activation
  also rejects PUBLIC write-capable table, sequence and schema defaults.
- The rolling `opc_runtime` principal is narrowed by migration 120 itself. It
  keeps only `SELECT/INSERT/UPDATE` on the legacy Outbox and `SELECT/INSERT` on
  legacy Inbox/Effect receipts, with no access to claim/transition truth.

## Rolling and packaging behavior

- A fresh install and an upgrade from migrations through 119 both converge on
  the same graph. Re-running the generic bootstrap after activation preserves
  the already active event login instead of silently returning it to
  `NOLOGIN`.
- The activation entrypoint is part of the curated delivery bundle and actual
  standalone build context. It remains operator-invoked and is not called by
  Compose or a runtime startup path.
- Rust event/outbox adapters call the Platform Event fence wrapper, never the
  underlying Authority mutation function directly.
- The focused PostgreSQL verifier owns its isolated fresh and upgrade
  databases, pins Cargo, rustc and rustdoc to the repository toolchain and uses
  `--locked`.

## Direct verification

The affected TypeScript suite passed 51/51, TypeScript typecheck passed, Rust
format and strict Clippy passed, and the Rust package passed nine ordinary
tests plus one compile-fail doctest. Thirteen other physical PostgreSQL tests
remain explicitly ignored in the ordinary package command.

The dedicated isolated PostgreSQL verifier passed its fresh-install and
through-119 upgrade test, including adversarial extra-policy, wrapper,
grant-option, database, table, column, sequence, PUBLIC, third-party,
`SECURITY DEFINER`, large-object and forward default-ACL grants. The test
cleans every negative case and proves a successful activation before the
upgrade path. The verifier then replays the generic initializer, activates
again and passes the Rust writer-fenced Platform Event lifecycle physical test.
A separate offline standalone build emitted and verified the compiled
activation entrypoint.

The full repository PostgreSQL harness is not reported as green because its
pre-existing Voice auth and SIP cleanup failures are outside this focused
slice. No Docker, remote host, running service, load test or performance
campaign was used.

## Remaining gates (`not_run`)

- dedicated production secret/TLS and runtime pool URL wiring;
- route commit, new-work cutover and proof that the Rust login is the sole
  target writer;
- expired owner adoption, drain, query/reconcile and active-zero;
- retirement of the rolling `opc_runtime` grants and legacy writer route;
- generation-counter de-hotspotting and capacity proof;
- server, fleet, fault, performance and production qualification.
