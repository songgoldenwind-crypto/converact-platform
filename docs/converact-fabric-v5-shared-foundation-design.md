# Converact Fabric V5 共用通信协作底座设计与完成审计

更新日期：2026-07-18

## 1. 目标与边界

Converact Fabric V5 是 Converact Platform、LED 及后续产品共同复用的通信协作底座。它提供 IM、实时音视频、远程协助、语音呼叫、内容智能、文件安全、通知、审计和运维能力，但不实现任何产品业务流程。

明确排除：

1. LED/Converact Platform 业务域，包括订单、工程师、定价、支付、评价、退款、仲裁和业务后台。
2. Android、iOS、APNs、FCM、CallKit 和移动端 UI。
3. 数字人、RTMP/HLS 直播和与本目标无关的营销能力。

环境待验收但不阻塞代码完成：

1. 真实 OCR、ASR、翻译和 AI 厂商的准确率、额度、账单、区域合规及生产延迟。
2. 两台 Windows 物理机上的真实 RustDesk 屏幕、键鼠、剪贴板、文件、多屏、录制和断开效果。
3. 依赖真实公网、物理摄像头/麦克风或运营商线路的媒体质量、PSTN 和弱网验收。

以上项目必须保持 `not_run` 或“待环境验收”，不得由 mock、受控 Provider、Playwright 或静态配置冒充通过。

## 2. 复用架构

```text
Converact Platform backend          LED backend          future products
      \                  |                    /
       \        @converact/sdk + HTTPS      /
        +--------------- Converact Fabric API --------+
                           |
          +----------------+----------------+
          |                |                |
     collaboration       media/voice      remote assistance
   Tinode + content     LiveKit/RustPBX      RustDesk OSS
          |                |                |
          +-------- shared control plane ---+
                           |
       PostgreSQL RLS + Redis + object storage + tenant event journal
                           |
       self-hosted / third-party Provider adapters
```

### 2.1 产品无关合同

- 所有持久化资源由 `tenant_id` 隔离。
- 产品业务对象只使用不透明的 `business_ref`，Converact Fabric 不解释其类型和值。
- Converact Platform、LED 通过 SDK、API、租户事件和签名 Webhook 接入，不直连 Provider、Tinode、LiveKit、RustDesk、RustPBX 或 Converact Fabric 数据库。
- 业务处罚、订单状态和支付动作不在 Converact Fabric 内执行。AI 只产生 finding，最终动作由业务服务或人工审核决定。
- 配置、密钥和运行状态分离：配置保存 secret reference，密钥只从环境变量或外部 Secret 注入。

### 2.2 一致的控制面

所有异步能力使用相同的运行原则：

- PostgreSQL durable job 和租约 claim，支持进程重启恢复。
- 幂等键、payload hash 和单调状态机。
- Provider 错误分为 retryable、terminal、quota、circuit 和 unavailable。
- 事件经 tenant event/outbox 发布；通知和 Webhook 不在业务事务内直接发送。
- API、SDK、事件和数据库均保留 `tenant_id`、`business_ref`、actor、correlation id 和审计引用。

### 2.3 实时媒体与录制存储故障域

录音、录像和对象存储属于实时媒体的下游副本链路，不得成为 SIP/RTP、LiveKit SFU 或远控画面的
同步依赖。该规则同时适用于 Converact Platform、LED 和未来接入产品：

```text
SIP/RTP call --------> RustPBX media plane --------> peer
                            |
                            +-- bounded capture queue --> local durable spool --> uploader --> object storage

WebRTC publishers ---> LiveKit SFU ---------------> subscribers
                            |
                            +-- Egress worker ---------------------------> object storage
```

1. LiveKit Server 只依赖实时会话所需的 Redis，不依赖 Egress、MinIO 或 S3；对象存储故障不得重启、
   drain 或断开已有房间和 track。
2. RustPBX RTP capture 使用有界非阻塞队列；编码、磁盘、manifest 和上传位于独立 worker/sidecar。
   队列满、磁盘慢或上传失败时允许丢弃或失败录音副本，不允许反压 RTP 热路径。
3. 录制启动、停止、对象 finalize 和重试不得位于接听、转接、挂断或媒体转发的同步响应路径。
4. 录制失败必须进入明确终态并产生脱敏事件、指标和审计，禁止把缺失或不完整对象标记为成功。
5. 所有缓冲区必须有容量、水位和 admission policy；不得用无限内存/磁盘队列掩盖持续故障。
6. 故障演练清理顺序固定为先恢复存储与 bucket，再关闭测试媒体会话；失败路径也必须执行恢复。

2026-07-18 本机受控真实进程演练已使用两个 Chromium WebRTC peer、LiveKit Server、RoomComposite
Egress 和 MinIO 验证：停止 MinIO 前、故障期间及 Egress 因 S3 上传失败后，两端均保持
`connected`，每端仍有 1 个对端、2 条远端轨和 2 条本地轨；LiveKit `RestartCount=0` 且启动时间
未变化，MinIO 恢复后 bucket 仍为私有。该结果为 `passed_controlled_local`，不替代公网 TURN、
生产 S3、目标 Kubernetes、真实 SIP/RTP/PSTN、磁盘满或多节点故障验收。

2026-07-25 服务器复验把“轨道仍存在”升级为真实媒体流动合同：两个 peer 的 inbound/outbound
音频字节、视频字节、RTP 包和视频解码帧在存储中断、首次 Egress 上传失败、存储恢复三个阶段均
相对上一阶段严格增长；恢复后同一房间第二个 Egress 完成并产生可读取 MP4。裁决为
`passed_controlled_server`，仍不替代生产对象存储、跨 Zone、容量和 RustPBX RTP 录音故障验收。

## 3. 需求证据矩阵

状态定义：`implemented` 表示当前代码和自动化证据已经覆盖；`partial` 表示存在可用实现但未达到本目标；`missing` 表示当前没有通用实现；`environment` 表示代码入口存在但需要目标环境验收。

| # | 能力 | 当前状态 | 已有证据 | 仍需真实环境验收 |
| --- | --- | --- | --- | --- |
| 1 | Tinode IM、同步、附件和会话 | implemented + environment | 双向 durable worker、cursor/重放/死信、消息 mutation/receipt/presence、附件状态、文件安全门禁、SDK/参考客户端、指标和独立部署合同 | 真实 Tinode 多客户端、多副本长稳和目标网络恢复 |
| 2 | 自动翻译和 Provider 切换 | implemented + environment | 自动/手动任务、source hash、四能力有序路由、原子配额/并发、熔断/半开、故障切换、runtime API/SDK、事件、指标、worker 恢复、受控矩阵 | 真实翻译供应商效果、额度和生产并发保持环境待验收 |
| 3 | OCR/ASR/AI 质检和防绕单 | implemented + environment | V2 混淆联系方式 detector、图片 OCR、视频/屏幕录制 ASR + 帧 OCR 双任务、QR/条码 hash-only observation、跨消息/附件聚合、20 消息会话级 AI 质检、版本化 finding/evidence、人工审核、四能力 Provider 治理、API/SDK/OpenAPI 和真实 PostgreSQL RLS/恢复证据 | 真实 OCR/ASR/AI 厂商效果、真实视频抽帧准确率、额度和生产并发保持环境待验收 |
| 4 | LiveKit 音视频和屏幕共享 | implemented + environment | room/token/join、参与人、moderation、screen share、Egress/recording、QoS、重连/重入收敛、TURN/storage preflight、超时恢复、release-bound 验收包，以及双 Chromium + Egress + MinIO 本机真实进程存储故障隔离演练 | 公网 TURN、物理媒体、弱网、生产对象存储和目标多节点 |
| 5 | RustDesk Windows 远控闭环 | implemented + environment | consent/一次性授权码、控制租约、二次确认、设备/edge agent、键鼠/多屏/文件/剪贴板/录屏 observation、物理断开、升级/回滚、模拟终端和审计证据 | 两台 Windows 物理机端到端效果和签名安装包发布链 |
| 6 | RustPBX/SIP/IVR/WebPhone | implemented + environment | Voice/IVR/Contact Center 独立模块、SIPp 12/12、受控 RustPBX、WebPhone/Designer/Queue Monitor、SDK、运行指标、录音 spool、备份恢复、多副本模板和交付合同 | 真实 trunk/PSTN、WSS/SDP/ICE/RTP、物理音频、录音对象和目标集群故障演练 |
| 7 | 站内/Webhook/邮件/短信通知 | implemented + environment | PostgreSQL Notification/Delivery、in-app、签名 Webhook、SMTP/HTTP email、HTTP SMS、模板/偏好、回执、配额/熔断/健康、重试/死信/人工重放、SDK/OpenAPI；明确不含移动推送 | 商业 SMTP/短信、真实退信/回执、账单和公网 Webhook |
| 8 | 文件安全和媒体处理 | implemented + environment | magic-byte MIME、冲突检测、病毒扫描/隔离、私有发布、缩略图/转码、分片 checksum、幂等 complete、断点续传、过期清理和 Tinode 门禁 | 生产对象存储、ClamAV 签名更新、真实大文件/媒体工具容量 |
| 9 | Provider 管理 | implemented + environment | 显式有序 route、secret safety、health/preflight、PostgreSQL 原子配额与并发 lease、数据库时钟、熔断/半开、故障切换、runtime API/SDK、durable tenant event、低基数指标、有界 lease retention、受控 9 项矩阵和真实 PostgreSQL 并发/升级/RLS 验证 | 具体厂商效果、额度和生产网络仍归各能力项真实环境验收，不由受控 Provider 代替 |
| 10 | 权限、审计、限流、保留、监控、备份和多实例 | implemented + environment | capability/RLS、不可变审计、PostgreSQL 多实例限流、retention/legal hold、Prometheus/Grafana、backup/restore 工具、rolling Helm、PDB/HPA、heartbeat/lease 和 runbook | 目标 Kubernetes rollout/failover、真实 SIEM、容量和完整恢复演练 |
| 11 | LED 接入 API/SDK/事件/Webhook/文档 | implemented + environment | TypeScript SDK、59-path OpenAPI、HTTP replay/WebSocket、8-family catalog、migration 073 durable signed Webhook、Web Crypto verifier、LED durable inbox 示例、V5 capability/acceptance manifest 和全链路受控验收 | 真实 LED 公网 receiver、目标集群部署和跨区域长稳 |

阶段一已完成代码与受控验收：当前合并门禁中 108 个 Provider/intelligence/translation/attachment/quality/event focused tests、23 个交付契约测试、10 个 standalone source graph/context 测试均通过；真实 PostgreSQL fresh/pre-060 upgrade/FORCE RLS、quota/concurrency、视觉 observation 跨租户隔离、worker 恢复、IVR 和受控 RustPBX 共 4 项通过；受控 Provider 已通过真实 HTTP multipart 视频 OCR、QR/条码帧结果、501 observations 拒绝和治理失败矩阵。TypeScript `typecheck`、SDK build、66 文件 dry-run pack 和 218 源文件 standalone context 编译通过。真实 OCR/ASR/AI/翻译厂商效果、真实视频抽帧准确率、生产额度和并发继续保持 `not_run`。

## 4. 五阶段执行设计

### 4.1 阶段一：智能内容与 Provider 治理

交付内容：

1. 保留现有 OCR、ASR、质检和翻译 Provider 协议。
2. 租户策略为每种 capability 保存有序 profile route；旧单 profile 自动迁移为单元素 route。
3. profile 配置声明分钟/日请求配额、最大并发、失败阈值和熔断冷却时间。
4. PostgreSQL 原子 reservation 负责多实例配额和并发；lease 过期后自动释放。
5. 仅 retryable 错误触发同一任务内的下一 Provider；terminal 输入错误不得绕到其它 Provider。
6. 连续失败打开 circuit；冷却后只允许受限 half-open probe；成功关闭，失败重新打开。
7. 运行状态 API 只暴露计数、状态和 profile id，不暴露 URL、token、原文或 Provider body。
8. 所有选择、跳过、降级和故障切换写入 job metadata、tenant event 和 Prometheus 指标。

阶段门禁：单元测试、真实 PostgreSQL 原子竞争测试、worker 重启恢复、SDK/OpenAPI、standalone migration 和受控 Provider failure matrix。

阶段状态（2026-07-15）：`implemented + environment`。代码、迁移、API、SDK、OpenAPI、运维文档、受控 Provider、真实 PostgreSQL 和交付门禁已完成；仅第 1 节明确列出的真实厂商效果与生产环境项目保持 `not_run`。

### 4.2 阶段二：IM、LiveKit 与文件安全生产化

交付内容：

1. Tinode outbound/inbound cursor、重放、mutation、receipt、typing、presence 和附件状态统一收敛。
2. 上传改为 `initiated -> uploading -> scanning -> processing -> ready|quarantined|failed`。
3. 分片 session、part checksum、complete 幂等和过期清理；小文件仍保留单请求入口。
4. magic-byte 检测结果为服务端权威 MIME；不匹配、病毒和扫描失败按策略隔离。
5. thumbnail/transcode 采用可插拔 worker，原文件和派生文件分别保存 checksum、retention 和 evidence。
6. LiveKit 加入 QoS snapshot、阈值事件、重连/重入收敛、TURN/Egress/storage preflight 和 release-bound evidence。

阶段门禁：Tinode/文件/LiveKit focused tests、真实 PostgreSQL、受控 ClamAV/转码 Provider、Compose/Helm render、浏览器断线恢复测试。公网弱网和物理设备保持环境待验收。

阶段状态（2026-07-15）：`implemented + environment`。代码、迁移、API/SDK、文件安全、QoS/恢复、独立部署与本地/受控门禁已完成；真实 Tinode 多客户端、LiveKit 双客户端、TURN/Egress、对象存储和弱网保持 `not_run`。

### 4.3 阶段三：RustDesk Windows 桌面闭环

交付内容：

1. 固化 Windows x64/arm64 客户端 artifact manifest、checksum、签名状态和兼容版本。
2. 一次性授权、attended/unattended policy、控制权租约和二次确认统一由 Converact Fabric 控制面裁决。
3. 屏幕、键鼠、多屏、文件、剪贴板、录屏、断开均产生 canonical operation observation。
4. Windows edge agent 支持安装、配置、心跳、命令 spool、升级、回滚和无 shell 执行。
5. 模拟 Windows terminal harness 覆盖命令执行、崩溃恢复、重复投递、超时、旧 token 和审计完整性。

阶段门禁：静态客户端包验证、edge harness、受控端到端、证据包。真实双 Windows 物理机报告保持 `not_run`。

阶段状态（2026-07-15）：`implemented + environment`。Windows edge agent、授权码、控制/证据状态机、打包/升级/回滚、模拟终端和 SDK 合同已完成；两台物理 Windows 的真实操作报告保持 `not_run`。

### 4.4 阶段四：通知、安全与运维

交付内容：

1. notification outbox 支持 in_app、webhook、email、sms 四类 channel。
2. 模板只接受白名单变量；敏感字段按 channel 策略脱敏；Provider 凭据只使用 secret ref。
3. durable delivery 支持幂等、指数退避、Retry-After、死信、人工重放和回执。
4. API rate limit 以 tenant/principal/route 为键，Redis 为生产后端；不可静默退回进程内计数。
5. retention worker 覆盖消息、附件、录制、审计、Provider 原始证据和删除 tombstone。
6. Prometheus/Grafana 覆盖 queue lag、provider、media QoS、notification、file scan、RustDesk 和 Voice。
7. 备份/恢复 runbook 验证 PostgreSQL、对象存储和配置版本的一致恢复点。
8. 多实例测试证明 durable worker 不重复副作用，滚动升级不丢任务。

阶段状态（2026-07-15）：`implemented + environment`。Voice/IVR/Contact Center 复核、四 channel 通知、文件/Provider 安全、审计/限流/保留、监控、备份恢复和多实例配置已完成；运营商、商业通知 Provider、目标 Kubernetes 和完整恢复演练保持 `not_run`。

### 4.5 阶段五：全链路交付

交付内容：

1. `@converact/sdk`、OpenAPI、事件 schema 和 Webhook schema 覆盖全部 V5 能力。
2. Webhook 使用时间戳、event id 和 HMAC 签名；接收方可防重放。
3. Converact Platform/LED 示例只使用 `tenant_id`、`business_ref` 和 SDK，不引用内部表或 Provider。
4. standalone source graph、Compose、digest-pinned Helm、迁移、SBOM、镜像 metadata 和升级合同更新。
5. 生成 source-bound 验收包，逐项区分 automated、controlled、real_environment 和 not_run。

阶段状态（2026-07-15）：`implemented + environment`。migration 073、事件目录、订阅 API/SDK、durable Bridge Worker、签名投递、7 天持久防重放入口、OpenAPI 3.1 outbound webhook、LED receiver、监控告警、V5 manifest 和受控 full-chain 已完成；公网 receiver 和目标部署保持 `not_run`。

## 5. 安全不变量

1. 浏览器不得获得 Provider token、数据库凭据、对象存储管理凭据或 RustDesk control-plane token。
2. third-party Provider 只能使用 HTTPS，且租户策略显式允许。
3. Provider failover 不得扩大数据出境范围；route 中每个 third-party profile 都必须显式配置并获租户允许。
4. 文件在 `ready` 前不得生成可公开下载的 URL；`quarantined` 永远不能进入 OCR/ASR/翻译/Tinode 发布链路。
5. AI finding 不得直接执行封禁、删除、扣款或订单动作。
6. RustDesk launch token 短期、单会话、目标绑定；授权撤销后旧链接和旧控制版本必须失效。
7. 运行时 PostgreSQL 账号必须 `NOSUPERUSER NOBYPASSRLS`，所有新增租户表启用并强制 RLS。
8. 任何验收报告都必须绑定完整 source commit、部署指纹、证据 SHA-256 和环境分类。

## 6. 完成判定

每个阶段只有在以下证据同时存在时才可标记代码完成：

1. 功能实现、迁移、SDK、OpenAPI、部署配置和运维文档齐全。
2. focused tests、typecheck、standalone source graph、fresh/upgrade PostgreSQL 和交付合同通过。
3. 失败、超时、重试、重启、多租户、幂等和 secret-safety 均有反向测试。
4. 对应 evidence manifest 能区分受控证据和真实环境证据。
5. 本文第 3 节矩阵中不存在 `missing`，所有 `partial` 均已关闭或被严格归类为已约定的环境待验收。

五阶段的代码、部署配置、自动化验收入口和交付文档现已满足。V5 共享底座可标记为“代码完成、环境待验收”；任何生产发布仍必须按 capability matrix 补齐对应 real_environment gate，不能把 `included` 或 controlled passed 解释为真实环境通过。
