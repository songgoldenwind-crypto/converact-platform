# iveKit Wave 2 Valkey Sentinel Implementation Plan

> 状态：受控服务器验收已完成；生产切换门仍未完成
> 日期：2026-07-23
> 验证位置：`64.225.122.227`；本机只编辑和静态检查

**Goal:** 在不立即替换生产 Redis 的前提下，让 OPC/iveKit 与 LiveKit Server、Egress、Ingress、SIP 具备同一套 Valkey/Redis Sentinel、ACL 和 TLS 连接合同，并在服务器完成真实主故障切换验收。

**Architecture:** PostgreSQL 继续承载权威状态，Valkey 只承载可恢复的缓存、路由、presence 与 Pub/Sub。应用支持 `direct` 和 `sentinel` 两种互斥拓扑；所有消费者必须指向同一逻辑主节点，配置非法时启动失败，不允许静默退回单节点。当前 Redis 保留为回滚目标，Valkey 切换前不做双写。

**Tech Stack:** Valkey 9.1.x、Redis Sentinel protocol、ioredis 5.11.1、LiveKit shared Redis config、TypeScript、Helm、Docker Compose acceptance。

**Controlled Result:** `valkey-1` 冻结后由 `valkey-3` 接任；选主观测值 `6871 ms`，生产 ioredis 路径恢复观测值 `8594 ms`。原 canary、故障后写读和故障前后 Pub/Sub 均通过。证据见 `docs/evidence/wave2-valkey-sentinel-runtime-2026-07-23.json`。

---

## File Map

- Create `src/infra/redis-connection-options.ts`: 解析并验证 direct/sentinel、ACL、TLS、超时和重连配置，不建立连接。
- Modify `src/redis-client.ts`: 使用统一 options 创建 ioredis 数据客户端，保留显式测试内存实现。
- Modify `src/redis-pubsub.ts`: publisher/subscriber 使用相同 topology，连接失败时彻底断开。
- Create `test/redis-connection-options.test.ts`: 覆盖 direct/sentinel 正向配置及所有冲突配置。
- Create `docs/architecture/valkey-command-inventory-v1.json`: 固定当前 OPC/iveKit 与 LiveKit 使用的命令和语义门槛。
- Modify `.env.example`, `infra/env.example`, `services/ivekit-service/env.example`: 声明 topology、Sentinel、ACL、TLS 和 bounded reconnect 变量。
- Modify `infra/k8s/values.yaml` and LiveKit templates: Server、Egress、Ingress、SIP 统一渲染 direct/sentinel Redis 配置。
- Modify `scripts/render-media-configs.ts`: VM/Compose 媒体配置支持相同 Sentinel/TLS 输入。
- Create `services/ivekit-service/acceptance/valkey-sentinel/`: 三个 Valkey 数据节点、三个 Sentinel 及主故障验收入口。
- Create `docs/deployment/valkey-sentinel-migration.md`: 迁移、回滚、监控、故障注入和不得宣称通过项。

## Task 1: Unified Redis Connection Contract

- [x] Write `test/redis-connection-options.test.ts` first. It must expect:
  - direct mode accepts one credential-free `redis://` or `rediss://` endpoint;
  - sentinel mode accepts 3 bounded `host:port` addresses and one master name;
  - ACL data credentials and Sentinel credentials are independent;
  - TLS files require TLS mode and certificate/key are paired;
  - URLs containing credentials, mixed direct/sentinel inputs, duplicate/invalid addresses, unbounded numbers and unknown modes throw without logging secrets.
- [x] Sync the test to the server and run it before implementation. Expected result: module-not-found or missing-export failure attributable only to the absent contract.
- [x] Implement `resolveRedisConnectionOptions()` with a narrow result type usable by ioredis.
- [x] Sync implementation and run the test on the server. Expected result: all connection-option cases pass.

## Task 2: iveKit Data and Pub/Sub Clients

- [x] Add failing cases proving `getRedisClient()` and `getRedisPubSub()` receive the same resolved Sentinel options and disconnect every partially connected client on failure.
- [x] Replace the duplicated URL-only constructors with the shared resolver/factory while preserving `OPC_USE_MEMORY_REDIS=1` only as an explicit controlled-test path.
- [x] Keep application startup behavior unchanged in this task: existing optional Redis consumers may fall back only where the existing contract already permits it; production preflight will later require external coordination explicitly.
- [x] Run Redis-focused and WebSocket fanout regression on the server.

## Task 3: LiveKit Redis Topology Contract

- [x] Add failing Helm/render tests for `direct` and `sentinel` modes across LiveKit Server, Egress, Ingress and SIP.
- [x] Add `livekit.redis.mode`, `sentinelMasterName`, `sentinelAddresses`, Sentinel ACL fields and TLS file fields.
- [x] Require direct address only in direct mode; require 3 Sentinel addresses and no direct address in sentinel mode.
- [x] Render exactly the same Redis block into every LiveKit component. Never let Egress, Ingress or SIP point at a different logical Redis authority.
- [x] Run Helm lint/template and negative renders on the server.

## Task 4: VM/Compose Media Configuration

- [x] Add failing tests for environment-to-YAML Sentinel/TLS rendering and secret redaction.
- [x] Extend `scripts/render-media-configs.ts` without changing the existing direct-mode default.
- [x] Reject a mixed or incomplete topology before writing any output file.
- [x] Run the media renderer/preflight regression on the server.

## Task 5: Valkey Compatibility Inventory

- [x] Record the exact command surface: `GET`, `SET EX NX`, `DEL`, `HSET`, `EXPIRE`, `PUBLISH`, `SUBSCRIBE`, connection/auth/role and Sentinel discovery. Record LiveKit queue/pubsub compatibility as a separate integration gate rather than guessing internal commands.
- [x] Add a validator test that rejects an inventory without owner, durability class, failover expectation and evidence state for every command group.
- [x] Keep Lua, Streams, Cluster and numbered database claims absent unless source inventory proves they are used.

## Task 6: Controlled Sentinel Failover Acceptance

- [x] Add an isolated Compose acceptance package using immutable Valkey 9.1.x image identity, ACL, three persistent data nodes and three Sentinel voters.
- [x] The acceptance runner writes a canary, verifies Pub/Sub, pauses the elected primary while retaining stable identity, waits for a different primary, reconnects through Sentinel, reads the original canary, writes/reads a second canary and verifies Pub/Sub again.
- [x] Bound every wait and retry; collect role, replication offset, failover time, reconnect time and data result without writing credentials to evidence.
- [x] Always clean its own containers, network and volumes. It must refuse a shared Compose project name.
- [x] Execute only on `64.225.122.227`; confirm LED remains exactly seven running containers afterward.

## Task 7: Governance and Migration Closure

- [x] Update the technology baseline and authority matrix to record controlled failover passed while retaining `replacement`, `default_enabled=false` until production cutover gates pass.
- [x] Document production choices: managed Valkey/Redis Sentinel is eligible after target-environment validation; the upstream Valkey Operator remains POC while upstream labels it WIP.
- [x] Define rollback as DNS/Secret/config switch back to the frozen Redis service before retirement; no per-request dual write.
- [x] Keep target Kubernetes, cross-Zone partition, LiveKit real rooms/Egress/Ingress/SIP under failover, soak and capacity as `not_run` until separately evidenced.

## Verification Commands

All dynamic commands run on the validation server:

```bash
node --import tsx --test test/redis-connection-options.test.ts test/redis-fallback-disconnect.test.ts test/ws-targeted-broadcast.test.ts
helm lint infra/k8s -f <render-only-image-values>
helm template opc-platform infra/k8s -f <sentinel-values>
IVEKIT_VALIDATION_SERVER_IP=64.225.122.227 sh services/ivekit-service/acceptance/valkey-sentinel/accept.sh
```

Local checks are limited to:

```bash
node --check <changed-js-or-mjs>
bash -n <changed-shell>
jq empty <changed-json>
git diff --check -- <changed-files>
```

## Completion Boundary

This plan is complete when code, deployment contracts, controlled failover acceptance and evidence documents pass on the server. It does not by itself authorize production cutover or prove target Kubernetes, cross-Zone HA, LiveKit media continuity, soak, throughput or MIX-100K capacity.
