# LiveKit Production Edge Implementation Plan

> Design: `docs/superpowers/specs/2026-07-11-livekit-production-edge-design.md`
>
> Constraint: local implementation only. Do not upload to or connect to the real server.
>
> Status: Tasks 1-4 implemented and locally verified on 2026-07-11. Task 5 documentation and full regression are in progress. Real-server acceptance remains intentionally open.

## Objective

Build the locally verifiable production edge for the reusable iveKit Media Core:

- separate internal LiveKit service connectivity from browser connectivity;
- fail closed on invalid production WSS configuration;
- render reproducible LiveKit, embedded TURN, Caddy L4, Egress, and storage configuration;
- consume an external Media Core cleanly from OPC Compose and Kubernetes;
- preserve explicit real-server acceptance gates.

## Task 1: Internal and public LiveKit URL contract

**Files**

- Modify: `src/agent-runtime/livekit/config.ts`
- Modify: `src/agent-runtime/livekit/token-service.ts`
- Modify: `src/agent-runtime/ivekit/media-http.ts`
- Modify: `src/env-config.ts`
- Test: `test/livekit-media-module.test.ts`
- Test: `test/ivekit-media-facade.test.ts`
- Add: `test/livekit-config.test.ts`

### Step 1.1: Write failing configuration tests

Cover:

- development falls back from `publicUrl` to the internal URL;
- explicit `LIVEKIT_PUBLIC_URL` wins;
- OPC-prefixed aliases work;
- production does not fall back;
- production rejects `ws://` as a browser URL;
- `isLiveKitConfigured()` remains a server-side check;
- `isLiveKitBrowserJoinConfigured()` requires a valid public URL.

Run:

```bash
node --import tsx --test test/livekit-config.test.ts
```

Expected before implementation: fail because `publicUrl` and browser readiness do not exist.

### Step 1.2: Implement config resolution

Add `publicUrl` to `LiveKitConfig` and central helpers:

```ts
readLiveKitConfig(env = process.env): LiveKitConfig
isLiveKitConfigured(config): boolean
isLiveKitBrowserJoinConfigured(config): boolean
requireLiveKitPublicUrl(config): string
```

Rules:

- internal URL comes from `LIVEKIT_URL` or `OPC_LIVEKIT_URL`;
- public URL comes from `LIVEKIT_PUBLIC_URL` or `OPC_LIVEKIT_PUBLIC_URL`;
- development/test may fall back to internal URL;
- production requires an explicit `wss://` public URL;
- error text must not contain credentials.

### Step 1.3: Route browser tokens to the public URL

Update participant and supervisor token issuance. Keep these internal callers on `config.url`:

- `RoomServiceClient`;
- `AgentDispatchClient`;
- Egress client;
- webhook validation.

Write a regression proving an injected internal URL and public URL produce:

- `token.livekit_url === publicUrl`;
- server client constructed from the internal URL.

### Step 1.4: Expose non-secret capability state

The iveKit capability response should distinguish:

- internal LiveKit configured;
- browser public URL configured;
- browser join ready.

Do not return either URL or any credential.

### Step 1.5: Run focused verification

```bash
node --import tsx --test \
  test/livekit-config.test.ts \
  test/livekit-media-module.test.ts \
  test/ivekit-media-facade.test.ts \
  test/call-center-phase0.test.ts
npm run typecheck
```

## Task 2: Production preflight and current Egress schema

**Files**

- Modify: `scripts/livekit-deployment-preflight.ts`
- Modify: `scripts/render-media-configs.ts`
- Modify: `test/livekit-deployment-preflight.test.ts`
- Modify: `test/media-config-render.test.ts`
- Modify: `.env.example`
- Modify: `infra/env.example`

### Step 2.1: Write failing preflight tests

Cover:

- internal `ws://livekit:7880` plus public `wss://livekit.example.com` passes;
- missing public URL fails for browser targets;
- public `ws://` fails in production;
- media-only server target can still inspect internal configuration separately;
- summary contains both non-secret URL states;
- env checklist contains `LIVEKIT_PUBLIC_URL` and TURN inputs;
- serialized report never contains API secrets, TURN certificate material, or storage secrets.

### Step 2.2: Strengthen preflight

Add checks for:

- `livekit_internal_url`;
- `livekit_public_url`;
- `livekit_public_wss`;
- deployment mode: `external`, `standalone-vm`, or `bundled-dev`;
- standalone VM signal domain, TURN domain, ACME email, RTC/Turn ports;
- pinned media image tags.

The default preflight remains offline. No DNS, TLS, or socket claim is made.

### Step 2.3: Extend the media renderer

Keep current Egress `logging`, `redis`, and `storage.s3` schema. Add:

- `health_port`;
- optional backup storage;
- embedded TURN inputs for standalone VM rendering;
- explicit deployment mode validation;
- a generated, secret-free firewall checklist.

Do not render TURN when mode is `external` or `bundled-dev`.

### Step 2.4: Focused verification

```bash
node --import tsx --test \
  test/livekit-deployment-preflight.test.ts \
  test/media-config-render.test.ts
npm run typecheck
```

## Task 3: Standalone Linux VM Media Core package

**Files**

- Add: `infra/livekit/docker-compose.yml`
- Add: `infra/livekit/env.example`
- Add: `infra/livekit/README.md`
- Add: `infra/livekit/config/redis.conf`
- Add rendered templates under: `infra/livekit/config/`
- Modify: `scripts/render-media-configs.ts`
- Add: `test/livekit-standalone-deployment.test.ts`
- Modify: `package.json`

### Step 3.1: Write deployment contract tests

Statically assert:

- Caddy L4, LiveKit, and Redis use host networking;
- signal and TURN SNI use distinct required domains;
- LiveKit embedded TURN is enabled;
- `443/tcp`, `3478/udp`, `7881/tcp`, and the configured RTC UDP range are documented;
- Egress uses the same Redis and has `SYS_ADMIN` plus a healthcheck;
- all media images use explicit tags;
- no default API secret, MinIO secret, or `latest` appears;
- the stack has no dependency on OPC source code.

### Step 3.2: Render Caddy L4 and LiveKit configuration

Generate into `.runtime/livekit-edge` by default:

- `caddy.yaml`;
- `livekit.yaml`;
- `egress.yaml`;
- `firewall.md`;
- `deployment-summary.json` with secrets represented only as booleans.

The checked-in Compose file mounts generated files and refuses to start when they are absent.

### Step 3.3: Add reproducible commands

Add scripts:

```json
{
  "render:livekit-edge": "node --import tsx scripts/render-media-configs.ts --edge",
  "livekit:edge:config": "docker compose --env-file infra/livekit/.env -f infra/livekit/docker-compose.yml config"
}
```

The repository commits only `env.example`, never a populated `.env` or generated certificate state.

### Step 3.4: Static verification

```bash
node --import tsx --test test/livekit-standalone-deployment.test.ts
docker compose --env-file infra/livekit/env.example \
  -f infra/livekit/docker-compose.yml config
```

This proves rendering and Compose structure only. It does not prove Docker image startup or networking.

## Task 4: OPC Compose and Kubernetes external Media Core integration

**Files**

- Modify: `docker-compose.callcenter.yml`
- Modify: `infra/docker-compose.production.yml`
- Modify: `infra/k8s/values.yaml`
- Modify: `infra/k8s/templates/opc-deployment.yaml`
- Modify: `infra/k8s/templates/ai-agent-deployment.yaml`
- Modify: `infra/k8s/templates/livekit-egress-deployment.yaml`
- Modify: `infra/k8s/templates/livekit-deployment.yaml`
- Test: `test/video-readiness-compose.test.ts`
- Add or modify Kubernetes template tests under `test/`

### Step 4.1: Compose dual-address wiring

Pass both values to OPC:

```yaml
LIVEKIT_URL: ws://livekit:7880
LIVEKIT_PUBLIC_URL: ${LIVEKIT_PUBLIC_URL:-ws://localhost:7880}
```

Production Compose must require `LIVEKIT_PUBLIC_URL` rather than silently defaulting to a container URL. Service-side containers continue to use the internal URL.

### Step 4.2: Pin media image versions and harden Egress

- replace Server/Egress/SIP `latest` or floating minor tags with explicit variables whose defaults are exact tags;
- add Egress health port, healthcheck, and `SYS_ADMIN`;
- keep runtime verification status documented as pending until real images run.

### Step 4.3: Kubernetes external integration

Add `livekit.publicUrl` and wire it only into OPC browser-facing token generation. Keep `livekit.url` for OPC, AI Agent, SIP, and Egress service calls.

Production values examples use:

```yaml
livekit:
  enabled: false
  url: ws://livekit-livekit-server.media.svc.cluster.local:7880
  publicUrl: wss://livekit.example.com
```

The bundled LiveKit template is marked development-only. Fix its Egress schema and Redis so local chart rendering is internally consistent, but do not claim it is a production SFU topology.

### Step 4.4: Static verification

```bash
node --import tsx --test test/video-readiness-compose.test.ts test/livekit-k8s-config.test.ts
docker compose --env-file infra/env.example -f infra/docker-compose.production.yml config
```

If Helm is unavailable locally, record that limitation and validate templates with repository-level static tests.

## Task 5: Documentation, review, and full verification

**Files**

- Modify: `docs/审核文档.md`
- Modify: `docs/ivekit-led-integration-guide.md`
- Modify: `docs/ivekit-openapi.md`
- Modify: `docs/livekit-im-full-capability-plan.md`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`
- Modify: design and plan status

### Step 5.1: Update authoritative docs

Document:

- internal/public URL contract;
- standalone VM ports, DNS, TLS and TURN requirements;
- external Kubernetes Media Core contract;
- exact API behavior change without a response schema break;
- image compatibility status;
- commands and evidence boundaries.

Every document must keep real-server items unchecked:

- DNS and ACME certificate issuance;
- real WSS connection;
- ICE UDP/TCP and forced TURN relay;
- two-browser audio/video/screen share;
- Egress object creation;
- multi-replica and performance evidence.

### Step 5.2: Review the diff

Check:

- no secret values;
- no SQLite production path;
- no user changes reverted;
- no public browser path receives an internal URL;
- no `latest` remains in the media production path;
- no static test is described as real network evidence.

### Step 5.3: Full verification

```bash
npm test
npm run typecheck
npm --prefix frontend run build
node --import tsx scripts/check-sidecars.ts all
npm run test:ai-agent
docker compose --env-file .env.example -f docker-compose.callcenter.yml config
docker compose --env-file infra/env.example -f infra/docker-compose.production.yml config
git diff --check
```

### Step 5.4: Commit and push

Commit in reviewable units after each verified task, then merge to `main` and push GitHub. Do not deploy or upload to the real server.

## Real-server acceptance retained after this plan

The following remain part of the active goal and cannot be marked complete locally:

1. DNS and trusted certificates for signal and TURN domains.
2. Docker image pull/start on Linux host networking.
3. Browser WSS and selected ICE candidate evidence.
4. Forced TURN relay from a restricted network.
5. Two-browser audio, video, and screen sharing.
6. Egress recording and MinIO object persistence.
7. LiveKit multi-node routing, draining, reconnect, concurrency, and performance.
