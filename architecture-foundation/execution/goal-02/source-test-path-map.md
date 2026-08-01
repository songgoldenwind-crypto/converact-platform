# G02 Source → Test → Evidence Path Map

## 1. Closure

- G00 rows targeting G02: **543**
- Mapped exactly once: **543**
- Unmapped: **0**
- Production eligible: **0**
- Historical evidence preserved but not requalified: **16**

Every row is carried without evidence promotion in [`traceability-v1.json`](./traceability-v1.json).
This Markdown file is the human index; the JSON file is the row-level authority.

## 2. Exact domain paths

| G02 domain | G00 rows | implementation/review paths | test paths |
| --- | ---: | --- | --- |
| `identity` | 30 | `src/agent-runtime/converact/platform-foundation/identity.ts`<br>`src/middleware/auth.ts`<br>`src/db-pg-tenant.ts`<br>`src/migrations/108_ivekit_platform_identity_policy.sql` | `test/converact-platform-identity-isolation.test.ts` |
| `consent` | 5 | `src/agent-runtime/converact/platform-foundation/policy.ts`<br>`src/migrations/108_ivekit_platform_identity_policy.sql` | `test/converact-platform-consent-policy.test.ts` |
| `events` | 48 | `src/agent-runtime/converact/platform-foundation/event-envelope.ts`<br>`src/migrations/109_ivekit_platform_event_receipts.sql` | `test/converact-platform-event-compatibility.test.ts` |
| `audit_receipts` | 41 | `src/agent-runtime/converact/platform-foundation/effect-receipt.ts`<br>`src/migrations/109_ivekit_platform_event_receipts.sql` | `test/converact-platform-audit-effect.test.ts` |
| `billing` | 0 | `src/agent-runtime/converact/platform-foundation/billing-ledger.ts`<br>`src/migrations/110_ivekit_platform_billing_ledger.sql` | `test/converact-platform-billing-ledger.test.ts` |
| `key_lifecycle` | 15 | `src/agent-runtime/converact/platform-foundation/key-lifecycle.ts`<br>`src/migrations/111_ivekit_platform_key_lifecycle.sql` | `test/converact-platform-key-rotation.test.ts` |
| `observability` | 27 | `src/agent-runtime/converact/platform-foundation/correlation.ts`<br>`src/telemetry.ts`<br>`src/metrics.ts` | `test/converact-platform-observability-correlation.test.ts` |
| `clock` | 55 | `src/agent-runtime/converact/platform-foundation/clock.ts` | `test/converact-platform-clock.test.ts` |
| `resilience` | 38 | `src/agent-runtime/converact/platform-foundation/resilience.ts`<br>`src/agent-runtime/converact/operations/readiness.ts` | `test/converact-platform-resilience.test.ts` |
| `fault_matrix` | 9 | `src/agent-runtime/converact/platform-foundation/fault-policy.ts` | `test/converact-platform-fault-matrix-contract.test.ts` |
| `legacy_assessment` | 275 | `architecture-foundation/execution/goal-02/source-test-path-map.md` | `architecture-foundation/execution/goal-02/goal-02-contract.test.mjs` |

## 3. Current-source disposition

| Current slice | Disposition | Exact current sources | Existing tests | G02 boundary |
| --- | --- | --- | --- | --- |
| Tenant/RLS | reuse + harden | `src/db-pg-tenant.ts`; migrations 009/010/031/032/090 | `test/db-pg-tenant.test.ts`; `test/db-pg-runtime-schema.test.ts` | application tenant check + FORCE RLS; no bare production context |
| HTTP/service identity | replace facade | `src/middleware/auth.ts`; `src/auth-http.ts`; `src/agent-runtime/converact/authorization.ts`; `src/agent-runtime/security/rbac-store.ts` | auth/RBAC/internal-mTLS tests | one Subject/ServiceIdentity/session/revocation/capability vocabulary |
| Consent | isolate/retire duplicates | call-center `consent-tracker.ts`; voice `compliance-service.ts`; audio-tap grant | voice compliance and retention tests | one cross-media policy decision; adapters do not own consent |
| Event | reuse delivery primitives; replace envelope | tenant journal; integration-events; legacy event buses | tenant replay/websocket/integration-event tests | v2 + N/N-1 + digest conflict + inbox/outbox |
| Audit | reuse canonical hash-chain; retire legacy mutable audit | `operations/audit/*`; legacy call-center audit | converact audit tests | platform receipt links; never media hot path |
| Billing | replace mutable counters; isolate CDR input | quota store; call-center BillingStore; voice CDR convergence | quota/billing/CDR tests | append-only ledger + one writer key |
| Secret/key/cert | reuse loaders; add lifecycle | SSO store; integration secret refs; internal TLS; protectors | integration/TLS tests | eliminate plaintext secret path; versioned rotation/revoke |
| Observability | reuse bounded OTEL/VM; replace labels/correlation | `src/telemetry.ts`; `src/metrics.ts`; OTEL/VM infra | OTEL/VM/backlog tests | structured correlation/redaction/cardinality; fail-open exporter |
| Resilience/DR | reuse worker/backup patterns; add horizontal policy | readiness, heartbeat, placement, backup runner, Helm/CNPG | worker/deploy/backup tests | capability readiness + active-zero drain + real recovery evidence |
| Clock/fault | isolate domain clocks; add platform port/harness | component-node sync; IVR/Voice clocks; Rust `Instant`; fenced netem | component sync/network impairment tests | wall/monotonic separation + full fault matrix |

## 4. Historical evidence non-claim

The 16 G00 production-evidence rows retain their original paths and
`evidence_exists_not_requalified` status in the JSON trace. They do not prove this commit,
real dependency behavior, long media continuity, recovery, capacity, or production eligibility.
All dynamic tests not explicitly linked from the evidence index remain `not_run`.
