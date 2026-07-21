# Kamailio SIP Edge Implementation Plan

**Goal:** Build the production Kamailio SIP Edge described in
`kamailio-sip-edge-design.md` without performing physical capacity tests.

**Architecture:** A Node route-agent polls authenticated RustPBX component-node state, publishes a
signed bounded snapshot, compiles a local dispatcher file, and reloads Kamailio through loopback-only
JSON-RPC. Kamailio uses relative-capacity dispatch for new INVITEs and stable per-node pin sets for
in-dialog traffic; RustPBX admission remains authoritative.

**Tech Stack:** TypeScript/Node.js, source-pinned Kamailio 6.0.7 dispatcher/dialog/topoh/pike/htable/jsonrpcs,
Docker Compose, Kubernetes Helm, Prometheus, SIPp.

---

## Task 1: Signed route snapshot domain

**Files:**

- Create: `src/agent-runtime/ivekit/voice/kamailio-route-snapshot.ts`
- Create: `test/ivekit-kamailio-route-snapshot.test.ts`
- Modify: `src/agent-runtime/ivekit/voice/index.ts`

- [ ] Write tests for canonical HMAC envelopes, current/previous key verification, identity and epoch
  checks, strict sequence monotonicity, TTL, 4 MiB/1,024-node bounds, URI validation and unknown fields.
- [ ] Run `node --import tsx --test test/ivekit-kamailio-route-snapshot.test.ts`; verify the missing
  module failure.
- [ ] Implement `encodeKamailioRouteSnapshot`, `verifyKamailioRouteSnapshot` and strict public types.
- [ ] Run the focused test and `npm run typecheck`; expect zero failures.
- [ ] Commit only Task 1 files.

## Task 2: RustPBX component-state source and dispatcher compiler

**Files:**

- Modify: `src/agent-runtime/ivekit/placement/component-node-admission-http.ts`
- Create: `src/agent-runtime/ivekit/voice/kamailio-route-compiler.ts`
- Create: `test/ivekit-kamailio-route-compiler.test.ts`
- Modify: `test/ivekit-component-node-admission-http.test.ts`

- [ ] Add failing tests for authenticated `GET /v1/state` client parsing and bounded response handling.
- [ ] Add failing compiler tests for accepting/degraded/draining/offline nodes, normalized `rweight`,
  stable pin sets, collision rejection, CR/LF injection rejection and deterministic output.
- [ ] Implement `readState()` on `HttpComponentNodeAdmissionClient` without changing existing write APIs.
- [ ] Implement dispatcher compilation: new-call pool uses active nodes; draining nodes retain active pin
  sets; offline nodes retain inactive+probing pin sets; zero-headroom nodes leave the new-call pool.
- [ ] Run both focused test files and typecheck; expect zero failures.
- [ ] Commit Task 2 files.

## Task 3: Route-agent runtime, atomic publication and metrics

**Files:**

- Create: `src/agent-runtime/ivekit/voice/kamailio-route-agent.ts`
- Create: `scripts/ivekit-kamailio-route-agent.ts`
- Create: `test/ivekit-kamailio-route-agent.test.ts`
- Modify: `package.json`
- Modify: `infra/env.example`
- Modify: `infra/ivekit/env.example`
- Modify: `services/ivekit-service/env.example`

- [ ] Write failing tests for bounded parallel polling, last-known-good retention, stale fail-closed,
  monotonic snapshots, atomic file replacement, key rotation, JSON-RPC authentication and retry bounds.
- [ ] Implement environment parsing with explicit region/zone/cell/profile/pool/node topology and Secret
  file references; reject inline production secrets when a file is required.
- [ ] Implement poll -> sign -> verify -> compile -> atomic publish -> loopback RPC reload.
- [ ] Expose `/livez`, `/readyz` and `/metrics` on a separate local port with bounded labels.
- [ ] Add the package command and compile entry point.
- [ ] Run focused tests, typecheck and a process smoke test using mock component endpoints/RPC.
- [ ] Commit Task 3 files.

## Task 4: Production Kamailio configuration and renderer

**Files:**

- Replace: `infra/config/kamailio.cfg`
- Create: `src/agent-runtime/ivekit/voice/kamailio-config.ts`
- Create: `scripts/render-kamailio-config.ts`
- Create: `test/ivekit-kamailio-config.test.ts`
- Modify: `package.json`

- [ ] Write failing structural tests for required modules and routes: REQINIT, AUTH, NEW_INVITE,
  WITHINDLG, DISPATCH, FAILURE, RPC, metrics and header sanitization.
- [ ] Write renderer tests for TLS/WSS, topoh key file, source/trunk ACL, CPS bounds, dispatcher file and
  loopback RPC; reject wildcard ACL and public RPC bind.
- [ ] Implement the typed renderer and checked-in non-runnable reference configuration.
- [ ] Implement relative-weight algorithm 11, XAVP failover, pin-set Record-Route, 408/5xx retry allowlist,
  4xx pass-through, OPTIONS thresholds, pike/htable limits and stale/no-destination 503.
- [ ] Run the focused tests and `kamailio -c -f <rendered>` inside the pinned Kamailio image.
- [ ] Commit Task 4 files.

## Task 5: Controlled Compose topology

**Files:**

- Create: `infra/ivekit/docker-compose.kamailio.yml`
- Create: `infra/ivekit/kamailio/README.md`
- Create: `infra/ivekit/kamailio/fixtures/prepare.mjs`
- Modify: `infra/docker-compose.production.yml`
- Create: `test/ivekit-kamailio-compose.test.ts`

- [ ] Write failing tests that require two RustPBX nodes, stable component-node identities, one Edge,
  private RPC, local dispatcher volume, health checks, no SQLite and no host exposure for management.
- [ ] Implement the controlled profile with immutable-image variables and explicit secrets.
- [ ] Render both Compose files with placeholder-safe test values and verify no host-port collision.
- [ ] Commit Task 5 files.

## Task 6: Production Helm resources

**Files:**

- Create: `services/ivekit-service/helm/ivekit/templates/kamailio-config.yaml`
- Create: `services/ivekit-service/helm/ivekit/templates/kamailio-deployment.yaml`
- Create: `services/ivekit-service/helm/ivekit/templates/kamailio-service.yaml`
- Create: `services/ivekit-service/helm/ivekit/templates/kamailio-network-policy.yaml`
- Replace voice workload in: `services/ivekit-service/helm/ivekit/templates/rustpbx-deployment.yaml`
- Modify: `services/ivekit-service/helm/ivekit/values.yaml`
- Modify: `services/ivekit-service/helm/ivekit/templates/_helpers.tpl`
- Create: `test/ivekit-kamailio-helm.test.ts`

- [ ] Write failing render-contract tests for two Edge replicas, hostname/zone spread, PDB, RustPBX
  StatefulSet/headless Service, stable ordinal identity, route-agent sidecar, loopback RPC, SIP/TLS/WSS
  Services, direct RTP, NetworkPolicy, preStop drain and digest-only production images.
- [ ] Implement values validation and resources; keep bundled single-node mode explicitly development-only.
- [ ] Run `helm lint` and representative `helm template` variants for external and bundled data services.
- [ ] Commit Task 6 files.

## Task 7: Monitoring, alerts and runbook

**Files:**

- Modify: `services/ivekit-service/helm/ivekit/files/prometheus-rules.yaml`
- Modify: `services/ivekit-service/helm/ivekit/files/grafana-dashboard.json`
- Modify: `docs/ivekit-monitoring-runbook.md`
- Modify: `test/ivekit-monitoring-deployment.test.ts`

- [ ] Add failing tests for snapshot age, no destination, majority down, failover exhaustion, pin failure,
  5xx/retransmission, rate-limit and Edge availability alerts.
- [ ] Add bounded route-agent and Kamailio metrics to rules/dashboard; prohibit call/tenant/number labels.
- [ ] Add runbook actions for stale snapshot, drain, OPTIONS disagreement and rollback.
- [ ] Run monitoring tests and YAML/JSON parsing.
- [ ] Commit Task 7 files.

## Task 8: Functional and fault acceptance

**Files:**

- Create: `scripts/ivekit-kamailio-acceptance.ts`
- Create: `test/ivekit-kamailio-acceptance.test.ts`
- Create: `services/ivekit-service/acceptance/kamailio-sip-edge/README.md`
- Add SIPp scenarios under: `services/ivekit-service/acceptance/kamailio-sip-edge/scenarios/`

- [ ] Define deterministic scenarios for weighted distribution, re-INVITE/BYE affinity, transport/503
  retry, 486 no-retry, node drain, node down/up, stale snapshot and forged internal headers.
- [ ] Implement a bounded runner that records image/config/snapshot hashes and Router/CDR parity.
- [ ] Run controlled Docker acceptance; retain raw SIPp, Kamailio, RustPBX and route-agent evidence.
- [ ] Commit Task 8 files.

## Task 9: Delivery and completion audit

**Files:**

- Modify: `scripts/ivekit-delivery-bundle.ts`
- Modify: `test/ivekit-delivery-bundle.test.ts`
- Modify: `docs/capacity/forks/ivekit-forks-v1.json`
- Modify: `docs/ivekit-v3-completion-audit.md`
- Modify: `docs/design/revised-master-plan.md`
- Modify: `docs/design/gap-analysis.md`

- [ ] Add Kamailio config, route-agent, snapshot schema, Helm/Compose and acceptance assets to the explicit
  delivery allowlist and tamper manifest.
- [ ] Remove the obsolete production decision that Kamailio is deferred; retain it only as historical MVP
  context.
- [ ] Record code/controlled evidence as completed and physical CPS/PSTN/dual-Zone evidence as `not_run`.
- [ ] Run typecheck, all focused tests, delivery pack, secret scan, Helm/Compose render and `git diff --check`.
- [ ] Request code review, resolve findings, commit and push the completed branch.

## Next plans after this one

After Task 9, execute separate implementation plans derived from
`communication-foundation-production-completion.md` for:

1. Tinode production StatefulSet, owner-aware drain/reconnect and data-plane observability.
2. LiveKit SFU + external HA Redis + coturn + LiveKit SIP production pools and recovery.
3. Unified communication SLO, cross-component failure acceptance and release handoff.

Physical load, endurance, public TURN, real PSTN and target dual-Zone Kubernetes remain excluded until all
three plans are complete.
