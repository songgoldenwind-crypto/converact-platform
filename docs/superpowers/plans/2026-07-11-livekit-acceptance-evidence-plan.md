# LiveKit Acceptance Evidence Implementation Plan

> Design: `docs/superpowers/specs/2026-07-11-livekit-acceptance-evidence-design.md`
>
> Constraint update: implementation remains local-first. A read-only SSH/server inventory was completed on 2026-07-11; no upload, deployment, or server mutation is part of this implementation commit.

## Objective

Build a reproducible LiveKit acceptance evidence toolchain that can later run in the real OPC/LED environment without changing the Media Core business implementation.

## Task 1: Persist a sanitized video readiness report

**Files**

- Modify: `scripts/video-readiness-suite.ts`
- Modify: `test/video-readiness-suite.test.ts`
- Modify: `.env.example`

### Tests first

Cover:

- success report contains target/status/duration/hashes and no raw stdout;
- signed invite, Bearer token, JWT-like text and query strings are absent;
- partial failure report is written before CLI exits non-zero;
- output parent directory is created;
- no output file means existing stdout behavior remains compatible.

### Implementation

Add:

```ts
createVideoReadinessArtifact(result, checkedAt?)
writeVideoReadinessArtifact(outputFile, result, checkedAt?)
```

Use `OPC_VIDEO_READINESS_REPORT_FILE`. Keep in-memory stdout for media-to-customer handoff, but persist only SHA-256 and a redacted error summary.

## Task 2: Automated LiveKit server evidence

**Files**

- Add: `scripts/livekit-server-evidence.ts`
- Add: `test/livekit-server-evidence.test.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `infra/livekit/env.example`

### Tests first

Use injected probes; do not access network.

Cover:

- complete DNS/TLS/TCP/UDP/health probes produce `ok=true`;
- one failed TLS or RTC TCP probe makes the report fail;
- same signal/turn host is rejected for standalone topology;
- invalid port/timeout/URL fails during config parsing;
- TLS must be authorized and not expired;
- UDP details state that send success is not an ICE/TURN handshake;
- output JSON contains no URL credentials/query or secret values.

### Implementation

Export config/result/probe interfaces and:

```ts
createLiveKitServerEvidenceConfigFromEnv(env)
collectLiveKitServerEvidence(config, probes?)
writeLiveKitServerEvidence(config, probes?)
```

Default probes use Node DNS, net, dgram, tls and http/https modules. The script exits non-zero when any required check fails.

## Task 3: Real client acceptance validator

**Files**

- Add: `scripts/livekit-client-acceptance.ts`
- Add: `test/livekit-client-acceptance.test.ts`
- Modify: `package.json`

### Tests first

Cover:

- a complete real-environment report passes;
- missing check, `passed=false`, empty evidence and placeholder evidence fail;
- `source` other than `real_environment` fails;
- invalid checked_at, commit SHA, topology or version fields fail;
- performance target not reached fails;
- generated template is intentionally incomplete;
- runbook contains every required evidence group and final evidence command.

### Implementation

Add template/runbook writers and validator. Keep required check IDs in one exported constant used by generation and validation.

## Task 4: Final evidence pack

**Files**

- Add: `scripts/livekit-evidence-pack.ts`
- Add: `test/livekit-evidence-pack.test.ts`
- Modify: `package.json`

### Tests first

Cover:

- complete artifacts produce `ready_for_customer_review`;
- missing artifact produces `incomplete` with exact missing key;
- failed/invalid preflight, server evidence, readiness or client report fails;
- readiness must include all required target names;
- artifacts record SHA-256, size and lines;
- Markdown never embeds raw JSON or secrets;
- CLI exits non-zero for incomplete evidence while still writing the Markdown.

### Implementation

Required artifact keys:

- env checklist;
- preflight report;
- server evidence;
- readiness report;
- client acceptance report;
- client acceptance result;
- server runbook;
- client runbook.

Evidence pack calls the same client validator rather than trusting an arbitrary `ok` field.

## Task 5: Acceptance bundle

**Files**

- Add: `scripts/livekit-acceptance-bundle.ts`
- Add: `test/livekit-acceptance-bundle.test.ts`
- Modify: `package.json`
- Modify: `.env.example`

### Tests first

Cover:

- bundle creates deterministic artifact names;
- initial manifest says `awaiting_real_environment_evidence`;
- initial evidence pack is incomplete;
- manifest commands point to files in the same bundle;
- env checklist and preflight are generated without secret values;
- no server evidence/readiness/client result is forged locally.

### Implementation

`OPC_LIVEKIT_ACCEPTANCE_BUNDLE_DIR` is required. Generate runbooks, template, preflight artifacts, initial evidence pack and manifest.

## Task 6: Documentation and final verification

**Files**

- Modify: `docs/审核文档.md`
- Modify: `docs/ivekit-led-integration-guide.md`
- Modify: `docs/ivekit-openapi.md`
- Modify: `docs/livekit-im-full-capability-plan.md`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`
- Modify: `infra/livekit/README.md`

Document command order, artifact ownership, evidence strength and the still-unexecuted real environment gates.

Run:

```bash
npm test
npm run typecheck
npm --prefix frontend run build
GOCACHE=/private/tmp/opc-go-build-cache node --import tsx scripts/check-sidecars.ts all
PYTHONPATH=services/ai-agent-py services/ai-agent-py/.venv/bin/pytest services/ai-agent-py/tests -q
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file .env.example -f docker-compose.callcenter.yml config --quiet
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file infra/env.example -f infra/docker-compose.production.yml config --quiet
npm run livekit:edge:config
git diff --check
```

Commit, fast-forward main and push GitHub only after all local evidence passes. Do not deploy the server.

## Real environment work retained

The active goal remains open until the generated bundle contains real artifacts for DNS/TLS/WSS, ICE UDP/TCP, forced TURN UDP/TLS, two-browser audio/video/screen sharing, customer/Web Assist, Egress object/export/checksum, lifecycle, tenant/RLS isolation, LED SDK, restart/reconnect, multi-replica routing, SIP and declared performance targets.

## Post-review hardening completed

The independent review identified fail-open and self-attestation risks in the first implementation. The implementation now additionally requires:

- structured JSON artifacts with check IDs, run metadata, details and recomputed full SHA-256 for every passed client check;
- a distinct QA approver and Ed25519-signed attestation JSON verified by a preconfigured trusted public key;
- one CLI-bound run/start/environment/commit/mode/deployment fingerprint and a current 24-hour evidence window;
- exact schema/`ok`/check-set validation and exact recomputation of the client result;
- a new directory for each run, with existing real evidence causing bundle initialization to fail;
- mutually exclusive template/report CLI modes and non-colliding report/output paths.
