# AI outbound R1 Campaign authoring evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the bounded Rust Campaign-authoring layers at Converact commit
`58fea84aa784c5e943302224a7e6691e67a889d7`. It covers Core validation, tenant-scoped Store SQL
contracts and an authenticated/capability-gated HTTP boundary. It does not prove that the HTTP port
has been composed with a physical PostgreSQL runtime, nor that any imported Attempt can place a
telephone call.

## Observed scope

- immutable Agent Release publication validates eight exact component digests and deterministic
  content identity;
- Campaign creation binds an exact Agent Release, Audience, dial-policy revision and bounded
  schedule, and starts as `draft`;
- Contact import accepts 1–500 items, rejects duplicate stable identities and creates one planned
  Attempt per Contact with attempt number 1 and execution generation 1;
- destination, consent, recording and retention inputs are validated while destination and consent
  are absent from `Debug`, receipt and HTTP response surfaces;
- the Store contract performs Contact and initial Attempt writes through the caller-owned
  transaction and advances the Campaign revision;
- content-free tenant receipts classify exact replay before recalculating an already-applied state
  transition; key/kind/hash mismatch fails closed;
- lifecycle changes use the Core Campaign state machine and expected revision;
- the Admin router requires authenticated tenant, an explicit operation capability and a valid
  `Idempotency-Key`, bounds JSON bodies to 2 MiB and contact batches to 500;
- Admin source has no SIP, media, RustPBX, Active Call or real-time Agent authority;
- no authoring endpoint can dial; the existing bounded Worker remains the only Attempt claimant.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- Agent Release, Campaign and authoring Core: 14 passed, 0 failed;
- authoring, schema and retry Store contracts: 10 passed, 0 failed;
- ignored physical PostgreSQL harness: compiled, execution not run;
- Campaign Admin and existing internal Worker HTTP: 9 passed, 0 failed;
- scoped Rust Clippy with warnings denied: passed;
- scoped Rust formatting check: passed.

## Explicitly not run

- concrete `CampaignAdminPort` to `PostgresRuntime` composition;
- physical PostgreSQL migration, receipt replay, atomic import/transition, RLS, race and crash tests;
- production authentication/capability middleware and route composition;
- real Campaign UI, CSV/file import and deployed API;
- legacy TypeScript shadow comparison, writer switch, drain and active-zero deletion;
- real RustPBX, Active Call, Speech, SIP/PSTN, media, recording or CDR;
- performance, capacity, long-run, fault campaign, independent review and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
