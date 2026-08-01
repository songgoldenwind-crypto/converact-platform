# Kamailio SIP Edge Implementation Plan

**Goal:** Build the production Kamailio SIP Edge described in
`kamailio-sip-edge-design.md` without performing physical capacity tests.

**Architecture:** A Node route-agent polls authenticated RustPBX component-node state, publishes a
signed bounded snapshot, compiles a local dispatcher file, and reloads Kamailio through loopback-only
JSON-RPC. Kamailio uses relative-capacity dispatch for new INVITEs and stable per-node pin sets for
in-dialog traffic; RustPBX admission remains authoritative.

**Tech Stack:** TypeScript/Node.js, source-pinned Kamailio 6.0.7 dispatcher/dialog/topoh/pike/htable/jsonrpcs,
Docker Compose, Kubernetes Helm, Prometheus, SIPp.

**Status (2026-07-21):** Tasks 1-9 的代码、配置、交付资产、审查和受控自动化门禁已完成。
最终门禁为通信专项 72/72、交付合同 58/58、Stage 2/Helm 22/22，类型检查、standalone context、
SIPp XML、补丁应用检查和依赖审计通过。Task 8 的真实 Compose/SIPp 运行尚未执行；本机 Docker
daemon 当前无法响应 `_ping`，因此 Kamailio `-c` 镜像检查和 Docker SIPp/WSS/DMQ 必须保持
`not_run`，不能标记为失败或通过。

---

## Task 1: Signed route snapshot domain

**Files:**

- Create: `src/agent-runtime/converact/voice/kamailio-route-snapshot.ts`
- Create: `test/converact-kamailio-route-snapshot.test.ts`
- Modify: `src/agent-runtime/converact/voice/index.ts`

- [x] Write tests for canonical HMAC envelopes, current/previous key verification, identity and epoch
  checks, strict sequence monotonicity, TTL, 4 MiB/1,024-node bounds, URI validation and unknown fields.
- [x] Run `node --import tsx --test test/converact-kamailio-route-snapshot.test.ts`; verify the missing
  module failure.
- [x] Implement `encodeKamailioRouteSnapshot`, `verifyKamailioRouteSnapshot` and strict public types.
- [x] Run the focused test and `npm run typecheck`; expect zero failures.
- [x] Commit only Task 1 files (`24d5257`).

## Task 2: RustPBX component-state source and dispatcher compiler

**Files:**

- Modify: `src/agent-runtime/converact/placement/component-node-admission-http.ts`
- Create: `src/agent-runtime/converact/voice/kamailio-route-compiler.ts`
- Create: `test/converact-kamailio-route-compiler.test.ts`
- Modify: `test/converact-component-node-admission-http.test.ts`

- [x] Add failing tests for authenticated `GET /v1/state` client parsing and bounded response handling.
- [x] Add failing compiler tests for accepting/degraded/draining/offline nodes, normalized `rweight`,
  stable pin sets, collision rejection, CR/LF injection rejection and deterministic output.
- [x] Implement `readState()` on `HttpComponentNodeAdmissionClient` without changing existing write APIs.
- [x] Implement dispatcher compilation: new-call pool uses active nodes; draining nodes retain active pin
  sets; offline nodes retain inactive+probing pin sets; zero-headroom nodes leave the new-call pool.
- [x] Run both focused test files and typecheck; expect zero failures.
- [x] Commit Task 2 files (`c566eab`).

## Task 3: Route-agent runtime, atomic publication and metrics

**Files:**

- Create: `src/agent-runtime/converact/voice/kamailio-route-agent.ts`
- Create: `scripts/converact-kamailio-route-agent.ts`
- Create: `test/converact-kamailio-route-agent.test.ts`
- Modify: `package.json`
- Modify: `infra/env.example`
- Modify: `infra/converact/env.example`
- Modify: `services/converact-service/env.example`

- [x] Write failing tests for bounded parallel polling, last-known-good retention, stale fail-closed,
  monotonic snapshots, atomic file replacement, key rotation, JSON-RPC authentication and retry bounds.
- [x] Implement environment parsing with explicit region/zone/cell/profile/pool/node topology and Secret
  file references; reject inline production secrets when a file is required.
- [x] Implement poll -> sign -> verify -> compile -> atomic publish -> loopback RPC reload.
- [x] Expose `/livez`, `/readyz` and `/metrics` on a separate local port with bounded labels; merge the
  loopback Kamailio core metrics endpoint without making core scrape failure fail the agent scrape.
- [x] Add the package command and compile entry point.
- [x] Run focused tests, typecheck and a process smoke test using mock component endpoints/RPC.
- [x] Commit the base Task 3 runtime (`490397b`); core metrics proxy is included in the final goal commit.

## Task 4: Production Kamailio configuration and renderer

**Files:**

- Replace: `infra/config/kamailio.cfg`
- Create: `src/agent-runtime/converact/voice/kamailio-config.ts`
- Create: `scripts/render-kamailio-config.ts`
- Create: `test/converact-kamailio-config.test.ts`
- Modify: `package.json`

- [x] Write failing structural tests for required modules and routes: REQINIT, AUTH, NEW_INVITE,
  WITHINDLG, DISPATCH, FAILURE, RPC, metrics and header sanitization.
- [x] Write renderer tests for TLS/WSS, topoh key file, source/trunk ACL, CPS bounds, dispatcher file and
  loopback RPC; reject wildcard ACL and public RPC bind.
- [x] Implement the typed renderer and checked-in non-runnable reference configuration.
- [x] Implement relative-weight algorithm 11, XAVP failover, pin-set Record-Route, 408/5xx retry allowlist,
  4xx pass-through, OPTIONS thresholds, pike/htable limits and stale/no-destination 503.
- [x] Implement exact-Origin WSS JWT authentication, From/subject binding, per-request 30-second internal
  assertions, RustPBX-authoritative REGISTER, 2xx-only local save, WebPhone dialog routing and bounded
  `dmq_usrloc` replication on a dedicated internal listener.
- [x] Run the focused renderer/config tests.
- [ ] Run `kamailio -c -f <rendered>` inside the pinned Kamailio image. `not_run`: Docker daemon did not
  answer `_ping` on 2026-07-21; no syntax-pass claim is made.
- [x] Commit the base Task 4 renderer/config (`273724a`, `1adb48b`); deployment wiring is included in the
  final goal commit.

## Task 5: Controlled Compose topology

**Files:**

- Modify: `services/converact-service/docker-compose.voice.yml`
- Create: `src/converact-kamailio-compose-config.ts`
- Modify: `services/converact-service/env.example`
- Create: `test/converact-kamailio-compose.test.ts`

- [x] Write failing tests that require two RustPBX nodes, stable component-node identities, one Edge,
  private RPC, local dispatcher volume, health checks, no SQLite and no host exposure for management.
- [x] Implement one-node `voice` and two-node `voice-capacity` profiles with immutable-image variables,
  explicit file-backed secrets, sole public Kamailio SIP listeners and disjoint RTP ranges.
- [x] Render the merged base/voice Compose files with placeholder-safe values; verify both profiles and
  no SIP/RTP host-port collision.
- [x] Package Task 5 files in the final goal commit.

## Task 6: Production Helm resources

**Files:**

- Create: `services/converact-service/helm/converact/templates/kamailio-config.yaml`
- Create: `services/converact-service/helm/converact/templates/kamailio-deployment.yaml`
- Service is rendered with: `services/converact-service/helm/converact/templates/kamailio-deployment.yaml`
- Create: `services/converact-service/helm/converact/templates/kamailio-network-policy.yaml`
- Replace voice workload in: `services/converact-service/helm/converact/templates/rustpbx-deployment.yaml`
- Modify: `services/converact-service/helm/converact/values.yaml`
- Modify: `services/converact-service/helm/converact/templates/_helpers.tpl`
- Create: `test/converact-kamailio-deployment.test.ts`

- [x] Write failing render-contract tests for two Edge replicas, hostname/zone spread, PDB, RustPBX
  StatefulSet/headless Service, stable ordinal identity, route-agent sidecar, loopback RPC, SIP/TLS/WSS
  Services, direct RTP, NetworkPolicy, preStop drain and digest-only production images.
- [x] Implement values validation and resources; one chart release is exactly one Cell/Zone and bundled
  single-node mode remains development-only.
- [x] Run checksum-verified Helm 3.18.6 `lint` and representative `template` variants, including YAML
  parsing and Stage 2 release contract. The Edge renders as a two-replica StatefulSet with stable
  ordinal DMQ identities and a headless Service.
- [x] Package Task 6 files in the final goal commit.

## Task 7: Monitoring, alerts and runbook

**Files:**

- Modify: `services/converact-service/helm/converact/files/prometheus-rules.yaml`
- Modify: `services/converact-service/helm/converact/files/grafana-dashboard.json`
- Modify: `docs/converact-monitoring-runbook.md`
- Modify: `test/converact-monitoring-deployment.test.ts`

- [x] Add failing tests for snapshot age, no destination, majority down, failover exhaustion, pin failure,
  5xx/retransmission, rate-limit and Edge availability alerts.
- [x] Add bounded route-agent and Kamailio metrics to rules/dashboard; include WebPhone auth/location and
  DMQ rejection counters while prohibiting call/tenant/number labels.
- [x] Add runbook actions for stale snapshot, drain, OPTIONS disagreement, WebPhone identity/location
  failures, DMQ rejection and rollback.
- [x] Run monitoring tests and YAML/JSON parsing.
- [x] Package Task 7 files in the final goal commit.

## Task 8: Functional and fault acceptance

**Files:**

- Create: `scripts/converact-kamailio-acceptance.ts`
- Create: `test/converact-kamailio-acceptance.test.ts`
- Create: `services/converact-service/acceptance/kamailio-sip-edge/README.md`
- Add SIPp scenarios under: `services/converact-service/acceptance/kamailio-sip-edge/scenarios/`

- [x] Define 12 deterministic scenarios for weighted distribution, re-INVITE/BYE affinity,
  transport/503 retry, 486 no-retry, node drain, node down/up, stale snapshot, forged internal headers,
  public KDMQ rejection, WSS REGISTER refresh and cross-Edge WebPhone delivery.
- [x] Add a bounded WSS acceptance driver that verifies REGISTER, same-connection refresh and unregister
  using a file-only JWT; it requires WSS and exact HTTPS Origin outside explicit loopback tests and never
  writes the token to evidence.
- [x] Implement a strict evidence compiler that requires the exact scenario assertions, immutable image
  digests, source commit, timestamps, bounded artifact paths/bytes and SHA-256. Missing scenarios remain
  `not_run`; physical capacity is always `not_run`.
- [ ] Run controlled Docker acceptance and independently produce the required raw SIPp, Kamailio,
  RustPBX, route-agent and Router/CDR evidence. Environment `not_run`; the compiler does not manufacture
  observations.
- [x] Package Task 8 code and controlled assets in the final goal commit; keep real-environment evidence
  outside the commit until it is actually produced.

## Task 9: Delivery and completion audit

**Files:**

- Modify: `scripts/converact-delivery-bundle.ts`
- Modify: `test/converact-delivery-bundle.test.ts`
- Modify: `docs/capacity/forks/ivekit-forks-v1.json`
- Modify: `docs/converact-fabric-v3-completion-audit.md`
- Modify: `docs/design/revised-master-plan.md`
- Modify: `docs/design/gap-analysis.md`

- [x] Add Kamailio config, route-agent, snapshot schema, Helm/Compose and acceptance assets to the explicit
  delivery allowlist and tamper manifest, including the RustPBX WebPhone Edge-auth patch and WebPhone
  acceptance runtime.
- [x] Remove the obsolete production decision that Kamailio is deferred; retain it only as historical MVP
  context.
- [x] Record code/controlled evidence as completed and physical CPS/PSTN/dual-Zone evidence as `not_run`.
- [x] Run the final typecheck, all focused tests, delivery pack, secret scan, Helm/Compose render and
  `git diff --check` after the audit updates.
- [x] Review the complete diff and resolve findings: authenticate CANCEL before transaction relay, include
  the dispatcher source patch in the standalone delivery, and document WSS query-token log redaction.
- [x] Package the reviewed change set in the final goal commit and push the completed branch.

## Next plans after this one

After Task 9, execute separate implementation plans derived from
`communication-foundation-production-completion.md` for:

1. Tinode production StatefulSet, owner-aware drain/reconnect and data-plane observability.
2. LiveKit SFU + external HA Redis + coturn + LiveKit SIP production pools and recovery.
3. Unified communication SLO, cross-component failure acceptance and release handoff.

Physical load, endurance, public TURN, real PSTN and target dual-Zone Kubernetes remain excluded until all
three plans are complete.
