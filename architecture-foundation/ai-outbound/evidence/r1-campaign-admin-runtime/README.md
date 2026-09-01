# AI outbound R1 Campaign Admin runtime evidence

> Date: 2026-09-01
>
> Status: `passed_local_composition / physical_postgres_not_run`

## Proven scope

- `PostgresCampaignAdminStore` owns one bounded tenant transaction for each Agent publication,
  Campaign creation, Contact import and Campaign transition;
- Contact import remains one all-or-nothing transaction that creates the first physical Attempt;
- Campaign transitions restore and apply the Core state machine while the durable row is locked;
- exact transition replay is checked before recalculating the state change;
- commit and rollback uncertainty remain a distinct `outcome_unknown` result suitable only for
  same-key reconciliation, not a blind new mutation;
- the authenticated identity retains only its verified bounded capability set;
- three exact capabilities independently gate Agent publication, Campaign management and Contact
  import; an ordinary `platform.api` token is insufficient;
- the Campaign Admin router is composed into the executable Rust Voice Worker alongside the
  existing inspection, health and claim paths;
- the concrete Admin port is fixed to the same tenant authority as the Worker's claim source and
  rejects another tenant before acquiring a database connection;
- the Admin boundary has no telephony, media or real-time Channel Agent authority.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
PostgreSQL Campaign Admin adapter contract/unit tests: 5 passed
HS256/RS256 authenticated capability tests: 6 passed
Campaign HTTP/auth/adapter/process tests: 15 passed
Worker adapter unit test: 1 passed
Executable binary cargo check: passed
Scoped Clippy with -D warnings: passed
```

The checks used inert connection pools, signed local token fixtures, controlled HTTP requests and
source-level authority assertions. No Docker, remote server, deployed service, broad regression or
performance command was used.

## Source checkpoints

- `6bb53b6731433a67a7c673b1ad0c9d5e82dcf858` — tenant-transaction-owned PostgreSQL Admin store;
- `a614e5585c49318576fab12dca84f8304959515a` — verified capability retention;
- `c0b68ace036d7575f04e4d7855db22ee21270334` — authenticated Admin routes in the executable Worker;
- `8972fcab71358281fe1c9f79290f4a66cea891aa` — fixed Worker/Admin tenant authority.

## Explicitly not proved

- execution against an isolated PostgreSQL database migrated through the current schema;
- real platform issuer provisioning and rotation of the three new capability claims;
- a real operator UI/file import invoking these endpoints;
- a Campaign created through this API being claimed and completed through a real SIP/PSTN call;
- remote server, production, performance, capacity and long-run behavior.
