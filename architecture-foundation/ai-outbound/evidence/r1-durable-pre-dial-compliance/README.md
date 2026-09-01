# AI outbound R1 durable pre-dial compliance evidence

> Date: 2026-09-01
>
> Status: `passed_local_and_isolated_postgres / external_policy_sources_not_run`

## Proven scope

- compliance evaluation is asynchronous and receives the authenticated tenant explicitly;
- the PostgreSQL adapter loads the claimed Attempt, Campaign schedule, Contact state, immutable
  Agent Release and latest matching consent revision in one tenant-scoped transaction;
- consent is accepted only for the exact `phone_audio` scope and `ai_outbound` purpose when the
  latest revision is granted and unexpired;
- a later revoked consent revision blocks the same claimed Attempt before telephony;
- missing, malformed, stale or unavailable durable facts fail closed with bounded error codes;
- dial start time, scheduled attempt time, local Contact suppression, physical-attempt ceiling and
  published Release state are evaluated by the existing pure compliance policy;
- the claimed-Attempt executor passes tenant scope through the policy boundary and preserves the
  existing release-binding checks.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
ai-outbound orchestrator contracts: 11 passed
PostgreSQL compliance policy unit contracts: 2 passed
claimed-Attempt executor contracts: 2 passed
voice-agent tracer bullet: 5 passed
isolated disposable PostgreSQL physical test: 1 passed
scoped Clippy with -D warnings: passed
package rustfmt and exact-slice git diff checks: passed
```

The physical test installed only the required migrations into a disposable local database, proved
both granted and later-revoked consent behavior, then stopped the temporary PostgreSQL process. No
Docker, remote server, deployed service, broad regression or performance test was used.

## Source checkpoint

- `f7f96666a6ef28639eed01239d046e27a48fa893` — tenant-scoped durable pre-dial policy adapter.

## Current authority boundary

- the current durable Contact state is the authority for platform-local suppression;
- Campaign schedule currently proves only campaign start and per-Attempt scheduled time;
- Agent Release publication and the physical-attempt ceiling are enforced locally;
- consent authority is the latest exact-purpose evidence revision in the platform store.

## Explicitly not proved

- external or national do-not-call registry integration;
- jurisdiction-specific daily calling windows, holidays or destination-local time calculation;
- production identity/JWKS lifecycle, carrier policy feeds or legal-policy distribution;
- executable Worker composition and continuous claim loop;
- real Active Call/RustPBX, SIP/PSTN, Speech/model, recording or human handoff;
- remote server, production, performance, capacity and long-run behavior.
