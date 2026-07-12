# iveKit V2 独立服务与可靠实时同步实施计划

更新日期：2026-07-12

开发分支：`codex/ivekit-v2-realtime-standalone`

基线提交：`488f7b3`

## 1. 目标

iveKit V2 要把 V1 已完成的 IM、LiveKit 音视频、RustDesk 远程协助和统一协作客户端，收敛为真正可独立构建、部署、升级和交付的通用服务，同时补齐实时链路中仍依赖内存或全量快照的可靠性缺口。

本 Goal 完成后，LED 或其他项目应只依赖以下交付物：

1. iveKit 独立服务镜像和可审计的独立构建上下文。
2. iveKit PostgreSQL fresh-install foundation schema 和后续 migration。
3. `@opc/ivekit-sdk`、参考客户端 dist 和稳定 `/api/ivekit/*` 契约。
4. LiveKit、Tinode、RustDesk 的独立 provider 配置和 Compose。
5. 升级、回滚、故障恢复和本地验收材料。

本 Goal 原计划只做本地交付门禁；2026-07-12 按用户最新要求增加服务器隔离验证。服务器已验证独立镜像、fresh PostgreSQL、迁移、RLS、health 和真实 Tinode inbound E2E；尚未执行的 LiveKit、RustDesk 等 provider 场景仍不得写成 V2 已验收。

### 1.1 当前执行状态（2026-07-12）

| 里程碑 | 状态 | 已有证据 | 剩余工作 |
| --- | --- | --- | --- |
| M6.1 独立构建边界 | 已实现并上服验证 | 79 个白名单源码文件、6 个运行依赖；隔离 `npm ci`/build 通过；服务器 Docker build 和 `/health` 通过 | 纳入最终全量回归与发布门禁 |
| M6.2 Standalone PostgreSQL | 已完成 | fresh schema 45 表、31 个 checksum migration、0 RLS gap、0 OPC 业务表；existing OPC 数据无损升级；runtime 跨租户读写、DDL 和迁移账本访问均被拦截；失败后前向重试通过 | 纳入 M6.7 最终全量回归 |
| M6.3 Tinode inbound | 已完成 | provider user mapping、cursor/lease、幂等 inbox、普通消息/Drafty 附件/edit/delete projector、policy scan、AI 质检入队、脱敏死信与到期重试、WebSocket 断线续拉、应用生命周期和部署参数均已实现；本地协议/worker/真实 PostgreSQL 测试通过；服务器真实 Tinode E2E、服务离线后补偿、重启幂等、RLS 和凭据隔离均通过 | 纳入 M6.7 最终全量回归 |
| M6.4 Durable event replay | 已完成 | 32 号 migration、单调 event ID、签名/租户绑定/过期 cursor、当前参与人/RBAC 过滤、定向 audience、HTTP 增量页、WebSocket resume、请求事务后缓冲、持久化后 Redis fan-out、实例回送去重、retention worker 和独立回滚开关均已实现；本地/真实 PostgreSQL/standalone 门禁通过；服务器完成进程重启恢复、撤权、非法/跨租户 cursor、定向 audience、RLS、retention 与幂等复验 | 纳入 M6.7 最终全量回归 |
| M6.5 RustDesk edge spool | 代码完成，待最终回归 | crash-safe filesystem spool、执行 intent/result、恢复租约、terminal ack、uncertain/ownership quarantine、容量/年龄/权限/符号链接/单实例门禁和 preflight 已实现；专项测试通过 | 纳入 M6.7 全量回归与服务器故障注入 |
| M6.6 SDK、交付、兼容 | 未开始 | V1 SDK/交付包可复用 | 升级 cursor API、独立 Compose 和升级回滚材料 |
| M6.7 完成审计 | 未开始 | 局部门禁通过 | 全量 verify、兼容矩阵、故障恢复和最终状态审计 |

## 2. 现状审计

### 2.1 独立服务仍依赖完整 OPC 源码

当前 `src/ivekit-server.ts` 已经是 iveKit-only 运行入口，`src/agent-runtime/ivekit/http-server.ts` 也只开放 iveKit、LiveKit webhook、RustDesk launch、health 和 metrics 路由，但构建边界仍不独立：

1. 根 `Dockerfile` 会复制完整 `src/`、`scripts/`、`shared/`、`public/` 和 `config/`。
2. iveKit Compose 仍依赖从完整 OPC 仓库构建出的应用镜像。
3. 服务入口仍从根模块读取 PostgreSQL、认证、WebSocket、metrics、对象存储和兼容数据库 helper。
4. V1 交付包只交付镜像名，没有交付可在独立目录构建该镜像的 source/build context。

因此 V1 证明了独立运行入口，尚未证明服务端可以脱离完整 OPC 源码构建。

### 2.2 fresh database 仍创建完整 OPC schema

当前 `scripts/run-postgres-migrations.ts` 调用根 `runMigrations()`，fresh database 会执行 `005_full_schema.sql`。该 migration 明确创建 OPC 应用所需的 137 张表，然后再执行 collaboration/media/RustDesk migration。

iveKit 运行时实际需要的基础对象包括：

- tenant/RLS：`tenants`、tenant context helper、runtime role privilege。
- media：`livekit_rooms`、`livekit_participants`、`call_recordings`、`evidence_records`、`audit_logs`。
- collaboration：session、participant、message、attachment、receipt、mutation、finding、quality job。
- remote：remote assistance、consent、audit、evidence、RustDesk device/gateway/command/access/control。
- unified：media call/action/moderation、统一 timeline 所需索引。

独立部署不能再以完整 `005_full_schema.sql` 作为基础，但现有 OPC 数据库升级路径必须保持不变。

### 2.3 V1 基线的 Tinode worker 只有出站重试（M6.3 已解决）

`TinodeSyncWorker` 当前实际封装 `TinodeMessageDeliveryService.runDue()`，只负责 PostgreSQL outbox 到 Tinode 的 durable publish。它没有：

- topic 订阅和断线重连；
- `data.seq` durable cursor；
- provider event 去重；
- Tinode 原生消息回写本地镜像；
- Drafty 附件映射；
- `head.replace` 编辑版本；
- `meta.del.clear/delseq` 删除同步。

因此 V2 会保留现有 outbound worker，并新增语义独立的 inbound synchronization worker，不继续用一个 `sync` 名称混合两种状态机。

M6.3 已按上述设计完成：inbound worker、真实 WebSocket source、durable cursor/inbox/dead letter、事务 projector 和 provider 坐标 DTO 均已落地并完成服务器验收。本节保留为问题来源和设计依据。

### 2.4 V1 基线的租户事件流不可 replay（M6.4 已解决）

`src/ws.ts` 当前先向本进程 socket 广播，再通过 Redis pub/sub 扩散。Envelope 只有 `type/data/timestamp`，没有持久事件 ID、cursor、ack 或 replay：

1. 客户端断线期间事件会丢失。
2. 重连只能重新请求 snapshot。
3. Redis pub/sub 重复或跨实例回送没有 durable dedupe。
4. 定向用户事件没有可验证的 replay visibility。

V2 必须让 WebSocket 保持加速通道，同时提供 PostgreSQL durable event log 和按用户可见性过滤的 replay cursor。

M6.4 已新增 `ivekit_tenant_events`、`GET /api/ivekit/events` 和 WebSocket resume。请求内广播先缓冲，业务事务成功后按顺序 append，再进行本机/Redis fan-out；非法、过期和跨租户 cursor 显式要求 snapshot。本节保留为问题来源和设计依据。

### 2.5 RustDesk edge command result 只在内存中

`RustDeskEdgeCommandProcessor.pending` 当前只保存在进程内存。wrapper 已执行但 progress/result 上报失败时，同一进程会先重报；进程崩溃后 pending 丢失，lease 到期可能再次执行物理断开操作。

V2 必须提供本地持久 spool，并且不能把 command token、stdout/stderr 原文、剪贴板、文件内容或屏幕内容写入磁盘。

## 3. 范围边界

### 3.1 本 Goal 必须完成

1. 独立 source/build context、独立 package manifest、独立 OCI image。
2. fresh standalone PostgreSQL foundation 和 existing OPC upgrade 两条迁移路径。
3. Tinode inbound message、Drafty attachment、replacement、deletion 同步。
4. topic/seq/del cursor、幂等、补偿、重连和 poison event 隔离。
5. tenant event durable log、opaque cursor、replay 和 WebSocket resume。
6. RustDesk edge pending result crash recovery。
7. SDK、客户端、Compose、交付包、升级回滚文档和自动化门禁。
8. 为后续 OCR、ASR、AI 质检、翻译和 SIP/VoLTE 共用模块建立独立 service extension boundary，禁止这些能力反向依赖 OPC call-center 业务。

### 3.2 明确不纳入

1. RTMP/HLS 直播。
2. 数字人。
3. V2 的 DNS/证书、真实摄像头和真实 hbbs/hbbr 重验；独立镜像与 PostgreSQL 的服务器隔离验证已纳入。
4. OPC call-center、IVR、CRM、外呼和坐席业务功能。

### 3.3 已纳入共用底座后续目标

以下能力必须由 iveKit 共用层提供给 LED 和其他项目，不放进 LED 业务代码，也不再作为长期排除项：

1. 图片 OCR、音视频 ASR 和 AI 质检，支持 self-hosted 与 third-party provider。
2. 消息和附件提取文本的按需/自动翻译、结果缓存、审计和人工复核。
3. LiveKit SIP/VoLTE trunk、dispatch rule、入呼/外呼、DTMF、录制和呼叫生命周期。

当前 M6 先保证独立 service/schema/event extension boundary 可以承载这些模块；完整产品实现分别进入 V3 和 V4 Goal，避免与实时可靠性状态机一次性混写。

## 4. 不变量

1. 现有 `/api/ivekit/*` URL、SDK 方法和返回 DTO 默认保持兼容。
2. LED 不直接访问 PostgreSQL、Tinode root credential、LiveKit secret 或 RustDesk control token。
3. PostgreSQL 是唯一服务端业务数据库，不引入 SQLite。
4. 新 standalone schema 与现有 OPC schema 使用相同表名和 migration version，避免双模型漂移。
5. 所有 provider event 至少一次接收、业务效果幂等；不得声称 exactly-once transport。
6. cursor 必须 opaque、版本化、资源绑定、tenant 绑定并防篡改。
7. WebSocket replay 与 snapshot 都必须执行当前参与人/RBAC 可见性校验。
8. provider 原始 payload 只保留白名单字段；不落 provider credential、任意 metadata 或附件 bytes。
9. RustDesk spool 不保存 command bearer token；claim token 只允许加密保存或不保存。首版采用不保存 token，重启后通过 command recovery API 换取新的短 lease/token。
10. 本地 controlled E2E、mock 和 Compose config 不得提升真实环境 `not_run` 状态。

## 5. 目标架构

```text
LED / other host
  -> @opc/ivekit-sdk / reference client
  -> iveKit standalone HTTP + WebSocket
       -> PostgreSQL foundation + communication migrations
       -> durable tenant event log -> replay cursor -> WebSocket
       -> Tinode outbound delivery worker
       -> Tinode inbound sync worker
            -> topic binding discovery
            -> data/del catch-up
            -> message/attachment/mutation projector
            -> durable cursor + dead letter
       -> LiveKit adapter / webhook / recording evidence
       -> optional intelligence providers (OCR / ASR / AI quality)
       -> optional translation provider
       -> optional LiveKit SIP / VoLTE plane
       -> RustDesk control plane
       -> attachment and quality workers

RustDesk edge
  -> command claim
  -> durable local spool (sanitized execution result)
  -> wrapper execution
  -> progress/result retry
  -> recovery lease after restart
```

## 6. 里程碑

### M6.1 独立构建边界

目标：生成一个离开 OPC 仓库后仍可执行 `npm ci && npm run build` 和 `docker build` 的 iveKit service context。

任务：

1. 增加 `services/ivekit-service/` 作为独立 package/build owner。
2. 建立显式 source manifest，只允许 iveKit、collaboration、LiveKit、media gateway、tenant/RLS、auth、object storage、metrics 和 WebSocket 所需模块。
3. 将共享依赖收敛到 iveKit-owned adapter；禁止 import call-center、IVR、campaign、billing、CRM 和通用 OPC server。
4. 独立 package 只声明实际运行依赖，不复制根 package 的 Stripe/NATS 等无关依赖。
5. 增加 dependency-boundary test，递归解析静态和动态 import；越界直接失败。
6. 增加独立 `Dockerfile`，最终镜像只复制 compiled service、production dependencies、migration 和必要静态文件。
7. 增加 standalone build-context 生成器和 manifest/SHA-256；在临时目录实际执行独立 typecheck/build。

验收：

- 构建上下文不含 `src/agent-runtime/call-center/`、`src/agent-runtime/ivr/`、frontend 和测试。
- 删除/隔离 OPC 根源码后，独立 package 仍可 build 和启动 health endpoint。
- OCI build context 不引用 `../..`。
- V1 URL、SDK 和 reference client contract tests 不回归。

### M6.2 Standalone PostgreSQL foundation

目标：fresh database 不再执行 137 表完整 OPC schema。

任务：

1. 增加 iveKit foundation migration，创建 tenant、RLS helper、audit、LiveKit room、recording、evidence 等通信域前置对象。
2. 建立 standalone migration manifest，显式包含 foundation 和 `011` 到后续 iveKit migration，排除 IVR `023`、legacy runtime `031` 等非通信 migration。
3. 保留根 OPC migration runner，existing OPC database 不重复创建或重编号。
4. foundation 对已有表使用兼容 DDL；禁止 destructive rename/drop。
5. 对 migration 文件建立 checksum 和 applied checksum 校验，已应用版本被修改时 fail closed。
6. 分离 admin migrate role 与 runtime role；runtime 无 schema_migrations 和 DDL 权限。
7. 增加 fresh install、existing OPC upgrade、重复执行、回滚前向恢复和跨租户 RLS 集成测试。

验收：

- fresh standalone schema 只包含 iveKit 所需表。
- migration 后所有 tenant 表 `ENABLE/FORCE RLS`。
- runtime role 跨租户读写失败。
- existing OPC schema 执行 standalone runner 不破坏数据且不重复版本。

### M6.3 Tinode inbound synchronization

目标：任何通过允许的 Tinode 客户端写入 topic 的业务事件，最终都进入 iveKit 本地镜像、policy/audit 和统一事件流。

数据模型：

- `tinode_inbound_cursors`：tenant、binding、topic、last_data_seq、last_del_id/clear、lease、error state。
- `tinode_inbound_events`：topic、event kind、provider seq/version、payload hash、processing status、唯一幂等键。
- `tinode_inbound_dead_letters`：只保存脱敏错误码、payload hash 和可重试时间，不保存 credential。
- message 增加 provider origin/seq/version 唯一约束。

协议映射：

1. 普通 `data.seq` 映射为 message created。
2. iveKit outbound publish 必须携带稳定 OPC message ID；inbound 发现本地 ID 时只确认 provider seq，不复制消息。
3. `head.replace=msg:<target_seq>` 映射为原发送者 edit；校验 target、sender、session 和 mutation window/provider policy。
4. `meta.del.clear/delseq` 映射为 provider deletion；范围必须展开为已知本地 provider seq，禁止跨 topic。
5. Drafty `IM/VD/AU/EX` entity 只接收 HTTPS/允许域名的 `ref/preref`、mime、name、size、duration、width/height；内嵌 `val` bytes 不写入数据库。
6. 未支持内容进入 dead letter 和 audit，不阻塞 cursor 后续推进。

worker 行为：

1. 按 active `collaboration_chat_bindings` 分片 claim。
2. 使用 Tinode service account 登录并订阅 topic。
3. 从 durable cursor 请求 later data 和 later del，先写 event inbox 再投影业务表。
4. PostgreSQL transaction 内完成 event claim、投影、policy scan、cursor advance 和 tenant event append。
5. 崩溃后重复 provider event 由唯一键重放为同一业务结果。
6. 认证失败暂停 provider，不自旋；网络失败有有界退避和 jitter；poison event 单独 dead-letter。

验收：

- 重复、乱序、断线、历史补偿、worker 双实例和事务中断均不产生重复 message/mutation。
- provider 编辑/删除不能绕过参与人和 session 约束。
- attachment URL、mime、size 和 entity 数量都有上限。
- inbound message 自动执行防绕单文本扫描，并按现有配置 enqueue AI quality review。

完成证据（2026-07-12）：

- 提交：`2fb74f4b142a4169cf593b16fa11208148533652`。
- 服务器隔离项目：`ivekit-v2-2fb74f4`，HTTP 仅绑定 `127.0.0.1:18303`。
- 真实 Tinode 链路完成 plain message、`head.replace` edit、Drafty image reference 和 provider delete；本地最终保留 seq 1/3 语义对应的 2 条有效消息、1 个附件、3 条 mutation、3 条 policy event、2 个 quality job，dead letter 为 0，敏感正文未进入验收结果文件。
- 停止 iveKit 后向真实 Tinode 发布 seq 4，重启后 cursor 从 3 追到 4；再次重启 message/inbox/policy/quality 数量不增长，worker failure 为 0。
- 最终 PostgreSQL 为 31 个 checksum migration、45 张表、0 RLS gap；runtime role 四项管理员标志均为 false，跨租户读取为 0、写入被拒绝，长驻容器只使用 `opc_runtime`。
- 服务器证据文件：`/opt/ivekit-v2-validation/2fb74f4/tinode-inbound-acceptance-result.json` 与 `/opt/ivekit-v2-validation/2fb74f4/final-audit-result.txt`，权限均为 `600`。

### M6.4 Durable tenant event replay

目标：客户端从短暂断线恢复时按 cursor 增量收敛，不必总是全量刷新。

数据模型与 API：

1. `ivekit_tenant_events`：monotonic event ID、tenant、type、resource refs、audience、safe payload、occurred_at、expires_at。
2. `GET /api/ivekit/events?cursor=&limit=`：当前 viewer 可见事件分页。
3. WebSocket URL 或首个 resume frame 接收 opaque cursor。
4. connected envelope 返回 `head_cursor`、`replay_from` 和是否需要 snapshot。

语义：

1. 业务 transaction 完成后，先持久 append，再尝试 Redis/WebSocket fan-out。
2. 每个 envelope 返回稳定 `event_id/cursor/type/data/timestamp`。
3. cursor 过期、越租户、签名错误返回明确 `snapshot_required`，不静默跳过。
4. audience 支持 tenant-wide 和 user IDs；replay 重新执行当前 membership/RBAC，不能只信历史 audience。
5. 客户端按 event ID 去重；收到 gap、未知版本或 projection failure 时回退 snapshot。
6. retention worker 分 tenant 删除过期 event，不影响业务审计表。

客户端改造：

1. access token 与 cursor 都只保存在内存；宿主可以通过 host bridge 提供短期 resume cursor，但默认不落 localStorage/sessionStorage。
2. Chat、Calls、Remote、Context timeline 分别声明可处理 event type。
3. replay 完成后再切 live，避免 replay/live 竞态倒序。

验收：

- 断线期间的 create/edit/delete/receipt/call/recording/remote event 可按序 replay。
- 多实例 Redis 重复 fan-out 不重复 UI projection。
- 用户离开 session 后不能 replay 旧敏感资源事件。
- cursor retention 过期时客户端自动 snapshot 收敛。

本地完成证据（2026-07-12）：

- `042_ivekit_tenant_events.sql` 使用全局 `BIGINT IDENTITY`、24 小时默认 retention、audience 和 chat/media/remote visibility scope，并启用 `ENABLE/FORCE RLS`。
- HTTP 无 cursor 返回当前 head；合法 cursor 返回当前 viewer 可见增量；篡改、越租户和过期 cursor 返回 `409 snapshot_required`。
- WebSocket `connected` 返回 `head_cursor/replay_from/replayed_events/snapshot_required`，断线期间事件按 event ID 重放；每个 envelope 返回 `event_id/cursor/type/data/timestamp`。
- 当前参与人过滤、离开会话后撤权、严格定向 audience、请求缓冲、Redis 源实例回送去重和客户端 event ID 去重均有自动化测试。
- 独立开关为 `OPC_IVEKIT_EVENT_REPLAY_ENABLED`；retention、payload 上限和 WS replay 上限分别由 `OPC_IVEKIT_EVENT_RETENTION_MS`、`OPC_IVEKIT_EVENT_MAX_PAYLOAD_BYTES`、`OPC_IVEKIT_WS_REPLAY_MAX_EVENTS` 控制；过期清理 worker 使用安全 tenant 枚举函数并在 runtime RLS 事务内分批删除。
- fresh standalone PostgreSQL 当前为 32 个 checksum migration、46 张表；事件 append/head/list、RLS、runtime sequence 权限和 existing OPC 无损升级通过。服务器提交 `823d28a` 的 HTTP/WS 重放各恢复 2 个事件，撤权后 0、定向 admin 0、跨租户读 0/写阻断、迁移和重启前后 event 计数均为 `6,6`，retention 删除通过且 worker failure 为 0。

### M6.5 RustDesk edge crash-safe spool

目标：wrapper 执行结果在 edge 进程崩溃后仍可安全重报，避免无必要重复物理操作。

任务：

1. 增加 `RustDeskEdgePendingStore` 接口和 filesystem 实现。
2. spool 目录通过 `OPC_RUSTDESK_EDGE_SPOOL_DIR` 显式配置；默认关闭命令执行或使用平台私有 application-data 目录，禁止写当前工作目录。
3. 文件采用 versioned JSON、原子 temp+rename、`0600` 权限、目录 `0700`、单实例 lock。
4. 只保存 command ID、external ID、device ID、operation kind、sanitized progress、exit code、duration、byte count、SHA-256、attempt 和 timestamp。
5. 不保存 command token、API key、stdout/stderr 原文、RustDesk password、剪贴板、文件内容或屏幕数据。
6. wrapper 前先写 `executing` intent，执行后原子写 `executed` result。
7. 重启后向服务端 recovery endpoint 证明 edge/device/command 身份并领取新的短 lease token，再重报 progress/result。
8. 服务端已完成返回幂等 terminal ack；lease 被其他 edge 接管时本地记录 quarantine，不再次执行。
9. spool 有数量/字节/年龄上限和 dead-letter 目录，不能无限占盘。

验收：

- 在 intent、wrapper、result write、HTTP report 每个故障点模拟进程退出。
- 已有 executed result 的重启路径不再次调用 wrapper。
- 损坏、符号链接、越目录、权限过宽和 schema 未知文件均 fail closed。
- secret scan 证明 spool fixture 不含 token 或执行内容。

### M6.6 SDK、交付与兼容收口

任务：

1. SDK 增加 event page/replay cursor 类型和方法；不暴露 provider credential。
2. 参考客户端接入 replay state machine 和 snapshot fallback。
3. Compose 使用独立 iveKit image、standalone migration job 和 provider plane。
4. 交付包增加 service source/build context、standalone migration manifest、image metadata 和 SBOM/checksum。
5. 文档补充 fresh install、existing OPC upgrade、rollback、Tinode cursor recovery、event retention 和 edge spool 运维。
6. 交付生成器继续使用文件白名单、secret scan、所有权 marker 和 SHA-256。

验收：

- LED 仅凭交付包可以 build iveKit image，不需要 OPC 根源码。
- V1 SDK 和 URL contract test 全通过。
- 新 SDK 可从断线 cursor 恢复三工作区。
- delivery manifest 绑定 source commit、migration checksums、SDK tgz、client dist 和 service image/build context。

### M6.7 完成审计

必须执行：

1. 独立 package typecheck/build/test。
2. standalone fresh PostgreSQL 和 existing schema migration integration test。
3. Tinode protocol controlled server：消息、Drafty 附件、replace、del、重连、重复、乱序、双 worker。
4. WebSocket replay controlled E2E：断线、gap、cursor 过期、撤权、跨租户。
5. RustDesk edge crash matrix 和 spool security test。
6. 参考客户端 unit/component、bundle budget 和完整 Playwright E2E。
7. SDK build/actual pack/install test。
8. application/LiveKit Compose config。
9. 独立 build context 在临时目录构建，禁止回读 OPC root。
10. 全仓 `npm run verify`。
11. delivery checksum、secret scan 和 forbidden-source scan。

V2 未重新执行的 LiveKit、RustDesk provider 场景必须标记 `not_run_for_v2`；Tinode 仅可声明本次实际覆盖的消息、编辑、Drafty 引用、删除、离线补偿和重启幂等，不得扩写为容量、弱网或多节点生产验收。不得用 2026-07-11 的 V1 证据冒充 V2 重验，V1 已通过的真实链路仅保留为基线证据。

## 7. 实施顺序

严格执行：

1. M6.1 dependency boundary。
2. M6.2 standalone database foundation。
3. M6.3 Tinode inbound synchronization。
4. M6.4 tenant event replay。
5. M6.5 RustDesk spool。
6. M6.6 SDK/client/delivery。
7. M6.7 completion audit。

M6.3 和 M6.4 共用 durable event transaction，必须先定义 inbox/event store 契约，再并行实现 provider adapter 和客户端 projection。M6.5 与 Tinode 无共享状态，可在 M6.2 schema 稳定后独立推进。

## 8. 升级与回滚原则

1. 所有 schema 变更 additive；V2 发布期不删除 V1 column/table/API。
2. 先部署 migration，再部署兼容读取的新服务，最后开启 worker feature flag。
3. Tinode inbound、event replay、edge spool 分别有独立 enable flag，可以单独回滚。
4. 关闭 inbound worker 不删除 cursor/inbox，重新开启继续补偿。
5. 关闭 replay 后客户端继续使用 V1 snapshot convergence。
6. 关闭 edge spool 后不得在存在未上报 executed record 时恢复旧内存模式，必须先 drain/quarantine。
7. standalone foundation migration 不允许对已有 OPC schema执行 down migration；回滚服务版本使用 forward-compatible schema。

## 9. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 独立 source context 漏带动态 import | 构建后在隔离临时目录启动 health/route contract；动态 import manifest 进入门禁 |
| standalone schema 与 OPC schema 漂移 | 同表同 migration version；schema contract diff test |
| Tinode provider 事件乱序或重复 | inbox unique key、transaction projector、cursor 只在 terminal 后推进 |
| Drafty 携带内嵌大对象或恶意 URL | entity/size/mime/domain 上限；不落 `val` bytes |
| replay 泄露撤权前事件 | replay 时重新做当前 membership/RBAC，不只依赖历史 audience |
| Redis fan-out 重复 | 客户端和服务端按 durable event ID 去重 |
| edge spool 泄密 | 字段白名单、0600、secret scan、禁止 token/stdout/stderr |
| wrapper 已执行但 intent 状态不确定 | executing/executed 状态机；不确定记录 quarantine 并要求人工处理，不盲目重执行 |

## 10. 完成定义

本 Goal 只有同时满足以下条件才完成：

1. iveKit service build context 离开 OPC 仓库后可以独立 build。
2. fresh PostgreSQL 不创建 call-center/IVR/CRM 表。
3. existing OPC database 无破坏升级。
4. Tinode inbound message、attachment、replace、delete 均有 durable cursor 和故障恢复证据。
5. 三工作区可用 tenant event cursor 断线续传，并在 gap/撤权时安全回退 snapshot。
6. RustDesk edge executed result 可跨进程恢复且不重复 wrapper。
7. SDK、client、Compose、migration、delivery 和文档全部更新。
8. standalone dependency policy 为 intelligence、translation、SIP 模块保留 iveKit-owned extension boundary，且不允许导入 OPC call-center/IVR。
9. 全仓和专项门禁通过，无未解决 Critical/Important。
10. 未运行的真实 provider 验收仍准确标记 `not_run`。

## 11. 共用底座剩余目标

从当前 V1 基线开始，共用底座保留四个目标：

1. **当前 Goal：iveKit V2 独立服务与可靠实时同步闭环。** 解决代码、数据、实时和边缘可靠性。
2. **iveKit V3 多模态智能与翻译。** 完成 OCR、ASR、AI 质检、人工复核和消息翻译，统一支持 self-hosted/third-party provider，并交付 LED SDK/API/UI 参考模块。
3. **iveKit V4 SIP/VoLTE 通信。** 完成 LiveKit SIP trunk/dispatch、号码、入呼/外呼、DTMF、录制、状态机和 LED 接入，不引入 OPC 坐席、CRM、营销外呼业务。
4. **最终 Goal：iveKit Release 1.0 与真实环境验收。** 发布独立 image/SDK、部署目标环境，完成真实 Tinode/LiveKit/RustDesk/OCR/ASR/AI/translation/SIP、对象存储、网络、双浏览器/双桌面、容量、弱网、升级和回滚证据。

第四个 Goal 完成后冻结 iveKit 共用底座并开始 OPC 主项目架构设计。RTMP/HLS 直播和数字人继续作为未来可选扩展，不阻塞 OPC 主架构。
