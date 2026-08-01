# Converact Fabric V5 阶段二 IM、LiveKit 与文件安全生产化实施计划

更新日期：2026-07-15

## 1. 目标

在不实现 Converact Platform/LED 业务逻辑、不开发移动端的前提下，完成以下共享底座：

1. Tinode 双向消息同步、附件发布、死信恢复、多实例 worker 与运维可观测闭环。
2. 文件真实 MIME 检测、病毒扫描、隔离、缩略图、转码、分片上传、断点续传和过期清理。
3. LiveKit 音视频、屏幕共享、录制、TURN、QoS、断线重连/重入和 release-bound 部署验收。
4. API、SDK、事件、OpenAPI、Compose/Helm、运维和自动化验收可被 Converact Platform、LED 及后续产品直接复用。

真实公网弱网、真实摄像头/麦克风和真实多浏览器媒体质量属于环境验收，代码和受控验收完成后仍标记 `not_run`。

## 2. 当前基线与真实缺口

### 2.1 已有能力

- Tinode outbound delivery、inbound cursor/inbox/projector/dead-letter、消息编辑/删除、回执、typing、presence、官方 SDK receive-only adapter 已存在。
- LiveKit room/token/join、参与人、moderation、screen share、Egress/recording、webhook、超时收敛、参考客户端和验收包已存在。
- 附件已有大小限制、声明 MIME 检查、SHA-256、私有对象引用、OCR/ASR/帧 OCR 和 AI 质检链路。
- PostgreSQL runtime role、FORCE RLS、tenant event replay、SDK、OpenAPI、standalone context、Compose 和 Helm 已存在。

### 2.2 必须补齐

- 当前附件上传信任 HTTP `Content-Type`，没有 magic-byte 权威 MIME、病毒扫描、隔离和安全发布状态。
- 当前对象 key 主要由原文件名组成，同租户同名文件可能覆盖；对象存储接口缺少 head/delete/multipart 能力。
- 当前上传只有单请求 body，没有 durable upload session、part checksum、complete 幂等和断点续传。
- OCR/ASR、下载和 Tinode 发布尚未统一受文件 `ready` 状态门禁。
- Tinode 缺少稳定的 queue lag、cursor lag、dead-letter、replay API/指标和文件状态联动证据。
- LiveKit 客户端已有网络状态显示和 SDK 自动重连，但服务端没有版本化 QoS snapshot、阈值事件和完整重入审计。
- LiveKit TURN/Egress/对象存储 preflight 和 acceptance 已有基础，尚未与本 release 的 QoS、重入和文件安全合同绑定。

## 3. 架构选择

### 3.1 文件安全控制面

新增独立 `SecureFileService`，聊天、LiveKit、OCR/ASR 和 Tinode 都只依赖它的稳定接口，不各自实现扫描逻辑。

```text
init upload -> upload part(s) -> complete bytes -> MIME detection
                                            |
                                            v
                                      virus scanning
                                      /            \
                               infected/error      clean
                                  |                  |
                            quarantined/failed   derivative jobs
                                                     |
                                                  ready
                                                     |
                         attachment bind / download / OCR-ASR / Tinode publish
```

状态机固定为：

```text
initiated -> uploading -> scanning -> processing -> ready
                                      |              |
                                      +-> failed     +-> expired
                         scanning -> quarantined
```

规则：

1. `detected_mime` 是权威 MIME；`declared_mime` 只用于审计。
2. 文件扩展名、声明 MIME 和 magic MIME 冲突时按租户策略 `reject|quarantine`，默认 quarantine。
3. 扫描错误 fail closed，不允许下载、OCR/ASR、翻译、派生或 Tinode 发布。
4. API 永不返回 S3/MinIO 管理地址；下载始终走租户鉴权 facade。
5. 原对象、part、缩略图和转码对象使用随机资源 ID 生成 key，不再使用原文件名作为唯一 key。

### 3.2 Provider 边界

- MIME：使用经过维护的 magic-byte detector；只读取有限头部，不执行文件。
- 病毒：统一 `FileThreatScanner`；生产支持 clamd INSTREAM，自建/第三方 HTTP adapter 归一化为同一结果。
- 派生：统一 `FileDerivativeProvider`；支持本地 FFmpeg 和受控 HTTP adapter。图片缩略图、视频缩略图、视频转码和音频转码使用显式 capability。
- Provider token、原始响应、文件正文和 clamd 诊断不得进入数据库、事件或错误消息。

### 3.3 Tinode 发布规则

本地 PostgreSQL 镜像仍是业务消息与审核权威。Tinode 是实时投递 Provider：

1. 无附件消息按现有 durable delivery 发布。
2. 有附件消息只有在所有 `secure_file_id` 为 `ready` 后才能发布。
3. 任一文件 quarantined/failed 时消息 delivery 标记显式 blocked，不无限重试 Provider。
4. 文件从 scanning/processing 进入 ready 后唤醒对应 message delivery。
5. inbound Tinode 外部附件先导入安全文件状态机，完成扫描前不作为可下载附件发布。

### 3.4 LiveKit QoS 与重入

客户端采集有限、安全、低频的标准 WebRTC/LiveKit 统计并上报：连接状态、RTT、jitter、packet loss、bitrate、quality score、track source。服务端保存有界 snapshot，按配置阈值产生 `degraded/recovered` 事件。

重连分两层：

1. LiveKit SDK 原生 reconnect 负责短暂网络抖动。
2. SDK 进入 terminal disconnected 后，参考客户端创建新 adapter、重新获取 join plan/token，并使用递增 `connection_revision` 上报 `disconnected -> rejoining -> rejoined|failed`。

服务端只接受单调 revision 和幂等 event id，旧客户端乱序上报不能覆盖新连接状态。

## 4. 数据模型

### 4.1 migration 061：文件安全

新增 `collaboration_secure_files`：

- `id`、`tenant_id`、`session_id`、`created_by`
- `kind`、`filename`、`extension`
- `declared_mime`、`detected_mime`、`mime_conflict`
- `status`、`threat_status`、`failure_code`
- `object_key`、`size_bytes`、`sha256`
- `upload_mode`、`expected_size_bytes`、`received_size_bytes`、`part_size_bytes`
- `idempotency_key`、`payload_hash`
- `scan_attempt_count`、`lease_until`、`worker_id`
- `retention_until`、`expires_at`、`metadata`、timestamps

新增 `collaboration_secure_file_parts`：

- `secure_file_id`、`part_number`、`size_bytes`、`sha256`、`object_key`、`etag`、`status`
- 同一 tenant/file/part 唯一；相同 checksum 重放幂等，不同 checksum 返回冲突。

新增 `collaboration_secure_file_derivatives`：

- `secure_file_id`、`derivative_kind`、`status`、`object_key`、`mime`、`size_bytes`、`sha256`
- `provider_profile_id`、`attempt_count`、lease、错误码和 timestamps。

`collaboration_message_attachments` 增加 `secure_file_id`，并建立 tenant 一致性外键或触发器门禁。

所有新表必须 `ENABLE/FORCE RLS`，runtime 角色仅获业务 DML 权限。

### 4.2 migration 062：Tinode 运维

在现有 cursor/event/dead-letter/delivery 表基础上增加必要索引和安全统计函数，不复制消息数据。运维 snapshot 至少返回：

- outbound pending/retry/failed 数与最老任务年龄
- inbound cursor data/delete lag、最后成功时间、连续失败数
- pending inbox/dead-letter 数与最老事件年龄
- blocked_by_file_security 数

死信人工 replay 必须写审核事件并保持原 event id、payload hash 和 attempt history。

### 4.3 migration 063：LiveKit QoS 与连接状态

新增 `ivekit_media_quality_snapshots`：

- tenant/call/room/participant/connection revision
- track source、quality level、RTT、jitter、packet loss、bitrate
- sampled_at、received_at、metadata

新增 `ivekit_media_connection_events`：

- tenant/call/participant/event id/revision
- event type、reason code、occurred_at、received_at
- `(tenant_id, call_id, identity, event_id)` 唯一

`ivekit_media_call_participants` 增加当前连接 revision/state、last_disconnected_at、last_rejoined_at。所有写入按 revision 单调更新并启用 FORCE RLS。

## 5. API 与 SDK

### 5.1 文件上传

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/ivekit/chat/sessions/:id/files` | 创建 upload session，要求 Idempotency-Key |
| PUT | `/api/ivekit/chat/sessions/:id/files/:file_id/content` | 小文件单请求上传 |
| PUT | `/api/ivekit/chat/sessions/:id/files/:file_id/parts/:part` | 分片上传，要求 part SHA-256 |
| GET | `/api/ivekit/chat/sessions/:id/files/:file_id/parts` | 查询已收 part，支持断点恢复 |
| POST | `/api/ivekit/chat/sessions/:id/files/:file_id/complete` | 校验总大小/总 hash 并幂等完成 |
| DELETE | `/api/ivekit/chat/sessions/:id/files/:file_id` | 未发布文件 abort/清理 |
| GET | `/api/ivekit/chat/sessions/:id/files/:file_id` | 查询扫描、派生和发布状态 |
| GET | `/api/ivekit/chat/sessions/:id/files/:file_id/download` | 仅 ready 且有参与人权限时下载 |

保留旧 `attachments/upload` 作为小文件兼容入口，但内部必须调用同一 `SecureFileService`，返回 `secure_file_id`，不再绕过扫描。

### 5.2 Tinode 运维

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/ivekit/chat/operations` | 管理员查询队列/cursor/dead-letter 安全汇总 |
| GET | `/api/ivekit/chat/dead-letters` | 分页查询安全字段，不返回原始正文/token |
| POST | `/api/ivekit/chat/dead-letters/:id/replay` | 审计化人工重放 |

### 5.3 LiveKit QoS/重入

| Method | Path | 用途 |
| --- | --- | --- |
| POST | `/api/ivekit/media/calls/:call_id/qos` | 批量上报有界 QoS snapshot |
| GET | `/api/ivekit/media/calls/:call_id/qos` | 查询最近质量摘要与参与人状态 |
| POST | `/api/ivekit/media/calls/:call_id/connection-events` | 幂等上报断线/重入状态 |

SDK 提供 typed 方法、错误码、upload progress、pause/resume、list parts、complete、abort、QoS reporter 和 rejoin controller。

## 6. 实施任务

### Task 1：文件安全 migration 与状态机

- [x] 先写 migration/状态转换失败测试。
- [x] 创建 `061_ivekit_file_security.sql`，加入 standalone source policy 与 delivery bundle。
- [x] 新增 `secure-file-types.ts` 和 `secure-file-store.ts`，实现合法状态转换、幂等与 tenant scope。
- [x] 测试跨租户读取/写入、非法跳转、重复 complete、同 part checksum 重放和不同 checksum 冲突。

### Task 2：对象存储生产接口

- [x] 扩展 `ObjectStorage` 为 unique upload、head、delete、multipart initiate/upload/complete/abort。
- [x] Local adapter 使用随机 key、原子 publication 和边界检查；S3 adapter 使用 AWS multipart API。
- [x] 所有对象 key 由 resource id 生成，原始 filename 只作为 metadata/下载名称。
- [x] 测试同名文件不覆盖、part 重放、complete checksum、abort 清理和 tenant key 隔离。

### Task 3：真实 MIME 与病毒扫描

- [x] 引入受维护的 magic-byte detector，并为未知类型返回 `application/octet-stream`，不得回退信任声明 MIME。
- [x] 新增 `FileThreatScanner`、clamd INSTREAM adapter、HTTP adapter 和受控 scanner。
- [x] 新增 leased scan worker；clean 进入 processing，infected 进入 quarantined，错误按策略 retry 后 failed/quarantined。
- [x] 测试 PNG/JPEG/PDF/ZIP/MP4/WebM/MP3/WAV、伪扩展名、声明冲突、EICAR、clamd timeout/503/超限响应和 secret safety。

### Task 4：缩略图、转码与保留清理

- [x] 新增 `FileDerivativeProvider`，支持图片缩略图、视频缩略图、视频转码和音频转码。
- [x] 实现本地 FFmpeg adapter 与受控 HTTP adapter；命令参数固定，不经过 shell。
- [x] 派生任务使用 durable lease、幂等 key、输出 checksum 和独立 retention。
- [x] 新增过期 upload/part/隔离文件/派生对象清理 worker，dry-run 与 confirm 分离。
- [x] 测试 worker 崩溃恢复、部分派生失败、重复事件、对象补偿删除和清理重试。

### Task 5：API、附件绑定与下载门禁

- [x] 按第 5.1 节增加 API，所有 mutation 使用 Idempotency-Key/payload hash。
- [x] 旧二进制上传入口改为 `SecureFileService` 兼容 facade。
- [x] attachment descriptor 增加 `secure_file_id`；服务端绑定时验证 tenant/session/status/size/hash。
- [x] 下载、OCR/ASR、翻译和 AI 质检只消费 ready 文件；quarantined 永久拒绝。
- [x] SDK 增加分片、暂停、恢复、complete、abort 和状态查询；保持旧小文件方法兼容。

### Task 6：Tinode 文件门禁与生产运维

- [x] outbound delivery 在附件未 ready 时返回 `blocked_by_file_security`，不调用 Tinode Provider、不消耗 Provider attempt。
- [x] 文件 ready 后 durable 唤醒消息 delivery；quarantined/failed 进入显式 terminal blocked 状态并发事件。
- [x] inbound 外部附件导入 secure file，不直接信任 URL/MIME；允许 host 白名单仍保留。
- [x] 增加 operation snapshot、dead-letter list/replay API、Prometheus queue/cursor/dead-letter/file-block 指标。
- [x] 真实 PostgreSQL 两 worker 竞争、租约过期、重启、乱序/重复、死信重放和跨租户 RLS 测试通过。

### Task 7：LiveKit QoS 控制面

- [x] 创建 migration 063 和 store/service，校验有限指标、时间窗口和单调 connection revision。
- [x] 增加 QoS/connection API、SDK 类型和低基数 Prometheus 指标。
- [x] 阈值连续命中才产生 degraded，恢复阈值连续命中才产生 recovered，避免单样本抖动。
- [x] tenant events 只携带 call/participant/level/revision/安全统计，不携带 SDP、ICE candidate、IP 或 token。
- [x] 测试乱序 revision、重复 event id、跨租户、超界指标、degraded/recovered 防抖和 retention。

### Task 8：参考客户端断线重连与重入

- [x] LiveKit adapter 暴露原生 reconnect 与 terminal disconnect 的规范事件。
- [x] `useMediaCall` 对 terminal disconnect 使用 bounded exponential backoff 创建新 adapter、刷新 snapshot/join plan/token。
- [x] 每次重入递增 connection revision；旧 adapter 事件和旧请求不能覆盖当前状态。
- [x] 页面离线暂停；online/visibility 恢复合并为单一 in-flight rejoin；结束/撤权立即停止。
- [x] Node test/Playwright 覆盖 SDK reconnect、adapter 重建、token 刷新、重试耗尽、切换 call、组件卸载、screen share 恢复提示和无重复 publish。

受控证据：参考客户端 158 项全量 Node test 通过，Task 8 后新增的 media focused
测试覆盖 adapter 事件、退避控制器、revision 上报、旧房间隔离和终态停止；Playwright
`e2e/media.spec.ts` 3/3 通过，真实浏览器中完成 terminal disconnect、新 join plan、
麦克风/摄像头恢复、屏幕共享显式恢复以及连接事件序列校验。生产 build、typecheck 和
bundle budget 通过。公网弱网、真实摄像头/麦克风和目标 TURN 路径仍按约定为
`not_run`，不以受控 Room 替代真实环境证据。

### Task 9：TURN、Egress、存储与部署门禁

- [x] preflight 验证 LiveKit URL、API secret、TURN TLS/UDP、Redis、Egress、S3/MinIO bucket、Webhook URL 和时间同步。
- [x] Compose/Helm 加入 ClamAV、文件 worker 配置、资源/探针/持久卷与多副本安全配置。
- [x] deployment evidence 绑定镜像 digest、migration 061-063、TURN/Egress/文件 provider 配置指纹和 source commit。
- [x] `docker compose config`、Helm render、standalone source graph、SBOM/secret scan 通过。

本机已通过 Compose quiet render、standalone source graph/context、交付包 SBOM 与秘密材料扫描；
`npm run verify:converact:stage2-deployment` 将 Compose、Helm lint/template、不可变应用/ClamAV
镜像和发布证据测试合并为一个门禁。2026-07-17 使用临时 Helm `v3.18.4` 实际执行后，
Chart lint、template、镜像 digest 检查及发布/LiveKit 合同 `20/20` 全部通过。目标集群
install/upgrade/rollback 仍属于真实环境验收。

终审进一步补上 external LiveKit 的 Egress 依赖闭包：Egress 必须与外部 LiveKit Server
显式使用同一 Redis address/认证/TLS，且双池只接受批准仓库 `converact/livekit-egress` 的不可变
image digest。缺 shared Redis/digest、使用上游全限定别名或任意其他仓库时 Helm fail-closed；overlay、Go policy、build script
和双池 Chart 文件已进入交付包。目标 Redis、定制镜像和集群运行仍为 `not_run`。

### Task 10：阶段验收与文档

- [x] focused tests 覆盖 Tinode、文件、LiveKit、事件、SDK 和部署合同。
- [x] 真实 PostgreSQL fresh、pre-061 upgrade、RLS、多实例 lease、upload resume 和 QoS revision 通过。
- [x] 受控 ClamAV/派生 Provider、真实本地 HTTP multipart/resume 和故障矩阵通过。
- [x] 参考客户端 build、Node test 和 Playwright 断线恢复通过。
- [x] typecheck、SDK build/pack、standalone context、delivery bundle 通过。
- [x] 更新共享审计矩阵：Tinode、LiveKit、文件安全仅在有证据时改为 implemented；公网弱网与真实物理媒体继续 `not_run`。

### 受控验收摘要（2026-07-15）

- Stage 2 focused backend/deployment：`110/110`；覆盖文件状态机、magic MIME、clamd/HTTP
  scanner、FFmpeg/HTTP 派生、清理、对象存储 multipart/resume、Tinode 文件门禁/运维、
  LiveKit QoS、preflight、release evidence 和 standalone migration。
- PostgreSQL harness：6 项全部通过；覆盖 fresh、Converact Platform upgrade/数据保留、FORCE RLS、Tinode
  inbound store/projector、IVR PostgreSQL 和受控 RustPBX Voice，临时数据库均由脚本清理。
- 参考客户端：Node `158/158`、production build 与 15 个 JS chunk budget 通过；Chromium
  `e2e/media.spec.ts` 为 `3/3`，覆盖 terminal disconnect、刷新 join plan/token、媒体恢复和
  connection event sequence。
- 交付：delivery `25/25`、根 typecheck、SDK build、SDK dry-run pack、238 文件 standalone
  source context 均通过。SDK 首次 pack 受用户级 root-owned npm cache 阻断，改用仓库内临时
  cache 后通过；这不是源码失败。
- 部署：Compose config、Helm `v3.18.4` lint/template 和部署门禁 `20/20` 通过。公网弱网、真实
  摄像头/麦克风、目标 TURN/Egress、真实 Tinode 多客户端、生产对象存储及目标集群 rollout
  仍为 `not_run`。

## 7. 安全不变量

1. `ready` 前不允许下载、OCR/ASR、翻译、Tinode 发布或生成外部 URL。
2. quarantined 文件不可恢复为 ready；只能删除或由具名管理员创建新的重新上传资源。
3. 浏览器和业务服务拿不到 S3 secret、ClamAV 内网地址、Provider token、LiveKit secret、TURN credential secret 或 Tinode root token。
4. part/object/derivative 的 tenant 必须与 session/message/attachment 一致，不能只依赖不透明 ID。
5. QoS payload 不接收 SDP、ICE candidate、IP、设备 label、token 或任意大 metadata。
6. 自动化只产生状态、finding 和事件，不执行 Converact Platform/LED 订单处罚或业务处置。

## 8. 完成标准

1. Tinode、文件和 LiveKit 的代码、迁移、API、SDK、事件、指标、部署和运维文档完整。
2. 失败、超时、重试、重启、多实例、幂等、乱序、跨租户和 secret-safety 都有反向测试。
3. 文件从上传到 ready/quarantined 的每个状态可追踪，且不再信任客户端 MIME 或原文件名 key。
4. Tinode 不会发布未扫描附件，OCR/ASR 不会处理 quarantined 文件。
5. LiveKit QoS、degraded/recovered、SDK reconnect 和 terminal rejoin 均有受控证据。
6. 真实公网弱网、真实物理设备和目标集群媒体质量未执行时保持 `not_run`，但不阻塞本阶段代码完成。
