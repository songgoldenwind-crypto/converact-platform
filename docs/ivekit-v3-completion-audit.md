# iveKit V3 完成审计与验收记录

更新日期：2026-07-18。本文前八节对应 `codex/ivekit-v3-multimodal-translation` 的历史证据；后续章节持续追加当前共用通信底座审计，不以旧 V3/V4 环境结果替代当前 release 证据。

## 1. 审计范围

包含 OCR、ASR、录制源导入、AI 防绕单质检、人工复核、消息/附件翻译、租户策略、Provider health/preflight、PostgreSQL RLS、durable worker、SDK、参考客户端、Compose/Kubernetes 和独立交付包。

不包含 SIP/VoLTE、RTMP/HLS、数字人，也不把未选择的真实 OCR/ASR/AI/翻译厂商声明为已通过。

## 2. 当前状态

| 门禁 | 状态 | 证据 |
| --- | --- | --- |
| V3 focused/foundation | passed | foundation `36/36`；delivery contract `8/8`；standalone context 独立 `npm ci`/build 通过 |
| TypeScript typecheck | passed | 干净服务器镜像 `npm run typecheck`，0 error |
| Full repository | passed | 运行时基线提交共 2168 项：2159 pass、0 fail、9 条外部环境条件 skip；最终交付提交的精确复跑结果写入 source-bound 证据包 |
| Reference client | passed | 组件/状态/SDK 单测 `128/128`；production build 和 6 个 JS chunk budget 通过 |
| Controlled browser | passed | Playwright Chromium：IM 1、Media 3、RustDesk 5，共 `9/9`；含桌面、390px、320px 截图/像素布局断言 |
| Real PostgreSQL/RLS | passed | PostgreSQL 16.14 fresh + OPC upgrade `2/2`；35 个迁移逐版本/checksum、runtime 最小权限、FORCE RLS、跨租户拒绝、事件保留通过 |
| Restart recovery | passed | 真实 PostgreSQL 中 OCR、质检、翻译过期 processing lease 均被新 worker 回收，attempt 1→2 并收敛到 succeeded；RustDesk executed/uncertain 恢复仍通过 |
| Controlled Provider HTTP | passed | 实际监听服务和真实 adapter：OCR/ASR/质检/翻译 success、401、503 retryable、422 terminal、invalid JSON、>1 MiB、1s timeout 全通过 |
| Compose/Helm | passed | standalone 默认、acceptance profile、production Compose quiet render；Helm 3.18.4 template 通过 |
| Delivery contract | passed | 支持 source-bound controlled evidence；passed 必须有交付内证据 bytes/SHA-256，篡改/额外文件/秘密/真实厂商冒充均拒绝 |
| Delivery archive | ready_to_generate | 审计提交后从干净 worktree 单命令生成；最终 source commit/hash 以 bundle `manifest.json`、`SHA256SUMS` 和外部归档 SHA-256 为准 |

## 3. 已关闭的重要审查问题

1. OCR/ASR Provider 响应读取增加 1 MiB 硬上限，避免无界内存占用。
2. OCR/ASR、AI 质检和翻译数据请求统一使用 `redirect=manual`，防止 3xx 绕过已审计 Provider profile URL。
3. Compose/Kubernetes worker 默认关闭；profile、token、policy、preflight 和 health 完成后才启用。
4. Provider token 只从环境变量或 Kubernetes Secret 注入，不进入 profile JSON、API、事件或文档证据。
5. 干净镜像发现根 `package.json` 未声明测试直接导入的 `tinode-sdk`，已补依赖与锁文件契约，消除本机 `node_modules` 假通过。
6. 交付/standalone 验证入口已支持严格的完整 source commit 注入；Git checkout 默认读 HEAD，GitHub archive/发布快照必须显式传入且拒绝占位值。
7. 参考客户端附件消息缺 `extracted_text` 时曾触发 `undefined.trim()` 导致 React 白屏；已空值归一化，并由组件回归与 Playwright IM 全流程关闭。
8. 质检器原来忽略显式测试/调用依赖，现优先使用完整显式 LLM endpoint 配置，否则才读取环境 Provider。
9. 时区无关测试、importance 评分阈值边界和 React 状态等待已改为确定性夹具，服务器全量复跑 0 fail。

## 4. 验收事实边界

受控 Provider 只证明 iveKit 的 HTTP 协议、错误分类、重试、脱敏和状态收敛。真实厂商的准确率、配额、合规、账单、区域和生产延迟保持 `not_run`，直到选择厂商并提供目标环境凭据。受控状态写入交付包时必须连同 source-bound 证据，且 `controlled_tests_are_real_vendor_evidence=false`。

LiveKit/Tinode/RustDesk 的历史 V2 证据不会自动升级成当前 V3 release 证据。最终交付 manifest 将分别记录受控环境和真实环境状态，并绑定 source commit、migration、SDK、client、SBOM、image metadata 和验收状态 SHA-256。

## 5. 服务器隔离原则

目标服务器路径使用 `/opt/ivekit-v3-validation/<commit>`，Compose project、network、volume、container、image tag 和 loopback 端口均带 commit 前缀。不得重启或修改现有 LED、iveKit V2、LiveKit、Tinode 或 RustDesk 容器。

本次遵守该原则：未重启/改写任何既有服务；新建 `ivekit-v3-cb09525` 网络、独立 PostgreSQL/controlled Provider 容器和 commit 前缀镜像。旧失败上下文保留作审计证据，没有覆盖成功日志。

## 6. 服务器证据明细

### 6.1 环境与代码绑定

- 运行时基线验收提交：`c33988800b7fd4f63d560534c6c322b65a23f6b0`；最终交付提交在生成证据包时重新绑定。
- 源码归档：`/opt/ivekit-v3-validation/c339888/ivekit-v3-c339888.tgz`，SHA-256 `5d02e09ec280b60cd901fdd2e42812505183b76cb8656435865456709d6fa32d`。
- 验证镜像：`ivekit-v3-validation:c339888`，image ID `sha256:e64f12691a242065f130478392ba54f96ae73b3c570c6f8120eaeebf68ccae17`，大小 1,037,241,144 bytes。
- 系统：Linux 6.8.0-124-generic x86_64；Docker 29.1.3；Compose 2.40.3；Node 24.17.0；npm 11.13.0；PostgreSQL 16.14；Helm 3.18.4。
- 证据目录：`/opt/ivekit-v3-validation/c339888/evidence/`；包含 typecheck、full test、foundation、standalone、PostgreSQL、Provider、client unit/build、Playwright 和 delivery 日志。

### 6.2 PostgreSQL 与恢复

1. 使用 `POSTGRES_USER=opc_admin` 的隔离 PostgreSQL，不使用默认 `postgres` 身份绕过项目角色合同。
2. fresh schema 的 `schema_migrations` 与 standalone context 35 个 `.sql` 文件逐一相等且每项有 64 位 checksum；二次迁移幂等。
3. `opc_runtime` 为 `NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE`，不能 CREATE schema object、不能读取 migration ledger；跨租户 policy/session 读写均被 RLS 阻断。
4. OPC root schema upgrade 后 campaign、collaboration session 与产品表保留，043/044/045 各只执行一次。
5. OCR attachment、AI quality、translation 三个模拟崩溃 job 的过期 lease 被回收，三个 job 均 `succeeded`、`attempt_count=2`、`worker_id=''`、`lease_until=NULL`。

### 6.3 Provider 与浏览器

- OCR/ASR 均返回规范 text/confidence/request id；AI 质检返回 high finding；翻译返回 `[zh-CN]` 文本和检测语言。
- 401 不回显 token/原文；503→retryable；422→terminal；invalid JSON/oversized→non-retryable；timeout→retryable。
- Playwright 的 IM 流程覆盖双身份 Tinode 收敛、附件、回复/转发、reaction/pin、编辑/删除、人工质检、离线恢复和关闭撤权；Media/RustDesk 与移动布局全部通过。
- 通过截图保存在 Playwright 证据目录；失败时定位出的附件白屏 trace 保留在前一提交证据目录，便于追溯修复原因。

## 7. 明确保留的 not_run 与非阻断项

- 真实 OCR/ASR/AI/翻译 Provider：`not_run`；尚未选择厂商/模型、凭据、配额和准确率语料。
- 当前 release 的真实 LiveKit 双客户端/Egress、真实 Tinode 多客户端、真实 RustDesk 物理桌面操作：`not_run`；受控 Playwright 不替代这些证据。
- 多副本长稳、容量、弱网、生产对象存储、真实 DNS/TLS/区域合规：`not_run`，进入目标环境后按运维清单执行。
- validation 镜像未安装 Go/Rust 工具链，`check:sidecars` 中 Python compileall 通过，Go/Rust 静态检查按脚本语义 skip；这三个 OPC sidecar 不在 iveKit V3 standalone 运行图中。
- 根 OPC 依赖树的 `nodemailer@6.10.1` 被 `npm audit` 报 1 个 high（修复版本为 major upgrade）；standalone iveKit package/lock 不含 nodemailer。该项留给后续 OPC 架构阶段单独升级和回归，不影响本次可拆分 iveKit 交付边界。

结论：V3 可复用 OCR/ASR/AI 质检/人工复核/翻译底座及其 SDK、参考客户端、RLS、durable worker、部署和受控验收已闭环；真实厂商与物理客户端状态没有被夸大。最终交付包必须从干净 release commit 生成，并以包内 manifest/checksum 和外部归档 hash 完成最后绑定。

## 8. V4 standalone 交付补充（2026-07-14）

后续 Voice Foundation 审计发现，V3 交付包曾复制 OPC `infra/k8s` Chart，并把 OPC 集成 Compose 转换后作为应用交付面；它们不能证明 iveKit 已可独立升级。该问题现已从交付白名单中移除，OPC 原部署文件保留给 OPC 本体，不再进入 standalone iveKit Chart。

当前交付改为复制 `services/ivekit-service` 的 Compose，并新增独立 Helm Chart：应用和可选 RustPBX 镜像必须使用 digest，外部 Secret 由接收方管理，`pre-install,pre-upgrade` hook 顺序执行 runtime-role 初始化和 advisory-locked migration。交付包新增 `operations/release-contract.json` 与 `operations/upgrade-runbook.md`，绑定 source commit、image metadata 和 migration manifest SHA-256；无 digest 时状态为 `blocked_build_required`。迁移为 forward-only expand/contract，应用回退只选择兼容旧 digest，数据库回退只能恢复已验证的升级前备份。

这些新增 Chart/操作材料已通过本地类型、静态合同和交付包篡改门禁，但尚未在本轮目标 Kubernetes 集群执行 `helm template/upgrade/rollback`，也未启动真实 RustPBX/SIP/PSTN/RTP。因此第 2 节 V3 旧 Chart 的服务器证据不能自动升级为本次 V4 Chart 证据，相关环境项保持 `not_run`。

V4 当前 release 又在本机独立 PostgreSQL 14 harness 重跑 `scripts/verify-ivekit-postgres.sh`：standalone fresh/OPC upgrade `2/2`、IVR durable store `1/1`、受控 RustPBX Voice 收敛 `1/1`，共 `4/4`、0 失败。fresh 与 upgrade 都读取当前 source policy 的 46 个 migration；升级断言显式核对 17 张 Voice、10 张 IVR 和 14 张 Contact Center 表，不再用旧的 Voice+IVR 表数代替完整 shared foundation。`opc_runtime` 对 Contact Center skill 的本租户读取成功，读取不到另一租户记录，跨租户写入由 FORCE RLS 拒绝。该结果证明当前 PostgreSQL schema、升级保留和基础隔离，不证明真实 RustPBX/PSTN/RTP 数据面。

同一 runtime source revision `e67f5b356dbd64c2ca172715fb1c82d53ac55e73` 又在本机 Chromium 重跑 V4 受控浏览器门禁：WebPhone `2/2`、IVR Designer `2/2`、Queue Monitor `2/2`，合计 `6/6`、0 失败。三组均覆盖 1440x900 桌面和 390x844 移动视口；WebPhone 覆盖懒加载、短期 session plan、注册、呼入/呼出、接听/拒接、挂断、静音、Hold、DTMF、输入/输出设备切换和 credential 不进入页面文本；IVR 覆盖 draft-to-simulation 工作流与 26 节点设计器；Queue Monitor 覆盖刷新、筛选、告警、队列表和局部横向滚动。该门禁使用真实 Chromium，但 SIP 状态机和 HTTP 数据为受控驱动，只证明客户端集成与布局，不证明真实 WSS 注册、SDP/ICE、RTP、物理音频设备或真实 PostgreSQL 运营数据。

## 9. V5 Stage 2 追加审计（2026-07-15）

本节审计 Tinode 生产运维、文件安全状态机、LiveKit QoS/重入和 deployment evidence。它不改变
前文 V3/V4 历史证据，也不把受控浏览器或 PostgreSQL 测试升级为真实厂商/公网证据。

| 能力 | 实现状态 | 当前证据 | 仍为 not_run |
| --- | --- | --- | --- |
| Tinode IM | implemented_single_node_verified | 双向 durable sync、附件安全导入/发布门禁、operation snapshot、dead-letter replay、指标；focused、PostgreSQL harness 和真实服务器双 WebSocket client 已通过；浏览器 key/root key 分离且禁止同值，service account root 复核，关闭时 provider ID 撤权、幂等终态、paused inbound cursor、session read/write lock、closed-session 新消息拒绝和 delivery/retry 停止均已实现 | 三节点故障、长稳、公网故障切换和 LED 浏览器 UI |
| 文件安全 | implemented | migration 061、magic MIME、clamd/HTTP scanner、quarantine、FFmpeg/HTTP 派生、multipart/resume、retention cleanup；受控故障矩阵通过 | 生产对象存储、真实病毒样本库升级、目标容量和长稳 |
| LiveKit | implemented | migration 063、QoS degraded/recovered、防抖、connection revision、terminal rejoin、preflight、参考客户端 Node `158/158` 和 Chromium Media `3/3` | 真实摄像头/麦克风、目标 TURN/Egress、弱网和公网媒体质量 |
| Compose | implemented_and_rendered | standalone quiet config 通过；ClamAV 私网、探针、持久卷、资源和 worker 默认值已校验 | 目标服务器实际启动与长稳 |
| Helm | implemented_and_rendered | Chart、digest 门禁、ClamAV 双副本 StatefulSet、client/headless Service、每 Pod RWO 签名卷、签名新鲜度 readiness、PDB、反亲和和 NetworkPolicy 已实现；2026-07-22 已在服务器使用 Helm `v3.18.4` 重新 lint/template，单副本拒绝和 HA 合同通过；真实 ClamAV clean/EICAR 及文件安全回归 `59/59` 通过 | 目标 Kubernetes install/upgrade/rollback、跨节点 PVC、签名过期摘流、节点故障和媒体隔离尚无执行证据 |
| Release evidence | implemented | delivery `25/25`；source/image/migration/config fingerprint、SBOM、secret scan 和 tamper rejection | 实际应用镜像 digest 与目标 runtime deployment fingerprint |

代码门禁还包括 Stage 2 focused backend/deployment `110/110`、PostgreSQL harness 6 项、根
typecheck、SDK build/dry-run pack 和 238 文件 standalone context。SDK 首次 dry-run pack 因用户级
root-owned npm cache 无法写入而失败，改用工作树内临时 cache 后通过；没有修改全局 npm 权限。

当前 release 明确保留：真实 OCR/ASR/AI/翻译厂商、真实 Tinode 多客户端、真实 LiveKit
双客户端与 Egress、目标 TURN/弱网、两台 Windows RustDesk 物理机、生产对象存储和目标
Kubernetes 升级均为 `not_run`。Stage 2 代码可进入下一阶段，但最终发布裁决必须补齐对应环境
证据，并由 release contract 绑定完整 source commit、不可变镜像 digest 和 runtime fingerprint。

## 10. V5 Stage 4 追加审计（2026-07-15）

本节审计 Voice 生产化复核、通知底座、安全运维、监控和备份恢复。它只声明代码、配置和
本地自动化门禁状态；真实运营商、商业通知 Provider 和目标 Kubernetes 结果独立记录。

| 能力 | 实现状态 | 当前证据 | 仍为 not_run |
| --- | --- | --- | --- |
| Voice/IVR/WebPhone | implemented | RustPBX/SIP/IVR/WebPhone/Contact Center regression `341` 项，`339` pass、0 fail、2 个独立 PostgreSQL 条件 skip；现有 45 项真实环境 runbook 保持有效 | PSTN、WSS/SDP/ICE/RTP、物理音频、LiveKit SIP bridge 和真实 supervisor mixer |
| 通知底座 | implemented | migration 065/070/071/072；站内、Webhook、SMTP/HTTP Email、HTTP SMS；模板、偏好、回执、durable worker、配额、熔断、降级和 SDK/OpenAPI | 商业 SMTP 退信、真实短信发送/回执/账单、互联网 Webhook DNS/TLS |
| 通知事件 | implemented | Notification/Delivery/Inbox 与 tenant event 同 PostgreSQL 事务提交；稳定 SHA-256 producer key、用户定向 WebSocket/Redis fan-out 和 HTTP replay；敏感 Provider 数据不进入事件 | 真实多节点 Redis/WebSocket 长稳与跨区域重放 |
| 权限与审计 | implemented | capability policy、append-only audit、游标查询/导出、敏感字段脱敏、覆盖门禁 | 目标 SIEM/合规平台接入和长期归档 |
| 限流与保留 | implemented | PostgreSQL 多实例共享限流；typed retention、legal hold、对象先删、durable worker、指标和审计 | 生产数据量容量测试、真实对象存储批量删除和法律策略签署 |
| 监控 | implemented_not_run | ServiceMonitor、PrometheusRule、Grafana dashboard、完整指标字典和事故 runbook；静态 YAML/JSON 合同通过 | 当前机器无 Helm/promtool；Operator discovery、rule evaluation、Alertmanager/Grafana 和真实告警演练 |
| 备份恢复 | implemented | `pg_dump` custom format、对象 inventory/checksum、manifest、dry-run、恢复校验、RLS/引用 smoke、Helm CronJob 和 runbook | 目标数据库与对象存储全量恢复、实际 RPO/RTO 演练 |
| 多实例部署 | implemented_not_run | rolling Deployment、PDB、HPA、topology spread、graceful shutdown、migration hook、worker heartbeat/lease 合同 | 目标 Kubernetes rollout/rollback、节点故障和长稳压测 |

Stage 4 本地证据：通知/安全/运维核心 `128/128`，delivery/OpenAPI/release/tamper 合同
`28/28`；Voice 组 `339/341`，0 fail、2 skip；foundation 的 HTTP `16/16` 与 core `96/96`
分量通过；SDK build/dry-run pack 通过；
standalone context 离线 `npm ci` 和 build 通过，包含 302 个 source file、8 个 runtime package、
7 个生产入口。聚合 foundation wrapper 在 managed sandbox 内由 npm 子进程监听 loopback 时被
`EPERM` 拒绝，但完全相同的 HTTP 文件直接执行为 `16/16`，其余清单直接执行为 `96/96`；
本审计保留该执行边界，不把 wrapper 记为 passed。

真实 PSTN、真实浏览器 WSS/RTP、物理音频设备、真实 SMTP/短信/公网 Webhook、目标 Kubernetes
监控与多副本故障演练均为 `not_run`。这些环境项不阻塞 Stage 4 代码完成，也不得被受控 Provider、
静态配置或单机测试冒充。Stage 5 将把各阶段能力串成 LED 可消费的 API、SDK、事件、Webhook、
部署包和全链路验收文档，不实现 LED 业务逻辑。

## 11. V5 Stage 5 追加审计（2026-07-15）

本节审计产品中立的 API/SDK/事件/Webhook、V5 交付包和 LED 对接材料。它不声明 LED 业务逻辑、
公网接收端或目标 Kubernetes 已完成真实部署。

| 能力 | 实现状态 | 当前证据 | 仍为 not_run |
| --- | --- | --- | --- |
| 事件合同 | implemented | 同一 `ivekit_tenant_events` 支撑 HTTP replay、WebSocket 与 Webhook；8-family catalog、schema-v1 envelope、exact/trailing-wildcard 兼容规则 | 真实跨区域事件延迟和长稳 |
| Durable Webhook Bridge | implemented | migration 073、强制 RLS、subscription/cursor/lease、tenant discovery、`SKIP LOCKED`、fencing、过滤推进、`subscription + event` Notification 幂等 | 公网 Endpoint DNS/TLS 与目标多节点故障恢复 |
| 管理与治理 | implemented | owner/admin/system capability；create/list/get/update/archive；Idempotency-Key、revision、tenant/actor/source-IP 限流和不可变审计 | 目标 SIEM 与生产管理员流程 |
| 投递与接收 | implemented | Notification 加密投递、HMAC、SSRF、配额/熔断/重试/死信；OpenAPI 3.1 outbound webhook；Web Crypto verifier；1 MiB/32-byte/time-window/identity 校验；默认 7 天 durable inbox claim | 真实 LED receiver、外部 Redis/PostgreSQL inbox 和业务 Worker |
| 监控部署 | implemented_not_run | runtime heartbeat、低基数 operation/lag 指标、PrometheusRule、Grafana、四套 env、三套 Compose 和 Helm 参数；migration 073 进入 readiness/backup/source graph/delivery manifest | Prometheus 实际规则计算、Alertmanager、目标 Helm rollout |
| V5 交付 | implemented | manifest 增加 11 项 capability matrix、automated/controlled/real_environment 三层 acceptance matrix、13 项 known-not-run；OpenAPI YAML、Stage 1–5 计划、Webhook receiver/runbook 和 controlled full-chain 工具进入 hash/tamper 保护包 | 不可变目标镜像构建、真实环境证据补录和正式发布签署 |
| Controlled full-chain | passed_controlled | 同一 `service_order` business_ref 贯穿 IM、文件、质检、媒体、远控、Voice、通知 7 类事件；真实 bridge batch、cursor、HMAC、SDK verify 和 durable duplicate claim 生成 source-bound SHA-256 evidence | 该结果不包含真实 Tinode/LiveKit/RustDesk/RustPBX/Provider 或 LED 业务处理 |

真实 OCR/ASR/AI/翻译、真实 Tinode/LiveKit、两台 Windows RustDesk、PSTN/RTP、商业通知、
生产文件安全、公网 Webhook、目标 Kubernetes 和完整 backup/restore 演练继续保持 `not_run`。
V5 manifest 的 `delivery_status=included` 只证明文件进入 source-bound 交付包；controlled evidence 只证明
协议与状态机，不会自动改变任何 real_environment 状态。

Stage 5 最终本地门禁：delivery/event/Webhook 聚合测试 `52/52`、0 fail、0 skip；仓库
`test/*.test.ts` 全量回归 exit code 0；根 TypeScript typecheck、SDK build 和 dry-run pack 通过。
SDK 发布清单共 83 个文件，包含编译 Webhook verifier 与 LED receiver 示例。standalone context
离线验证包含 309 个允许源码文件、8 个 runtime package 和 7 个编译入口，且 source graph 未引入
OPC 产品域。三套 Compose quiet render 与 `git diff --check` 均通过。

首轮全量回归暴露的三个问题已关闭并复跑：录屏同时生成 ASR 与帧 OCR 后，intelligence source
快照稳定选择 ASR 主任务而不丢失 OCR 独立任务；SDK 发布合同显式纳入 examples；外呼并发测试改用
有界条件等待，消除全量并行时的固定 50ms 调度竞争。相关定向回归 53 项和随后全仓回归均通过。

最终架构复审又关闭七项：migration 068 语法错误；Helm 多副本误用本地对象存储；Notification/
Retention 批量预占导致的租约过期窗口；HTTP Endpoint 校验后再次 DNS 解析；Provider 事件默认路径
重复写 durable journal；`secure_files`、`media_recordings`、`tenant_events` 三类保留策略缺少真实 handler；
以及通用文本脱敏误改 UUID 证据 ID。修复后共享存储缺失会启动失败，HTTP socket 固定到已校验 IP，
worker 逐条 claim，六类 retention 均执行 legal hold 和有界删除，结构化证据 ID/hash 原样保留而自由文本
继续脱敏。相关 changed-surface 测试、Stage 5 `52/52`、根 typecheck 和全仓回归均重新通过；本机隔离
PostgreSQL harness `6/6` 重新执行 fresh migration、OPC upgrade、RLS、Tinode、IVR 和受控 RustPBX。

第二轮独立复审继续关闭六项 Important：Provider durable append 异常不再被 realtime 容错吞掉；Media
QoS/connection 使用包含采样时间的固定长度 SHA-256 producer key，把显式 journal 与 WebSocket append
收敛为单行，同时保留同一连接中的多次降级/恢复周期；
IPv6 SSRF 分类拒绝完整特殊用途网段；绝对 retention deadline 不再被策略天数二次延长；held tenant/
record 不再占满 bounded candidate window；Notification backoff 从 Provider 完成时刻起算。随后新增的
定向回归 `27/27`、真实 PostgreSQL `6/6`、Stage 5 `52/52`、standalone 309 文件、根 typecheck 和
全仓回归均通过。PostgreSQL 行为断言覆盖 `tenant_limit=1` 时跳过只有 held 过期事件的租户。

因此 V5 五阶段可统一判定为“代码、迁移、部署配置、自动化验收入口和交付文档完成，真实环境待
验收”。最终 release 仍须从干净提交生成 source-bound bundle，并补录对应 capability 的真实环境
证据；当前工作区或受控结果不得直接解释为生产发布完成。

## 12. V6 生产闭环尾项审计（2026-07-16）

本节关闭 V5 审计明确留下的 Tinode Kubernetes、Tinode 原生 mutation、RustDesk 精准断开和原生证据安全链路代码缺口。它不改变真实 Provider、物理设备和目标集群仍为 `not_run` 的结论。

| 能力 | 实现状态 | 当前代码与自动化证据 | 仍为 not_run |
| --- | --- | --- | --- |
| Tinode Kubernetes | implemented_not_run | standalone Chart 支持 `compact` 单副本 Deployment 和 `cluster` 三副本 StatefulSet；cluster 使用稳定 ordinal/DNS、client/headless Service、单一 `pre-install,pre-upgrade` 数据库 bootstrap Job、共享 S3、read-only root、双 Zone/主机分散、ring-only NetworkPolicy 与 `minAvailable: 2` PDB；每个 API Pod 仍用 init container fail-closed 创建/登录 Tinode service account，必要时通过限定的 PostgreSQL credential 更新提升到 auth level 30，并在重新登录明确取得 `authlvl=root` 后才启动；隔离服务器已验证缺失数据库、预建空库幂等初始化、MinIO S3 及三个健康节点组环，Helm lint/template 与无效配置 fail-closed 已通过 | 目标集群 Helm install/upgrade/rollback、节点/Zone 故障注入、真实 PVC/S3、重连、原生客户端收敛、容量和长稳 |
| Tinode 原生 mutation | implemented | migration 074；本地 edit/delete 与 provider mutation outbox 同事务；版本串行、lease fencing、retry/dead-letter/replay、replacement/delete wire frame、inbound echo suppression、外部客户端投影、SDK sync status 和事件；edit pub ACK 丢失或过期 processing lease 被接管时立即以 `provider_outcome_uncertain` 死信，阻止重复 replacement，并提供 OpenAPI/SDK 人工对账重放；迟到 echo 在同一事务纠正 delivered 并以稳定幂等键写 durable correction event，提交后广播失败可由 replay/Webhook 恢复；bootstrap 兼容已有账号的 304/409，随后必须完成 root 提升与重新登录复核；真实 PostgreSQL 已覆盖过期 edit claim 和 inbound 结果透传 | 真实 Tinode 多原生客户端 mutation ACK 丢失对账与三节点故障恢复 |
| RustDesk 精准断开 | implemented_not_run | migration 075 emergency authorization；ACL session registry/resolver；package v6 与 fixed native-control v2；命令、operation observation 和 evidence 全链携带 interaction/reservation/owner epoch；companion 每会话分片持久化最大 epoch，拒绝 stale owner 后才由 1.4.9 overlay 调用指定 `ui_cm_interface::close(native_id)`；普通失败不重启，owner/admin 显式确认后才允许 emergency restart | 两台 Windows、同机并发会话、owner handoff、UAC/login-screen 和物理断开观察 |
| RustDesk 原生证据 | implemented_not_run | 定制 RustDesk allowlist scanner 基线并自动产出稳定新文件候选；device-token context 按 controller/operation/文件名/时间窗唯一关联；15 分钟会后 finalization window；watcher、稳定性/变更/hash gate、durable spool、单文件/分片 uploader、设备/session/operation 二次授权、secure-file、扫描/隔离/衍生物、PDF OCR、录屏 ASR+帧 OCR、AI 质检和 `remote.rustdesk.evidence.*` 状态事件；migration 076 对 unsupported/ignored 持久标记并补偿 missed callback；设备侧死信 payload 默认 7 天/数量上限成对清理；远端成功后的本地删除失败保留 `uploaded + manifest` 并跨重启只重试删除，所有 manifest-backed 状态禁止普通终态压缩；手工 PowerShell 仅为恢复工具 | 定制 RustDesk 1.4.9 Windows 编译、真实文件/录屏、ClamAV/对象存储和物理 Windows |
| 八组真实验收与交付 | implemented_not_run | `ivekit-v6-real-acceptance.ts` 固定八组、source/digest/environment/run/operator/QA/observation 绑定，拒绝 mock/controlled、符号链接、路径逃逸、hash 漂移和 `not_run` 伪证据；模板、校验器、V6 文档、Tinode Helm 与 RustDesk Windows/overlay 进入 hash/tamper 保护交付包 | Provider、Tinode、LiveKit、RustDesk、PSTN、商业通知、生产对象存储、Kubernetes 均缺真实资源 |

RustDesk 未经自动 scanner/correlator/watcher/uploader 的内容仍保持 `native_unscanned` 或 `local_only`，不能由审计事件或静态配置推导为已扫描。placement-enabled Windows package builder 只接受同时声明 `ivekit-rustdesk-native-control-v2` 与 `rustdesk-native-evidence-v1` 的自定义 1.4.9 制品；v1 只允许在 placement 关闭时用于滚动兼容。交付白名单同时包含 control/evidence 两个 Rust 模块、owner epoch fence 与 correlator，SDK client-profile 投影保留 v2。Windows CI 已配置拉取精确 `1.4.9@6c578292...` 上游、应用 overlay、安装 vcpkg manifest 并执行 `cargo check`；本工作区不具备 Windows runner，因此该远程 CI 与实际签名制品、候选扫描、授权关联和上传行为仍须在 GitHub/双机验收。

V6 统一真实验收规范位于 `docs/ivekit-v6-real-environment-acceptance.md`。截至本节日期，八组均为 `not_run`；这表示外部环境尚未验收，不表示已完成的代码/部署合同失败，也绝不等价于生产可放行。

V6 原始本地门禁为全仓 `2939` 项、`2928` pass、`0` fail、`11` 个环境检查 skip；真实 PostgreSQL harness `6/6`；delivery/OpenAPI/event/release 聚合 `54/54`；根 TypeScript、SDK build 与 83-file dry-run pack、313-source/391-payload standalone context build、三套 Compose quiet render、`git diff --check` 和 changed-line secret scan 全部通过。2026-07-17 又使用 Helm `v3.18.4` 实际完成 standalone Chart lint/template、external LiveKit + shared Redis + digest-bound Egress 双池和 RustPBX recording-spool Chart 渲染；目标集群 rollout/rollback 继续为 `not_run`。

三轮独立复审先后发现并关闭 Windows installer placeholder、交付包漏 Rust module、会后录屏窗口、dead-letter payload 生命周期、reconciliation 饥饿、迟到 echo 纠正、Tinode 304、Windows CI、纠正事件提交后丢失和上传成功后本地孤儿文件等问题。最终复审对 transaction-scoped durable correction、稳定幂等键、默认/自定义 publisher、`uploaded + manifest` checkpoint、跨重启 cleanup 和 compaction 重新检查后，报告 `0 Critical / 0 Important`。持续 OS 文件锁可能积累受跟踪的 cleanup 记录，需要监控和人工处置；远端成功但本地 checkpoint 前崩溃可能重复 HTTP 调用，但 secure-file ID/checksum/idempotency 会收敛到同一文件。

因此 V6 可判定为“代码、迁移、部署模板、自动化验收入口和交付文档完成；外部真实环境待验收”。Windows GitHub overlay job、签名 RustDesk 制品、双 Windows、真实 Tinode/LiveKit/TURN/Egress/PSTN/Provider/商业通知/对象存储和目标 Kubernetes 均不得因本地门禁通过而改写为 passed。十万并发属于下一独立容量与性能目标，本轮只保留横向扩展前提，不声明容量达标。

## 13. MIX-100K / Cell-10K 架构追加审计（2026-07-16）

本节不是重新实现 IM、视频、远控、语音或通知。既有 Tinode、LiveKit、RustDesk、RustPBX、通知 API、SDK 和业务行为保持不变；新增内容位于其下方的 placement、admission、owner routing、lease fencing、backpressure、容量探针和分布式验收层，用于提高单节点密度并让多 Cell 横向扩展时边际效率可测、可控。

| 能力 | 实现状态 | 当前代码与自动化证据 | 仍为 not_run |
| --- | --- | --- | --- |
| Cell placement 与 owner fencing | implemented | 签名 placement snapshot/token、Region/Zone/Cell top-two admission、精确 interaction owner、32+32 位 owner epoch、LiveKit/Tinode/RustDesk/RustPBX 边界接线 | 目标双 Zone 故障演练、真实多 Cell 流量迁移 |
| Cell admission 持久化 | implemented | migration 078/083/084/093、PostgreSQL Cell lease、逐 reservation 权威账本、reserve/activate/close 先持久化后应答、重启恢复容量与 owner sequence；migration 093 对 reservation 权威表补齐 FORCE RLS 与 runtime grants；lease 绑定规范化 topology SHA-256 | 真实 PostgreSQL 双副本杀主、延迟/断网和长稳 |
| Cell admission 高可用 | implemented_not_run | 双副本主动/待命；待命 `/livez=200`、`/readyz=503` 且拒绝准入；只重试 retryable lease；活动 lease 同时要求 owner 与 topology hash 一致；变更拓扑只能在释放/过期后递增 epoch 接管；Service 只路由 ready 主实例；RollingUpdate、PDB、拓扑分散；待命 projector 不重复探测组件 | 目标 Kubernetes 实际 rollout、PDB/节点驱逐、主实例失联接管时延和错配拓扑演练 |
| 组件节点准入 | implemented_not_run | LiveKit/Tinode/RustDesk/RustPBX 通用 sidecar；稳定 ordinal 节点池、Cell 容量精确聚合、node lease、checkpoint、recovery-complete、drain、单条及最多 64 条批量授权、节点级故障隔离；Cell 重启自动重放未终态 owner，已删除 owner node 的恢复 fail closed；RustPBX Helm/Compose、LiveKit StatefulSet、三节点 Tinode StatefulSet 和配对 hbbs/hbbr RustDesk StatefulSet 均支持本地 sidecar 与相同稳定节点身份 | 多节点进程重启、真实 lease takeover、节点动态扩缩和真实热路径 |
| 上游源码 hook | implemented_not_run | Go hook 面向 LiveKit/Tinode，Rust hook 面向 RustDesk/RustPBX；RustPBX 固定源码 release 编译、本地 custom image 和 12 个受控 SIPp 信令场景通过；LiveKit 固定 `v1.13.4@0b3fd288...` 的 owner/router/SFU overlay，已在隔离 Linux amd64 服务器通过 Go 1.26.5 根/嵌套模块与 SFU race 测试、离线非 root custom image/fork marker smoke；Tinode 固定 `v0.25.3@22a7c18...` 的 topic owner、稳定 `cluster_self`、mutation fencing、lazy timer/fanout 优化及 arm64 source-built custom image/fork marker smoke 通过；RustDesk Server 固定 root `1.1.16@73523b31...` 与 `hbb_common@83419b6...`，owner/relay overlay 幂等应用且 `cargo test --locked --all-features` 通过；1.1.16 OCI 构建、Registry 与真实 relay 仍未执行；媒体包、帧和 fanout 热路径禁止远程调用 | 不可变 Registry digest/SBOM/签名/provenance；RustPBX 真实 RTP/PSTN/overload；LiveKit/Tinode/RustDesk 真实多节点/双 Windows、真实媒体/relay/profile 和容量 |
| 分布式容量验收 | implemented_not_run | PostgreSQL/JetStream run-phase-shard worker、租约与重复投递 fencing、S3 evidence、controller/run finalizer；曲线点按完整 MIX 比例确定性编译，component run 绑定必需角色；migration 091/scaling finalizer 从数据库与 S3 重读证据并重放 ramp/bracket/binary/final-repeat；migration 092/platform finalizer 强制九个组件角色、Cell、共享数据面和 100K endpoint 齐全，按 contract 从 frontier repetitions 二次复算每条曲线，并核对 endpoint 的 Cell 硬件/配置/故障预留与三方计数；只有全生产证据通过才产生 `platform_pass`，受控结果固定为 `none`；独立镜像、三个 finalizer Job、迁移和操作手册均进入交付包 | 不可变 capacity-tools 镜像构建与签名、真实生成器主机、三节点 JetStream、真实 S3、单机 frontier、九组件与 Cell/shared-data 物理曲线、Cell-10K 和 MIX-100K endpoint/平台物理运行 |

本轮容量门禁的最新计数以 `docs/capacity/phase2-code-status.json` 为准；容量专项回归 `303/303`、scaling campaign 定向门禁 `9/9`、platform campaign 定向门禁 `12/12`、交付门禁 `55/55`，根 TypeScript 与独立 capacity-runtime typecheck 均通过。固定门禁覆盖 LiveKit CAS room-owner rebuild、Tinode/RustDesk Server 精确源码补丁真值、RustDesk client fork 状态、全部 patch SHA-256 真值、scaling 来源身份/顺序以及 platform 角色齐全、来源复算与 endpoint 不可覆盖规则。4 个专用 Event WS/Tinode generator 用例已使用真实 loopback socket 通过；RustDesk 回归、RustDesk SDK/LED 对接、参考客户端、SDK build、参考客户端 production build、容量 Compose 渲染和 Go/Rust component hooks 的最新结果同样以机器可读状态文件为准。参考客户端没有上调 334 KiB 首屏预算：默认 application chunk 为 `311101` 字节，RustDesk SDK 与 UI 仅在进入远控 workspace 时加载为 `49775` 字节独立 chunk。该结果只证明代码和部署合同，不产生任何 `C_hard`、`C_safe`、Cell-10K 或 MIX-100K 容量结论。

因此当前准确结论是：“既有通信功能没有重做；Cell-10K / MIX-100K 的 placement、admission、组件 owner、分布式压测、曲线终结和平台放行代码已闭环。RustPBX、LiveKit、Tinode 与 RustDesk Server 的精确源码 overlay、原生编译/测试、本地 custom image 及首批热路径优化已通过；平台门禁已具备拒绝缺角色、曲线弯折、身份漂移、伪 endpoint 和受控证据冒充的完整入口。各组件不可变 Registry 制品、目标 Kubernetes 接管、真实多节点/双 Windows、九组件与 Cell 曲线及 100K endpoint 物理容量仍保持 `not_run`。”

## 14. OPC/LED 共用通信底座八项目标终审（2026-07-17）

### 14.1 终审口径

本节以当前工作树、源码、migration、OpenAPI、SDK、部署模板、验收程序和机器可读状态文件为
权威证据，对最初八项总目标重新逐项审计。完成口径是“无需真实外部资源的代码、架构、配置、
自动化门禁和交接材料全部闭环”；不是“生产环境已经上线”。目标明确允许后置的服务器、真实
PostgreSQL/NATS 多节点、LiveKit/TURN/Egress、双 Windows、PSTN、商业通知、真实智能 Provider、
生产对象存储和物理容量继续保持 `not_run`，任何受控结果均不得替代它们。

LED 业务逻辑、OPC 业务领域、移动端和数字人不属于 iveKit 底座。本节也不以历史阶段已有内容
反向缩小目标；以下八行分别覆盖原始目标中的全部命名能力。

### 14.2 八项要求与直接证据

| # | 原始目标 | 权威实现与交付证据 | 代码裁决 | 真实环境状态 |
| --- | --- | --- | --- | --- |
| 1 | Tinode IM 完整集成 | `src/agent-runtime/collaboration/tinode-*` 实现双向同步、会话、附件、已读/状态、离线恢复、原生 edit/delete outbox、迟到 echo 纠正、重放和指标；migration 062/074/105/106 持久化文件投递、mutation、closed-session inbound 和历史队列收敛；public/root API key 分离并拒绝同值、root service account bootstrap、provider user ID 撤权、session shared/exclusive lock、关闭后新写入与 delivery/retry/mutation 阻断均已实现；公开 module 不暴露 raw close；`services/ivekit-service/helm/ivekit/templates/tinode-*` 提供 bundled Kubernetes；`infra/ivekit/tinode/` 提供固定 `v0.25.3` 三节点 owner-aware fork；OpenAPI、SDK 和参考客户端均含消息、附件与 mutation 状态 | `implemented_single_node_verified` | 三节点故障、目标 PVC、长稳和 LED 浏览器 UI 为 `not_run` |
| 2 | LiveKit 全部基础音视频 | `src/agent-runtime/livekit/` 覆盖房间、Token、参与人、音视频、屏幕共享、Webhook、moderation、录制、QoS、超时和重入；migration 063/087/088/089 覆盖质量与 Egress job/reconciliation/capacity；`infra/ivekit/livekit/` 固定 `v1.13.4@0b3fd288...` owner/热路径 overlay，并已在隔离 Linux amd64 服务器完成单测、SFU race、离线构建和非 root smoke；Egress 双池仅接受批准仓库 `ivekit/livekit-egress` 的 digest-bound 镜像，并与 external LiveKit 显式共享 Redis address/认证/TLS，缺 digest/shared Redis、使用上游全限定别名或任意其他仓库均 Helm fail-closed；参考客户端实现断线恢复与 320/390 移动布局 | `implemented` | Server/Egress 不可变生产 digest/SBOM/签名/provenance、双客户端、摄像头/麦克风、TURN、对象链路、弱网和多实例为 `not_run` |
| 3 | RustDesk Windows 远控闭环 | `src/agent-runtime/collaboration/rustdesk-*`、`scripts/rustdesk-*` 与 `scripts/rustdesk-windows/` 覆盖授权码、device command、session hook、精准断开、owner epoch、剪贴板/文件/多屏/录屏观察、durable spool、evidence 上传、审计和 emergency fallback；`integrations/rustdesk-1.4.9/` 含 native control/evidence overlay；Windows workflow、安装包、SDK/LED facade 和参考工作区已交付 | `implemented_not_run` | 定制签名 Windows 制品、双物理机、UAC/login screen、同机多会话和真实文件/录屏为 `not_run` |
| 4 | RustPBX、SIP、WebPhone、IVR 与呼叫 | `src/agent-runtime/ivekit/voice/`、`ivr/` 和参考客户端 Voice/IVR 工作区覆盖注册、呼入/呼出、接听/拒绝、Hold、DTMF、设备、呼叫控制、路由、录音和 provider event；固定 RustPBX/rsipstack 源码 release 编译与本地 custom image 通过；`scripts/ivekit-rustpbx-sipp-acceptance.ts` 使用 SIPp 3.7.7 完成 12 个受控信令场景、19 个请求且 Router/CDR 增量均为 19 | `implemented_not_run` | 真实 RTP 音频连续性、浏览器 WSS/物理音频、PSTN、overload 曲线和 supervisor mixer 为 `not_run` |
| 5 | OCR、ASR、翻译、AI 质检、防绕单与 Provider 治理 | collaboration intelligence、attachment text、translation、quality review、policy scan 与 provider registry/governance/route 覆盖第三方 HTTP 和自建 Provider 双模式、健康检查、配额、熔断、降级、故障切换、OCR/ASR/帧 OCR、AI finding、人工复核和文本/图片防绕单；migration 059/060/076、OpenAPI、SDK 和参考质量工作区提供持久状态与操作面 | `implemented` | 真实厂商/自建模型、凭据、准确率语料、配额与故障切换为 `not_run` |
| 6 | 通知、文件安全、安全与运维 | `src/agent-runtime/ivekit/notifications/` 覆盖站内、Webhook、SMTP/HTTP Email、HTTP SMS、模板、偏好、回执、重试、死信和 Provider 治理；secure-file 模块覆盖 magic MIME、ClamAV/HTTP 扫描、隔离、转码、缩略图、分片续传、清理与 legal hold；authorization/audit/rate-limit/retention/heartbeat、监控、备份恢复、多副本 worker 和 Helm HPA/PDB/ServiceMonitor/PrometheusRule/Grafana/CronJob 已接线 | `implemented_not_run` | 商业邮件/短信、公网 Webhook、生产对象存储/ClamAV、目标监控栈、真实恢复和 Kubernetes 故障演练为 `not_run` |
| 7 | MIX-100K 双 Zone/Cell 生产代码 | migration 077–093、placement/admission/component-node runtime、稳定 owner/epoch、双 Zone/Cell lease、分布式 dispatcher/controller/worker/finalizer、JetStream/PostgreSQL/S3 evidence、容量探针、九组件 platform campaign 和 fork manifest 真值链已实现；LiveKit/Tinode/RustDesk 精确源码 overlay 已编译/测试，RustPBX 补丁队列和所有热路径优化接口已纳入交付 | `implemented_not_run` | 单机 frontier、1/2/4/8 曲线、Cell-10K、MIX-100K、真实多主机/JetStream/S3 和容量结论全部为 `not_run`，`capacity_claim=none` |
| 8 | LED/OPC 稳定 API、SDK、事件、Webhook 与交付 | `docs/openapi.yaml`、`sdk/ivekit/`、tenant event replay/WebSocket、durable integration webhook、Compose/Helm、migration/source policy、release contract、SBOM/checksum/tamper gate、升级回滚/监控/备份/验收 runbook 和 LED 对接示例均进入 source-bound delivery bundle；Egress overlay、Go policy、build script 与双池 Chart 以可构建相对目录进入 `components/livekit-egress/`；standalone source graph 禁止 OPC 产品域渗入 | `implemented` | 不可变生产镜像、目标 digest、正式 release commit、LED 真实 receiver 和目标部署签署为 `not_run` |

### 14.3 最终自动化证据

机器可读总表为 `docs/capacity/phase2-code-status.json`。本次终审的最新结果如下：

| 门禁 | 结果 | 能证明什么 |
| --- | --- | --- |
| 全仓 Node | `3360` total，`3348` pass，`12` environment skip，`0` fail | 当前源码、迁移、合同和部署静态行为无回归；skip 保持外部环境语义 |
| TypeScript | 根 typecheck 与独立 capacity-runtime typecheck 均通过 | 主运行图和容量交付运行图类型闭合 |
| 参考客户端 | unit `158/158`；production build 与 15 个 JS chunk budget 通过 | IM/Media/RustDesk/Voice/IVR/Ops 前端合同和懒加载可构建 |
| 受控 Chromium | `15/15` | 桌面/移动 IM、Media、RustDesk、Voice、IVR、Ops 流程；不代表真实 Provider |
| Helm/Stage 2 | Helm `v3.18.4`，lint/template 与发布合同 `20/20` | standalone、external LiveKit + shared Redis + digest-bound Egress 双池、RustPBX recording-spool 可渲染；缺 shared Redis/digest 会拒绝；不代表目标集群已应用 |
| Capacity | `303/303`；scaling `9/9`；platform `12/12` | placement、admission、evidence、曲线与平台拒绝规则；不产生物理容量结论 |
| Delivery | `55/55`；SDK build/pack `83` files | OpenAPI/SDK/交付清单、hash、tamper 和升级材料完整 |
| Standalone | `352` source、`8` runtime package；source graph/build 通过 | 可拆服务运行图不依赖 OPC 产品业务模块 |
| Component hooks | Go 与 Rust hooks 通过 | owner/admission hook 合同可编译测试；不是所有定制镜像已构建 |
| 差异完整性 | `git diff --check` 与 JSON 解析通过 | 当前差异无 whitespace error，机器状态可读取 |
| 独立终审 | `0 Critical / 0 Important` | Registry allowlist、路径/contract/digest、共享 Redis、Stage 2、build label、交付包与文档边界一致 |

最终审计期间，门禁和独立代码审查实际发现并关闭六类问题，而不是用文档掩盖：

1. Prometheus rules 存在重复 YAML key，已拆正 RustPBX recording 与 SIP overload 告警归属。
2. migration 091/092 和 recording-spool 入口加入后，standalone migration/source graph 断言漂移，已更新权威顺序与入口清单。
3. Egress Helm 模板错误依赖 `livekit.enabled=true`，导致生产常用 external LiveKit 模式不渲染 Egress；已解除耦合并实际渲染 Track/Composite、ServiceMonitor 和 PrometheusRule。
4. 参考客户端移动端 grid 使用裸 `1fr`，IM 390px 与 RustDesk 320px 发生页面级横向溢出；已改为 `minmax(0, 1fr)` 并限制 topbar，完整 Chromium `15/15` 复跑通过。
5. external LiveKit 的 Egress 仍硬编码 release-local Redis，语法可渲染但永远收不到外部 Server 的任务；现要求显式共享 Redis address/认证/TLS，缺失即 Helm fail-closed。
6. 双池默认使用不识别 iveKit pool 环境变量的上游 Egress 镜像，且交付包缺 overlay/build/Chart；现只接受路径以 `ivekit/livekit-egress` 结尾、Registry 主机显式列入 `media.egress.image.allowedRegistries` 且使用定制 `@sha256:...` 的镜像，默认仅批准 `docker.io`；`livekit/egress`、Docker Hub 全限定上游别名、任意其他路径、未批准私库和缺 digest 配置均拒绝渲染，build label 与 Chart 统一为 `ivekit-egress-pool-v1`，完整可构建组件目录进入 hash/tamper 交付门禁。Registry/digest Helm 门禁不替代生产镜像签名与 admission provenance 验证。

### 14.4 最终裁决与发布边界

第 14 节首次终审依据当时静态门禁，曾判断八项总目标的代码、架构、migration、API/SDK、部署模板、
自动化入口和交接材料已经闭环。后续 Docker 恢复后的真实运行在第 21 节发现 reservation RLS、
root Chart 应用镜像和 PgBouncer 三个发布缺口，并已用 forward migration、fail-closed 模板和真实
认证查询关闭。因此本段只保留审计演进记录，不再作为最新裁决；最新边界以第 21 节为准。

第 14 节首次终审时本机 Docker daemon 不可用，因此当时没有伪造 PostgreSQL 容器复跑；后续
Docker 恢复后的真实本机复验和修复记录见第 18 至 21 节。服务器
`64.225.122.227` 当前在 SSH key exchange 前主动断开，新 RSA key 尚未进入认证；服务器验证也
继续保持 `not_run`。上述外部项目完成后，必须通过 V6 八组真实验收模板、不可变 digest、证据
SHA-256、operator 与独立 QA 双签，才允许把对应状态从 `not_run` 改为 `passed`。

因此本轮可以关闭“共用底座剩余代码与交付收口”，但不能宣称“生产上线完成”或“十万并发已经
达标”。后续服务器可用时执行的是既有真实验收和容量程序，不是重新补功能。

## 15. 当前干净提交复验（2026-07-18）

本节不沿用前一工作树的通过标签，而是以干净提交
`eeede1609d1efbfff6ad08568b6e9efcfa8cdb54` 重新执行无需外部资源的门禁。复验前发现本机残留
多批已经失去父进程的历史 Node 测试 runner；它们均为旧测试命令、CPU 为零，清理后单文件和默认
并发全仓测试都能正常退出。该现象属于历史中断进程残留，不改变产品状态，也没有用进程清理替代
任何断言。

| 门禁 | 当前提交复验结果 |
| --- | --- |
| 根 TypeScript | `npm run typecheck`，通过 |
| Capacity runtime TypeScript | `npm run typecheck:ivekit:capacity-runtime`，通过 |
| 全仓 Node | `npm test`，`3360` total、`3348` pass、`12` environment skip、`0` fail，exit code `0` |
| 顺序全仓交叉验证 | `node --import tsx --test --test-concurrency=1 test/*.test.ts`，同为 `3348/3360` pass、`12` skip、`0` fail |
| Capacity | `npm run test:ivekit:capacity`，`303/303`；loopback `4/4` |
| Foundation/SDK | foundation `117/117`；SDK build 和 dry-run pack `83` files |
| Delivery | `npm run test:ivekit:delivery`，`55/55` |
| Standalone | `352` source files、`8` runtime packages、`11` 编译入口，通过 |
| Helm/Compose | 临时固定 Helm `v3.18.4`，Stage 2 `20/20`；capacity Compose quiet render 通过 |
| Go/Rust component hooks | Go 三包与 Rust `5/5` 通过 |
| 参考客户端 | unit `158/158`、production build 与 15-chunk budget 通过 |
| 受控浏览器 | Chromium 单 worker `15/15`，通过；仍不属于真实 Provider/媒体证据 |
| V6 真实环境清单 | 当前提交模板通过校验，八组全部保持 `not_run` |

`docs/capacity/phase2-code-status.json` 已同步绑定该干净提交并保持
`capacity_claim=none`。`generator_release_id` 仍明确为“等待不可变 capacity-tools 镜像构建和签名”，
不能因源码已有提交而视作生产制品。真实 PostgreSQL/NATS 多节点、定制镜像、Tinode/LiveKit/TURN/
Egress、双 Windows、RustPBX/SIP/RTP/PSTN、商业通知、真实 Provider、生产对象存储、目标 Kubernetes、
单机 frontier、Cell-10K 和 MIX-100K 继续为 `not_run`。

## 16. RustPBX 本机构建、SIPp 与存储故障隔离复验（2026-07-18）

本节覆盖后续工作树中的固定 RustPBX 原生构建、无 PSTN SIP 信令验收，以及“录音/录像存储故障
不得中断正在进行的电话或视频”这一硬约束。它补充第 15 节，不把 SIP 信令通过扩大解释为 RTP、
PSTN、TURN、真实 Egress 或容量结论。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 固定 RustPBX 原生构建 | `passed` | RustPBX `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`、rsipstack `8318e97b1170de4e5245b120afec1cdf53e3d716`、锁定 Cargo 图和完整补丁队列在 arm64 完成 release build；运行镜像 ID `sha256:89ca9e40712e8447314b77c310fede96517b77d64af79fbdea25fa83ba31c9dc` |
| 无 PSTN SIPp 3.7.7 | `passed_controlled_local` | 12/12 场景、19 个呼叫、Router delta 19、CDR delta 19；覆盖 UDP/TCP、接听/挂断、早取消、486、503、无应答、TCP 重连、UDP 重传、10 路并发和 REGISTER Digest 正反例；SIPp SHA-256 为 `8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef` |
| LiveKit 存储隔离 | `implemented_controlled` | LiveKit Server 部署图只依赖 Redis，不依赖 Egress/MinIO/S3；transfer accept 先将 call 置为 active、广播 `call.answered` 并立即返回 `call_status=active`、房间/token 与 `recording_status=scheduled`，录音授权查询和 Egress 启动均在响应路径外执行；模拟 Egress 延迟 800 ms 后返回 503 时 accept 仍在 300 ms 内完成，后台发送脱敏 `call.recording_failed`，并在录制记录已经进入 `failed` 后再次断言 call session 仍为 `active` |
| RustPBX 存储隔离 | `implemented_compiled` | RTP capture 使用有界 `try_send`，编解码/磁盘写入位于独立 worker；录制创建、停止和最终落盘位于固定大小的有界 lifecycle executor，SIP start/stop 不等待磁盘，Pause/Resume 只使用 `try_write`；收尾有界等待已接收样本并只尝试非阻塞取锁，超时仅使录音失败；异步启动前的样本丢失也会补绑计数器并进入 manifest；对象上传是反向依赖 RustPBX 的独立 sidecar；首次本地写失败会熔断 capture，后续只计丢弃；存在 dropped sample 的 manifest 强制失败为 `recording_samples_dropped`，不能进入可交付状态 |

首次 SIPp 运行中 10 个 INVITE 场景未收到响应。证据显示 RustPBX `ensure_user` 在 Router 前拒绝未知
`sipp` 用户；为 `172.30.44.20` 创建真实 inbound trunk 并从 loopback 热加载后，最小 route-reject、
answer-udp 和完整 12 场景依次通过。另一个环境问题是 Docker Desktop 普通 CLI socket 可查询但会
把新容器卡在 `Created`；验收显式使用 `docker.raw.sock` 后消失。这两项均未通过关闭认证或改弱生产
策略规避。

当前仍为 `not_run`：真实 RTP 音频包连续性、物理音频、PSTN、LiveKit 双浏览器/TURN/Egress、真实
对象存储中断与恢复、录音 spool 水位/磁盘故障实机演练、目标 Kubernetes、多节点故障及任何单机或
MIX-100K 容量结论。`capacity_claim` 继续为 `none`。

## 17. 精确源码、语音边界与录制隔离收口（2026-07-18）

本节记录第 16 节后的本机代码与构建证据。它不覆盖历史章节，也不把本机 Docker、临时
PostgreSQL 或静态 Profile 解释成目标服务器、真实媒体、Windows、对象存储或容量验收。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| Capacity PostgreSQL | `passed_controlled_local` | PostgreSQL `16.10` 临时容器应用 migration 077 后，lease、accounting、outbox、evidence 与 pass barrier 集成 `1/1` 通过；真实执行发现并修复 `controller_lease_expires_at` 未别名为 decoder 所需的 `lease_expires_at`，以及 `$7/$8` 同时进入 TEXT/JSONB 时缺显式 `::text` 导致参数类型不确定。目标库 migration/restart 仍为 `not_run` |
| RustDesk Client 1.4.9 | `implemented_not_run` | tag `1.4.9` 固定为 `6c578292e8ebbbec708b76986ba8c4bc7c509747`；overlay 校验 Git HEAD 和真实源码锚点并重复应用通过；Windows 编译、签名和双物理机仍为 `not_run` |
| LiveKit SIP v1.6.0 | `passed_controlled_local` | tag 固定为 `02179d2eebe1493ad8c6a7961ceee84c34f8aca3`；完整 Linux arm64 镜像 `sha256:54e9acaa0313728305c995bc6d5384f65b6e7366b278e20517b0ffe8fd03ade3` 构建并报告 `SIP version v1.6.0`；真实 SIP/RTP、PSTN、bridge failover 和 amd64 制品仍为 `not_run` |
| 语音 owner 边界 | `implemented_contract` | Cell-10K 与 MIX-100K Profile schema `1.2.0` 明确 RustPBX 独占 dialog、RTP、recording 与 admission；LiveKit SIP 为 `optional_bridge_excluded`，不计入当前容量；Profile 编译器会拒绝第二 owner 或启用未计量 bridge |
| LiveKit Egress v1.13.0 | `passed_controlled_local` | 精确 commit `7d3572a0bf1959cbbc452f5ba390b6a90b7dc249` 的 overlay 重复应用、pool policy 与 patched `pkg/stats` 测试、完整 CGO 编译和运行镜像构建通过；镜像 `ivekit/livekit-egress:v1.13.0-ivekit.1-7d3572a0`，ID `sha256:fde135c9f13c95e106ec5b075c9b039a95ac0c134f8f12e72018cc710f7810b2`，Linux arm64，非 root `egress`，版本 `1.13.0`，revision/pool-contract/二进制标记复验通过 |
| Egress 构建供应链 | `implemented_controlled` | 容器内不再直接下载 `go.dev` 裸 tar；build script 按 arm64/amd64 选择 SumDB 固定的 Go 1.26.2 toolchain，Ubuntu 索引使用 HTTPS 并支持审核后镜像，构建后自动检查架构、用户、标签、版本和 iveKit 标记；上游 template、Ubuntu package snapshot、Registry digest、SBOM、签名和 provenance 尚未全部不可变化，因此不宣称 bit-for-bit reproducible 或 production eligible |
| 录音/录像存储隔离 | `implemented_contract_and_controlled` | 两套容量 Profile 新增 `recording.failure_isolation`：存储只允许下游依赖，已建立媒体必须 fail-open，禁止媒体热路径反压，队列必须有界非阻塞，过载只可丢弃或失败录制副本；编译器负向测试会拒绝放宽。该合同与第 16 节 RustPBX/LiveKit 受控实现共同保证代码方向，不替代真实磁盘满、S3 中断、RTP/WebRTC 连续性证据 |

当前仍为 `not_run`：不可变 amd64 生产镜像及 Registry digest/SBOM/签名/provenance、目标 Kubernetes
部署与回滚、真实 LiveKit/TURN/Egress/对象存储、Track/Composite 双池隔离、真实 RTP/WebRTC 连续性、
PSTN、双 Windows、商业 Provider、单机 frontier、Cell-10K 和 MIX-100K。`capacity_claim` 继续为
`none`，存储中断时录制可以失败或不完整，但已建立电话、视频、屏幕共享和远控媒体不得因此终止。

## 18. SIP/VoLTE 显式激活与本机部署复验（2026-07-18）

本节收口历史 `sip_volte` 固定 planned stub。它证明运行时配置、API 真值、部署模板和自动门禁已经
一致，不把静态激活或健康探针解释成真实运营商线路已经接通。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| Gateway 激活合同 | `implemented` | `OPC_SIP_VOLTE_ENABLED=1` 且 LiveKit URL/key/secret、SIP bridge target、RustPBX trunk、RWI URL/token 全部有效时注册表才将 `sip_volte` 标记 active；缺项、控制字符、非法 SIP target、带 URL 凭据/查询串或未启用均 fail-closed 为 planned，不再需要修改源码常量 |
| Capabilities/OpenAPI | `implemented` | `GET /api/ivekit/media/capabilities` 读取当前 Media Core 实际使用的 gateway registry，`data.capabilities.sip_volte=ready|planned`；修改 env 不会绕过未重启的 planned registry 动态提升状态。OpenAPI 3.1 明确声明与实现一致的 `{data: IveKitMediaCapabilities}` envelope，响应只给布尔/枚举状态，不泄露 URL、API key、RWI token 或 secret |
| Readiness/探针 | `implemented` | `smoke:media:sip-volte`、总 readiness 与 deployment preflight 都要求显式启用和完整配置；总 readiness 要求开关精确等于 `1` 并强制子命令使用 active-gateway 模式，preflight 复用运行时 resolver 拒绝危险 SIP target、trunk 和带凭据/查询串的控制 URL；报告只输出布尔配置摘要，可选 runtime probe 只允许把静态 active 降级；任何 planned 结果都会使总门禁失败 |
| Compose/Helm | `passed_controlled_local` | 本机 Docker 28.3.2 已恢复；root、production、infra/ivekit、service 四套 Compose quiet render 通过。独立 service 基础 Compose 已把可选 `voice-runtime.env` 注入 iveKit 进程，使 RWI token 可通过既有秘密文件进入 SIP 激活合同；Docker 实跑发现 production env 的 Voice address/HMAC key 为空会在 profile 选择前触发 `${VAR:?}` 失败，已改成必须替换的显式占位值，真实 Voice preflight 仍拒绝占位密钥。固定且校验 SHA-256 的 Helm v3.18.4 完成两套 Chart lint/template，Stage 2 `22/22` 通过 |
| 自动化回归 | `passed` | SIP/媒体/部署/OpenAPI/存储隔离 focused `138/138`；Delivery `56/56`；standalone context `352` source、`8` runtime packages、`11` entrypoints；根/Capacity typecheck 通过；全仓 `3395` total、`3383` pass、`12` environment skip、`0` fail |

当前仍为 `not_run`：RustPBX ↔ livekit-sip ↔ LiveKit 真实 SIP/RTP 媒体、运营商 VoLTE/PSTN、真实
双客户端与 TURN、桥接故障切换、amd64 生产制品、目标 Kubernetes rollout 和容量。静态
`data.capabilities.sip_volte=ready` 只代表本进程具备执行配置；运行时探针只代表桥控制面按本次配置健康；
两者都不能替代真实呼叫、双向音视频和断线恢复证据。

## 19. LiveKit 录制存储故障真实进程演练（2026-07-18）

本节落实“录音、录像存储服务崩溃不得影响正在进行的电话或视频传输”硬约束。演练使用本机
Docker 隔离项目 `ivekit-fresh-audit`，属于真实 LiveKit/Egress/MinIO/Chromium 进程证据，但网络、
凭据和对象存储仍是受控本机环境，因此状态为 `passed_controlled_local`，不提升 V6 生产环境结果。

| 检查 | 结果 | 直接证据 |
| --- | --- | --- |
| Fresh storage bootstrap | `passed_controlled_local` | PostgreSQL/Tinode fresh volume 自动建库；新增固定版本 `minio-init` 幂等创建 `recordings` bucket、关闭匿名访问并阻塞 Egress 启动；认证 `stat` 成功，匿名 HTTP 为 `403` |
| 故障前媒体 | `passed_controlled_local` | 两个独立 Chromium context 以真实 LiveKit token 加入同一房间并发布 fake-device 麦克风和摄像头；每端 `connected`、1 个 remote participant、2 条 remote publication、2 条 local publication |
| 真实录制任务 | `passed_controlled_local` | RoomComposite Egress `EG_qVcutYYLXcAr` 进入 active 后才停止 MinIO；不是 mock/fake Egress 返回值 |
| 存储中断媒体连续性 | `passed_controlled_local` | MinIO 停止 5 秒后两端 participant/publication 快照完全不变；请求结束录制后 Egress 因 S3 PutObject 失败进入 `failed`，随后再次采样，两端仍全部 `connected` 且轨道数不变 |
| 故障域隔离 | `passed_controlled_local` | LiveKit `RestartCount=0`，`StartedAt=2026-07-18T13:24:02.061116594Z` 在存储故障前后不变；Egress 失败没有触发房间重建、peer 重连或 track 重发 |
| 恢复与秘密安全 | `passed_controlled_local` | 自动恢复 MinIO 并重跑 bucket bootstrap；MinIO/Egress 均恢复 healthy；结构化报告只保留 `storage_upload_failed`，不保存 S3 endpoint、API secret、token 或原始 Egress 错误，输出文件权限为 `0600` |

可重复命令为 `npm run livekit:storage-isolation-acceptance`。它要求显式给出 LiveKit URL/key/secret、
隔离 Compose project 和 compose file；服务名只接受安全标识符，Docker 使用参数数组执行。运行时依次
创建房间、打开双 peer、启动录制、停止存储、校验媒体、确认录制失败、再次校验媒体、恢复存储，
且任何中途错误都按“恢复存储 -> 关闭 peer -> 删除房间”顺序清理。自动化覆盖正常路径、媒体中断、
部分 peer 建链失败和原始端点不进入报告。

本轮最终门禁：存储/视频/Voice/RustPBX focused `61/61`，Delivery `56/56`，校验 SHA-256 的 Helm
v3.18.4 Stage 2 `22/22`，根 TypeScript 通过；全仓在 `OPC_USE_MEMORY_REDIS=1` 下为 `3405` total、
`3393` pass、`12` environment skip、`0` fail。第一次全仓并行运行时，本轮 Docker Redis 已停止但
Docker Desktop 6379 端口代理仍 accept 后 reset，使旧 call-center 测试的 ioredis 重连句柄不退出；
关闭受控项目并使用仓库正式内存 Redis 测试模式后完整通过。该环境问题没有通过删除测试掩盖。

该演练关闭了第 16-18 节中的“本机双客户端 + Egress + MinIO 中断”缺口，但以下仍为 `not_run`：
公网 TURN/TLS/UDP、生产 S3 或等价对象存储、跨主机/跨 Zone、多 Egress 池、目标 Kubernetes、磁盘满、
RustPBX 真实 RTP/物理音频、PSTN，以及存储长时间中断后的 spool 水位和容量退化。电话侧已有编译通过
的 RustPBX 有界非阻塞 capture、独立 lifecycle worker、本地 durable spool 和上传 sidecar；仍需在
真实 RTP 会话中做同类故障演练后才能将 Voice V6 项提升。

后续交付复审发现首版只把 runner 源码复制到 `acceptance/tools/`，离开 OPC 源码树后仍会借用
`clients/ivekit-reference/node_modules`，不满足独立交接。现已改为
`acceptance/livekit-storage-isolation/` 独立包，包含 runner、README、精确 package/lock；依赖固定为
LiveKit Client `2.20.1`、Server SDK `2.17.0`、Playwright `1.61.1`、tsx `4.23.1`，并 override
esbuild `0.28.1`。runner 优先解析包内依赖，源码 checkout 才 fallback 到 reference client；配置支持
一个 Compose file 或有序 JSON base/overlay 列表及可选 env file。`/tmp` 离仓执行 `npm ci` 安装 28 个
package、`npm audit` 0 vulnerability，并成功加载 runner/runtime 与解析三个本地依赖；交付生成、hash、
秘密扫描和 README 命令也进入自动门禁。该改善只使受控验收工具可独立运行，不改变生产项 `not_run`。

2026-07-25 在隔离 Linux 服务器完成增强复验，裁决提升为 `passed_controlled_server`，但仍不是
生产 HA 或容量结论。新版 runner 不再只看连接与 publication，而要求双 peer 的 inbound/outbound
音频字节、视频字节、RTP 包和视频解码帧在四次快照间逐阶段严格增长。MinIO 停止后首次 Egress
`EG_XTxdm8YhXCgZ` 以 `storage_upload_failed` 失败，媒体仍持续；恢复 MinIO/bucket 后，同一房间
第二个 Egress `EG_dRrUH8GeZ29k` 以 `complete` 结束，认证对象核验得到 99,530 bytes 的
`video/mp4`。隔离四组件与九个既有基线容器均 `RestartCount=0`、`OOMKilled=false`。专项本机和
服务器各 `11/11`、相关 LiveKit/Egress/Delivery 回归 `97/97`、根 TypeScript 通过。机器证据见
`docs/evidence/wave2-livekit-storage-isolation-server-validation-2026-07-25.json`。

## 20. 对象存储不可变部署与健康门禁复审（2026-07-18）

本节收口录制存储故障隔离的部署可复现性，不新增“存储高可用已通过”的结论。root 与 production
Compose 的 MinIO Server 固定为 `RELEASE.2025-09-07T16-13-09Z` 及 manifest digest
`sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`，MinIO Client 固定为
`RELEASE.2025-08-13T08-35-41Z` 及 digest
`sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727`。两个引用均已由 Docker pull
返回同一 digest；独立 LiveKit storage overlay 同时要求 tag 与 digest，不再允许仅靠可变 tag。

production Compose 新增 `/minio/health/live` 探针，`minio-init` 必须等待 `service_healthy`；Egress 和
OPC 的存储入口继续等待 bucket bootstrap 完成。LiveKit Server 与 RustPBX 没有新增 MinIO/Egress
依赖，故障方向仍严格为“实时媒体 -> 可选录制 -> 存储”，禁止存储状态反向决定 RTP/WebRTC 存活。
Kubernetes MinIO 使用同一固定 release+digest，模板拒绝非 `sha256:<64 hex>`，并配置 startup、
readiness 与 liveness 探针；这只改善 rollout/readiness，不把单副本 MinIO 解释成生产 HA。

TDD 契约从 4 个预期失败恢复到 `22/22`；Helm v3.18.4 对两套 Chart lint/template 通过，非法 MinIO
digest 实际 fail-closed，Stage 2 为 `22/22`。Docker Desktop 默认代理 socket 会让任何新容器停在
`Created`，最小 Alpine 同样复现；改用 daemon raw socket 后无需重启 Docker，固定 digest 的真实
进程演练重新通过。双 Chromium 在故障前、中和 Egress 失败后三次快照完全一致，录制终态为
`storage_upload_failed`，LiveKit `RestartCount=0`；恢复后 MinIO healthy、认证 bucket `stat` 成功、
匿名访问为 `403`，证据文件 `0600` 且秘密扫描通过。受控容器、网络和卷随后全部清理，三台既有
SIPp 容器未被操作。生产 S3/跨 Zone/磁盘满、RustPBX 真实 RTP 和目标 Kubernetes 继续为 `not_run`。

## 21. PostgreSQL、应用镜像与连接池发布门禁复审（2026-07-18）

本节绑定代码提交 `18a7c833dc4e82aa88fc5f9733b3bd81930feec5`，关闭三个会在真实发布时
直接阻断上线或削弱租户隔离的缺口。它不改变生产环境 `not_run` 边界。

### 21.1 PostgreSQL migration 与 RLS

真实临时 PostgreSQL 复跑首先发现 `ivekit_cell_admission_reservations` 没有启用、强制 RLS。没有修改
已经进入 checksum ledger 的 migration 083，而是新增 forward-only migration 093：启用并强制 RLS，
按 `app.current_tenant` 创建 tenant policy，并在 `opc_runtime` 存在时授予最小表权限。升级 fixture 还
发现自己跳过 Voice foundation migration，却保留依赖它们的 079/086；现同时移除依赖 migration，
并把 route snapshot 与 recording manifest/segment/upload 表纳入升级后保留断言。

`scripts/verify-ivekit-postgres.sh` 已在本机临时 PostgreSQL 中通过 standalone fresh migration/RLS、
既有 OPC 升级且数据不丢失、Tinode inbound durable、Tinode projector/mutation echo、IVR PostgreSQL
和受控 RustPBX PostgreSQL 全部场景。该证据证明当前 migration 顺序、checksum、最小权限、RLS 与
升级保留；不证明目标生产库、多副本竞争、跨 Zone 延迟、备份恢复或长稳。

### 21.2 Kubernetes 不可变应用镜像

root Helm Chart 原来仍使用 `opc/platform:latest`、`opc/ai-agent:latest` 和 `opc/frontend:latest`。
现三个应用镜像均必须提供完整 `sha256:<64 hex>` digest，并只渲染 `repository@digest`；缺失、格式
错误或继续依赖 tag 都会 fail-closed。RustDesk 生成的 Kubernetes install/rollback 命令新增
`OPC_RUSTDESK_DEPLOYMENT_HELM_VALUES_FILE`，必须携带含实际 digest 和生产配置的 values 文件，
避免生成一条注定无法部署或偷偷使用默认镜像的命令。

固定 Helm v3.18.4 已实际完成 standalone/root Chart lint/template，应用 digest 缺失负例和 Egress
共享 Redis、仓库 allowlist、digest 负例全部按预期拒绝，Stage 2 为 `22/22`。这证明模板 fail-closed，
不代表生产 Registry 中已经存在 amd64 镜像、SBOM、签名、provenance 或目标集群 rollout。

### 21.3 PgBouncer 可运行性

production Compose 原来的 `bitnami/pgbouncer:latest` 当前无法解析，且可变 tag 不符合发布要求。
现固定为多架构
`edoburu/pgbouncer:v1.25.2-p0@sha256:7d7a27d9e90985cab5cf42256f5c13a3120baa4b055b69df37beb272b89b2340`，
配置 `scram-sha-256`、transaction pooling、`max_client_conn=200`、`default_pool_size=20`，健康检查仍
通过 6432 端口执行带凭据的 `SELECT 1`，不会把仅 TCP 可连接误报为数据库健康。

本机隔离 Docker 网络中，固定 digest 的 PgBouncer 1.25.2 已连接临时 PostgreSQL，认证查询返回
`opc|opc`，生成配置与预期完全一致；测试容器和网络随后清理。该结果证明镜像、环境变量、SCRAM、
连接池端口和认证健康检查可运行，不代表生产连接数、故障切换、TLS、密码轮换或目标数据库通过。

### 21.4 最新门禁与故障域边界

根 TypeScript 通过；全仓 Node 为 `3406` total、`3394` pass、`12` environment skip、`0` fail；
PostgreSQL harness、Helm Stage 2 `22/22` 和 PgBouncer 真实认证查询均通过。录音/录像存储隔离结论
保持不变：LiveKit Server 和 RustPBX 媒体热路径不依赖 Egress、对象存储或上传 worker，存储故障最多
让录制失败、排队、丢弃或进入补偿，不得终止、回压或重建正在进行的 SIP/RTP/WebRTC 会话。

仍为 `not_run`：目标 PostgreSQL/NATS 多节点、目标 Kubernetes、生产 Registry 制品与签名、生产
对象存储、真实 Provider、双 Windows、PSTN、真实 TURN/Egress 公网媒体以及单机/Cell/MIX-100K
物理容量。机器可读权威状态继续使用 `docs/capacity/phase2-code-status.json`，`capacity_claim=none`。

## 22. RustPBX `.10`、WebPhone 与 RustDesk 精准会话收口（2026-07-19）

本节是基于提交 `a2644c09975340459feee979a773d09340207e7b` 的后续工作树复验，覆盖第 21 节之后的
Voice、IVR、RustDesk 和交付合同变化。本节的测试计数为当前最新权威结果；旧章节中的计数只表示
当时提交的历史证据。工作树尚未生成生产制品，因此任何源码、受控门禁或本机结果都不能提升外部
真实环境状态。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| RustPBX 会话清理隔离 | `implemented_compiled` | 新增 `.10` session-cleanup patch。Destroy/stale reap 先把 session 从实时状态移除、暂停录音并提交去重 finalizer；播放、MCU 和 bridge 清理进入限并发、硬超时后台任务。`SessionDestroyed` 只确认实时状态移除，不确认录音持久化。`rustpbx_media_session_cleanup_total{outcome}`、Helm/Compose 参数和 `IveKitRustPbxSessionCleanupDegraded` 已接线。精确源码重放、Rust 1.94.1 macOS arm64 `cargo check --locked --features cross --bin rustpbx --bin sipflow` 和 recorder/cleanup 相关 Rust 单测通过；Linux 镜像、阻塞文件系统注入和真实 RTP 连续性仍为 `not_run` |
| RustPBX WebPhone registry | `implemented_compiled` | `.10` 将上游全局 `Mutex<Vec>` pre-auth registry 改为 O(1) keyed `RwLock<HashMap>`，连接生命周期 guard 只删除自身 generation，地址复用时旧连接不能删掉新连接；10,000 entry keyed lookup Rust 测试通过。Linux WSS 运行时负载仍为 `not_run` |
| WebPhone session 签发 | `implemented` | migration 094 新增 tenant RLS、幂等唯一键、过期索引和按 tenant 有界 `SKIP LOCKED` 清理；`SECURITY DEFINER` 清理函数即使收到 NULL limit 也只取有界默认值。standalone server 按显式开关注入 PostgreSQL session service，短期 WSS/SIP credential 由 HMAC 生成且不持久化。配置、权限、幂等冲突、过期清理、SDK/controller 和 OpenAPI 合同通过；真实浏览器向 RustPBX 注册、ICE/RTP 和物理音频仍为 `not_run` |
| IVR RWI 执行 | `implemented` | inbound call 只有在已持久化且可执行的 IVR action 存在时才 answer，否则 fail-closed hangup；DTMF/timeout/barge-in 按 call 串行并设置总量与单 call 有界队列。只有 provider 显式提供 `event_id`、`action_id` 或 sequence 时才去重，无 ID 的相同连续按键不会被误丢；任务失败被收敛并允许 provider 重试，revision CAS 防止并发覆盖；transfer provider exchange 不再重复执行外部副作用。真实 RustPBX RWI 长稳、语音播放/采集和 provider transfer 媒体仍为 `not_run` |
| RustDesk 一次性授权并发 | `implemented_not_run` | verified code 在创建 gateway 前原子进入 `claimed`，成功持久化后才 consume；claim 受 actor、TTL 和唯一 claim ID 约束，失败释放，过期 claim 可恢复，数据库约束强制 claimed actor 与 verified actor 一致。migration 095 为已经执行旧 064 的数据库提供 forward-only 升级；新库 schema 与 MemoryPg 同步。真实 PostgreSQL 多实例竞争和进程崩溃恢复仍需目标环境复验 |
| RustDesk 原生精准断开 | `implemented_not_run` | gateway 创建时生成服务端原生 session ID，launch plan 只在 `rustdesk://` 的 `ivekit_session_id` 参数中传递并从公开 metadata 删除；定制 1.4.9 overlay 将它贯穿深链、Flutter、多窗口、IPC 和 connection manager。named-pipe resolver 同时匹配 `native_session_id + controller_rustdesk_id`，响应也回显并复核该 ID，避免同控制方并发会话互相误断。overlay/SDK/HTTP/Windows companion 静态与单元门禁通过；Windows 编译、签名和双物理机精准断开仍为 `not_run` |
| 录制存储故障域 | `implemented_contract_and_controlled` | LiveKit Server 继续不依赖 Egress/MinIO；RustPBX RTP capture、录音 lifecycle、session cleanup 和对象上传均不向实时媒体命令循环反向等待。存储、writer、uploader 或 cleanup 故障允许录制不完整、丢弃、失败或资源强制回收，但不得终止或回压已建立电话/视频。第 19-20 节 LiveKit 受控本机进程证据仍有效；RustPBX 阻塞磁盘、真实 RTP 和跨节点故障注入保持 `not_run` |

### 22.1 当前门禁

| 门禁 | 2026-07-19 结果 |
| --- | --- |
| 全仓 Node | `OPC_USE_MEMORY_REDIS=1 npm test`：`3435` total、`3423` pass、`12` environment skip、`0` fail |
| 根/Capacity TypeScript | `npm run typecheck` 与 `npm run typecheck:ivekit:capacity-runtime` 均通过 |
| Foundation/SDK | foundation `118/118`；SDK build 通过；dry-run pack `83` files |
| Delivery/OpenAPI | `npm run test:ivekit:delivery`：`58/58`；新增 RustPBX patches、migration 094/095 和 Voice/RustDesk API 均进入 hash/tamper 合同 |
| Capacity | `npm run test:ivekit:capacity`：`312/312`；真实 socket loopback `4/4`；只证明 admission/placement/evidence/曲线拒绝规则，不产生容量结论 |
| Standalone source | source graph/build context `10/10`，不引入 OPC 产品域或 SQLite runtime |
| RustDesk focused | HTTP、module facade、launch plan、native overlay `62/62`；内部原生 session ID 不出现在公开 metadata |
| Compose/Helm | Docker Compose quiet render、standalone/root Helm v4.2.3 lint/template 和 Stage 2 `22/22` 通过；没有 apply 到目标 Kubernetes |
| 工作树卫生 | `git diff --check` 通过；fork manifest JSON 可解析且声明的 patch SHA-256 由容量门禁复核 |

本机 Docker Desktop 可查询引擎，但当前新容器启动会停在 `Created`；本轮没有重启 Docker、终止既有
容器或用旧容器冒充 `.10` 验收。`.10` Linux image、amd64 Registry digest、SBOM/签名/provenance、
真实 PostgreSQL/NATS 多节点、Tinode/LiveKit/TURN/Egress 公网链路、双 Windows、RustPBX WSS/RTP、
PSTN、真实 Provider、商业通知、生产对象存储、目标 Kubernetes、单机 frontier、Cell-10K 和
MIX-100K 均保持 `not_run`。`capacity_claim` 继续为 `none`。

## 23. Kamailio SIP Edge、WebPhone 集群与 QUIC 评审收口（2026-07-21）

本节补齐第 22 节尚未覆盖的正式 SIP Edge。它把 RustPBX 从“可直接接入的单节点能力”提升为 Cell
内由 Kamailio 接入、容量选择和 dialog 固定的节点池，但不把静态配置、受控驱动或模板渲染解释为
真实双 Zone、PSTN、物理媒体或 10K/100K 容量证据。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 本地路由与容量 | `implemented_controlled` | route-agent 并行读取 component-node state，生成有大小、节点数、TTL、Cell identity、lease epoch 和 sequence 边界的签名快照；原子编译 dispatcher relative-weight 新呼叫池和稳定 pin set，通过 loopback-only JSON-RPC reload。快照过期停止新 INVITE，已有 pin set 保留；RustPBX admission 继续做最终硬门 |
| SIP 故障语义 | `implemented_controlled` | OPTIONS 与 component lease 双门，draining 退出新呼叫池但保留 owner；未接通请求只对 transport、408、500/502/503/504 有界重试，业务 4xx 不重试，2xx 后禁止换 owner。TLS/WSS、topoh、来源 ACL、CPS、header 重建和 RPC/metrics 私网边界已进入 renderer 与测试 |
| WebPhone 双重鉴权 | `implemented_controlled` | Edge 对 WSS 执行精确 HTTPS Origin、HS256、issuer/audience、时效和 subject 校验，只保存 connection-subject；每个 WSS SIP 请求要求 From 等于 subject，并新签 30 秒内部 JWT 供 RustPBX 再验证。浏览器 token 不进入 htable 复制、配置输出或证据。RustPBX fork 同时约束所有鉴权结果与 From 一致 |
| REGISTER 与跨 Edge location | `implemented_not_run` | RustPBX 是分机权限和 PostgreSQL locator authority；Edge 只在 RustPBX 2xx 后保存 usrloc。正式 Helm 使用 Kamailio StatefulSet、稳定 ordinal、headless Service 和专用 UDP 5066 `dmq_usrloc`；启用时要求至少两个同端口 bootstrap，公网 Service 不暴露 DMQ。Compose 单 Edge关闭 DMQ，因此真实跨 Edge 注册/投递仍为 `not_run` |
| WebPhone dialog | `implemented_controlled` | RustPBX 初始 INVITE 沿 REGISTER Path 或复制 location 到达浏览器，两条路径都写入 `ivkwp=1` Record-Route。后续 RustPBX→浏览器剥离内部断言，WSS→RustPBX保留本请求新签断言，其他来源拒绝；该 dialog 不再误入普通 RustPBX pin-set 并返回 481 |
| 部署与交付 | `implemented_controlled` | Compose 提供单 Edge/一或两 RustPBX 受控拓扑；Helm 提供两 Edge StatefulSet、PDB、spread、NetworkPolicy、私有 route-agent metrics、RustPBX StatefulSet/headless Service和直达 RTP。交付白名单包含 Kamailio 源码镜像、dispatcher patch、renderer、route-agent、Chart、12 场景矩阵、WSS driver 和 RustPBX WebPhone Edge-auth patch，并受 SHA-256/tamper 合同约束 |
| 监控与故障处置 | `implemented_controlled` | 新增快照、节点、reload、core proxy、failover、pin、WebPhone auth/assertion/registration/location/delivery 和 DMQ rejection 指标；PrometheusRule、Grafana 和 runbook 维持低基数，禁止 tenant、号码、call/session ID 标签 |
| QUIC 视频传输 | `assessed_deferred` | ANRW 2026 RoQ 论文支持 QUIC 作为 RTP/RTCP 多路复用层的研究价值，但其原型是 Pion/Rust/quiche 受控评估，不是 LiveKit 生产 SFU 的可直接替换实现。当前生产主链保持 LiveKit/WebRTC；先完成 RTCStats→QoS 与媒体感知上传 governor，再在独立 Pion/quic-go 实验通道验证 RoQ，必须保留 WebRTC fallback，详见 `docs/design/quic-video-transport-assessment.md` |

代码完成门禁包括 TypeScript、Kamailio/RustPBX focused、delivery hash/tamper、standalone source、
Compose render、Helm lint/template、Prometheus YAML、Grafana JSON 和 SIPp XML。当前机器无法完成固定镜像
内 `kamailio -c` 与真实 Docker SIPp/WSS/DMQ 运行时验证时，这两项必须保持 `not_run`，不能由 renderer
测试代替。真实 PSTN/RTP、双 Edge WSS/DMQ、目标 Kubernetes、双 Zone、长稳、单机 frontier、
Cell-10K 和 MIX-100K 也继续为 `not_run`；`capacity_claim=none`。

## 24. Wave 1 OCI 核心镜像供应链复审（2026-07-22）

本节补齐仓库自有核心镜像的统一构建入口，不把服务器本地镜像误报为生产 Registry 制品。
`.github/workflows/ivekit-source-image-release.yml` 统一执行固定 commit 的 Actions、Git SHA tag、
amd64/arm64 构建和 digest 交接，再调用唯一 OCI release gate 完成 Trivy、Cosign、SBOM 与 provenance。
核心矩阵已覆盖 OPC platform、frontend、iveKit service、capacity tools、Kamailio 和 AI agent；外部
基础镜像全部固定 digest。

服务器首次真实构建发现 iveKit service 不能直接使用 `services/ivekit-service` 作为上下文，因为权威
源码位于根 `src/`。现工作流只允许 `none|ivekit-standalone` 两种预处理模式，拒绝任意 shell；服务镜像
先按 source policy 生成独立上下文再构建。服务器契约测试 `7/7`、Actionlint `1.7.12`、capacity-tools
及 iveKit-service Linux amd64 构建和无网络运行检查均通过；两个镜像运行 UID 均为 1000。详细 image
ID、体积和 context checksum 见 `docs/evidence/wave1-oci-source-image-server-validation-2026-07-22.md`。

仍为 `not_run`：GitHub Runner 多架构构建、GHCR push、Registry Trivy、Cosign、GitHub attestation、
目标 Kubernetes admission/rollout。本节记录时尚未接入的 LiveKit Egress、Tinode release gate 已由
第 26 节关闭代码缺口，但其工作流仍未实际执行。上述服务器镜像不得作为已签名生产制品使用；
`capacity_claim` 继续为 `none`。

## 25. LiveKit Server v1.13.4 精确源码 rebase（2026-07-22）

LiveKit Server 已从 `v1.13.3@8f6a9cb...` 升级为精确
`v1.13.4@0b3fd288e3ef3263ec475ba0d78cf3ad77459981`。owner overlay 与小房间热路径补丁已在新源码上重新生成，
不是把旧 patch 以宽松模式强套到新版本。rebase 保留上游动态 fanout threshold 和乱序包不计入稳态
forwarding latency 的修复，同时保留 iveKit 不可变 downtrack snapshot、普通 RTP 与 Opus RED 的小房间串行路径。

隔离 Linux amd64 服务器对干净源码连续执行 overlay 两次，结果为 `applied`、`already_applied`；
`cmd/server`、`pkg/sfu`、`pkg/sfu/utils`、component hook 与 owner module 的 Go 1.26.5 测试通过。
使用 vendor tree 和 `--network=none` 构建的候选镜像为
`sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963`，37,554,217 bytes，
运行 UID/GID 为 `10001:10001`，版本、精确 revision、component/owner labels 与 fork marker 均通过。
首个 root runtime 候选被判定为安全缺陷并废弃，最终 overlay 已强制非 root。

`.github/workflows/ivekit-livekit-server-image.yml` 已接入精确双 checkout、Go 测试、vendor、多架构构建和
统一 OCI release gate。详细服务器记录见
`docs/evidence/wave1-livekit-server-v1.13.4-validation-2026-07-22.md`。

仍为 `not_run`：GHCR 多架构 digest、Trivy/SBOM/Cosign/provenance、真实双客户端媒体、
强制 TURN、弱网、重连、排空、节点故障、多节点 Redis routing、目标 Kubernetes 与 Cell 容量。历史
v1.13.3 race 和 Apple M5 微基准只保留为历史证据，不自动成为 v1.13.4 结论；`capacity_claim=none`。

## 26. Tinode 与 LiveKit Egress 精确源码 OCI 收口（2026-07-22）

本节关闭第 24 节记录的两个 release-gate 代码缺口，同时坚持“服务器候选镜像不等于 Registry
生产制品”。所有动态构建和运行态验收在 `64.225.122.227` 的隔离目录完成，本机没有运行 Docker
回归；LED Compose 项目前后均保持 7 个运行容器，验收结束后没有遗留 Tinode/Egress 容器。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| Tinode `v0.25.3` | `passed_controlled_server` | 精确 `22a7c18e9cd695e9a061bf1b8c84175196ef5a15`；overlay 重复应用幂等；依赖预先 vendor，最终 Docker build 使用 `--network=none`；仅复制必需源码子树并以 `10001:10001` 运行。Linux amd64 镜像 `ivekit/tinode:v0.25.3-ivekit.2-22a7c18e-amd64`，ID `sha256:d87632a4b964cb260019c6bbd032b938d3c7d1fefb0c02248666b4d963e1dbc9`，`46,877,689` bytes；版本、revision、component/owner contract 和二进制标记通过 |
| LiveKit Egress `v1.13.0` | `passed_controlled_server` | 精确 `7d3572a0bf1959cbbc452f5ba390b6a90b7dc249`；overlay 重复应用幂等；SumDB 固定 Go 1.26.2、vendor、最终 `--network=none` 构建；模板、GStreamer builder 与官方 Egress runtime 均固定 manifest digest。Linux amd64 镜像 `ivekit/livekit-egress:v1.13.0-ivekit.1-7d3572a0-amd64`，ID `sha256:e266932c428610111a417d6b38cbec7096680816eae09b23495575035456d3fe`，`1,413,726,105` bytes，非 root `egress`；版本、revision、pool contract 和二进制标记通过 |
| 供应链 workflow | `implemented_not_run` | 新增 Tinode、Egress 精确源码 amd64/arm64 workflow，校验不可变基础镜像，发布单一 GHCR manifest digest 后调用统一 OCI gate；focused 契约测试在服务器通过 `24/24`。GitHub Runner、GHCR、Trivy、SBOM、Cosign 与 provenance 尚未执行 |
| 构建兼容性修复 | `passed_controlled_server` | 服务器 Docker 29 无 Buildx，legacy builder 暴露并验证了 Tinode 通配 `COPY` 目标、Bash 路径、Go cache 同层清理，以及 Egress 重跑前清理已物化 toolchain 四个问题。修复后两镜像均离线完成并通过身份检查 |

完整基础镜像 digest、命令边界和 `not_run` 清单见
`docs/evidence/wave1-tinode-egress-oci-server-validation-2026-07-22.md`。

仍为 `not_run`：两个新 workflow 的真实 GitHub Runner/arm64/GHCR 执行，Registry digest、漏洞扫描、
SBOM、签名和 provenance，Tinode 三节点/原生客户端/重连/容量，Egress Track/Composite 真实媒体、共享
Redis 中断、对象存储故障、目标 Kubernetes 和容量。`capacity_claim=none`。

## 27. LiveKit Ingress v1.5.0 生产化底座（2026-07-23）

本节把此前缺失的 RTMP、WHIP 和 URL pull 输入能力补入共用通信底座。Ingress 媒体处理继续由
LiveKit Ingress 独立 worker 负责，iveKit API 只处理租户授权、幂等、房间归属、审计和 provider
编排，不把转码或媒体包处理引入 Node.js 控制面热路径。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 精确源码镜像 | `passed_controlled_server` | `livekit/ingress v1.5.0@363f6090d572db8eef5b60c273c0970826fb7ca6`；overlay 重复应用幂等；Go 1.25.0 SumDB 校验、vendor、digest-bound GStreamer builder/runtime 和最终 `--network=none` 构建；Linux amd64 镜像 `ivekit/livekit-ingress:v1.5.0-ivekit.1-363f6090-amd64`，ID `sha256:639b1689dfae305b6495467c71ed7e2ce42f2c43161a512d91bfb38310ec3bf9`，`260,631,118` bytes，运行用户 `10001:10001` |
| API 与 SDK | `implemented_controlled` | `POST/GET/PATCH/DELETE /api/ivekit/media/ingresses` 和 SDK 完整生命周期；角色、tenant room、provider-authority 状态、创建幂等冲突、公开 DTO 去除内部 ownership；URL pull 默认 HTTPS、显式 host allowlist、拒绝 URL 凭据与私网 IP literal |
| Kubernetes worker | `implemented_not_deployed` | digest-only stateless Deployment；RTMP/WHIP/UDP 独立端口；availability/health/metrics；`maxSurge=0` 避免 hostNetwork 端口冲突；hostname anti-affinity、zone spread、PDB、NetworkPolicy、non-root、read-only root 和 bounded `/tmp`。Helm v3.18.4 render/lint 在服务器通过，未在目标集群 apply |
| 供应链 workflow | `implemented_not_run` | `.github/workflows/ivekit-livekit-ingress-image.yml` 构建 amd64/arm64 并向统一 OCI gate 交接 manifest digest；Actionlint 通过。GitHub Runner、GHCR、Trivy、SBOM、Cosign 和 provenance 未执行 |

服务器隔离、不可变输入、镜像身份和完整 `not_run` 清单见
`docs/evidence/wave2-livekit-ingress-v1.5.0-validation-2026-07-23.md`。真实 RTMP/WHIP/URL 媒体、
转码、simulcast、Redis 中断恢复、滚动排空、DNS rebinding 防护、目标集群受控出站、多 Zone 故障与
worker frontier/Cell-10K 仍为 `not_run`；`capacity_claim=none`。

## 28. Wave 2 可观测性、异步弹性与指标存储收口（2026-07-23）

本节完成 OpenTelemetry、KEDA、worker backlog 和 VictoriaMetrics 代码闭环。它们全部位于通信热路径之外：Prometheus 继续负责指标定义、抓取、规则和告警；OpenTelemetry 只处理低频控制面 traces；VictoriaMetrics 只承担 Prometheus-compatible 长期存储；KEDA 只调整明确允许的离线 worker，不扩缩 SIP、RTP、SFU、Tinode 扇出或 RustDesk relay。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| Backlog 与 worker 弹性 | `implemented_controlled` | migration 096 以固定 `search_path` 的只读聚合函数提供六类 depth/oldest-age；API 低频 observer 输出低基数指标。Notification 已从 ordinal StatefulSet 改为 PostgreSQL lease、`SKIP LOCKED` 和 fencing 保障的竞争消费者 Deployment；Webhook、附件、质检、翻译、文件安全各自是独立 Deployment/PDB |
| KEDA | `implemented_not_deployed` | 六类 allowlist ScaledObject 同时观察 depth 与 oldest-age，具有有界 min/max/fallback、快扩慢缩、cooldown/stabilization，并要求 AI、observability Profile 与非空 Prometheus 地址。服务器 Helm v3.18.4 的正向渲染和缺地址负向门禁通过；目标 CRD/operator 和真实 backlog 扩缩仍未运行 |
| OpenTelemetry | `passed_controlled_server` | Node SDK 固定八个精确依赖，只自动采集 HTTP、PG parent span 和 Undici；NATS 只传播合法 `traceparent`/`tracestate`，不传播 baggage。Collector `0.153.0@sha256:93aad750...` 为 trace-only、双副本、隐私过滤、有界 queue/retry。受控服务器首次投递成功，Collector 停止时业务 canary 继续且 exporter 在有界时间 fail-open，恢复后再次投递；LED 七容器不变。机器证据：`docs/evidence/wave2-opentelemetry-runtime-2026-07-22.json` |
| VictoriaMetrics | `passed_controlled_server` | 最新社区版 `v1.148.0@sha256:407013e...` vmsingle、200 GiB/30-day 起始 Profile、label/query 边界、NetworkPolicy、PDB、默认暂停的 vmbackup CronJob和显式 restore 示例。真实 Prometheus `v3.12.0` remote-write 后停库，指标源与 Prometheus 保持运行，vmsingle 恢复后 WAL 补发；随后社区 vmbackup 生成备份，清空临时数据盘并由 vmrestore 恢复查询。vmsingle/vmbackup/vmrestore 均在 UID 1000、只读根文件系统、无 capability、禁止提权条件下通过；机器证据：`docs/evidence/wave2-victoria-metrics-runtime-2026-07-22.json` |

仍为 `not_run`：目标 Kubernetes 与 KEDA/Prometheus Operator 版本、真实 trace backend、生产 S3 备份、StorageClass IOPS/扩容/节点丢失、双 Zone、真实通信会话期间 Collector/metrics 故障、长期 retention、worker 毒消息与长稳、吞吐和成本曲线。受控服务器结果不产生 Cell-10K/MIX-100K 容量结论，`capacity_claim=none`。

## 29. Wave 3 LiveKit/RustPBX 实时智能音频旁路（2026-07-23）

本节把外部实时 ASR/翻译从“只有 Provider 接口”推进到真实媒体源可接入的统一旁路。RustPBX 解码后
PCM 和 LiveKit Agents `AudioStream` 都进入同一 `PolicyRealtimeSpeechRouter`；third-party 与
self-hosted Provider 继续接受配额、熔断、健康、降级和租户 policy 治理。旁路不改变 LiveKit SFU、
RustPBX RTP 或 AI Agent 主会话的所有权。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| RustPBX/LiveKit 双输入 | `implemented_controlled_server` | RustPBX 本地 Unix socket 与 LiveKit 内部 WebSocket 双 gateway；固定 PCM16LE/16 kHz/LAT1；双 gateway 共享统一 router/projection，但各自有连接、payload、启动、空闲和 shutdown 上限。Kubernetes 中 RustPBX Pod 同置专用 gateway sidecar 并共享 memory `emptyDir`，API Pod 只运行 LiveKit gateway；Compose 共享私有 named volume |
| 主媒体故障隔离 | `implemented_controlled_server` | LiveKit 每 track capture 与发送任务分离，队列满丢最老旁路帧；RustPBX patch 使用有界非阻塞 capture；Provider/数据库/对象存储/NATS 不在媒体回调热路径。单元测试证明慢 Provider 不反压 gateway，但真实 RTP/WebRTC 连续性故障注入仍未运行 |
| 授权与多副本防重放 | `implemented_controlled_server` | host 创建 consent-scoped grant；system worker 只能为 active call participant/track 申请短期一次性 token；Kubernetes HMAC 按 Pod name 派生并返回签发 Pod headless DNS，同 Pod nonce 拒绝重放，3010 只允许 AI Agent selector |
| 运行与 Provider 接线 | `implemented_controlled_server` | AI Agent room metadata 显式 opt-in；旁路启动失败只告警并继续主 session；断线每次申请新 token并有界重连；实时事件进入受 retention 约束的 PostgreSQL/LED projection |
| 指标、告警与大盘 | `implemented_controlled_server` | `opc_ivekit_voice_audio_tap_events_total`、`...dropped_seconds_total` 仅用低基数标签；Failure、DroppingAudio、ReplayAttempt 三条规则和两张 Grafana 图；运维手册给出不重启主媒体的处置边界 |
| 部署合同 | `passed_controlled_server` | standalone core 默认关闭、AI profile 显式启用；standalone/full-platform Helm lint/template、LiveKit Pod 直连 headless Service、AI Agent-only NetworkPolicy；RustPBX Pod 内专用 gateway sidecar 与 memory `emptyDir` UDS；两份 Compose 共享私有 UDS 卷且不向宿主机发布 3010 |
| 自动化回归 | `passed_controlled_server` | 原始音频专项 `25/25`，最终音频/监控/部署/renderer/source-graph 合并集 `65/65`，`tsc --noEmit`，Python compileall 与专项 `8/8`。完整命令和不可变工具输入见 `docs/evidence/wave3-realtime-audio-tap-server-validation-2026-07-23.md` |

仍为 `not_run`：真实 LiveKit/RustPBX 媒体、真实外部流式 ASR/翻译、真实 Provider 的
故障/429/高首包延迟、弱网、API Pod/AI Agent/3010 故障注入、P50/P95/P99、单机连接密度和
Cell-10K/MIX-100K。受控 loopback Provider 故障矩阵已由第 32 节补齐，但不能替代上述真实环境
证据；`capacity_claim=none`。

## 30. Wave 3 AI Agent 分段语音延迟闭环（2026-07-23）

本节在第 29 节实时 PCM 旁路之上补齐 ASR/LLM/TTS 分段延迟的可观测和验收门槛。Provider 仍可在
third-party 与 self-hosted 之间切换；指标来自统一 LiveKit turn，而不是绑定某个厂商 adapter，
所以切换 Provider 不改变标签、告警或 LED 对接契约。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 五段延迟 | `implemented_controlled_server` | 从 LiveKit Agents `1.6.6` committed `ChatMessage.metrics` 提取 ASR final、end-of-turn、LLM TTFT、TTS TTFB 和 speech-to-speech；拒绝 NaN、负值和超界值，仅保留固定 stage/media source 标签 |
| 热路径隔离 | `implemented_controlled_server` | job 子进程使用 loopback-only 非阻塞 UDP；每报文最多 4 KiB、最多五条观测，父进程更新普通 Prometheus Registry。collector/发送/抓取失败只丢监控样本，不回压媒体或 Provider；已移除会随 job 累积文件的 Prometheus multiprocess mmap 目录 |
| 预算与告警 | `implemented_controlled_server` | 默认 P95 预算为 ASR `350 ms`、end-of-turn `500 ms`、LLM `350 ms`、TTS `300 ms`、端到端 `1.2 s`；Compose 抓取 `ai-agent:9090`，Helm 提供 Service、ServiceMonitor 和五条 stage 规则 |
| 镜像安全 | `passed_controlled_server` | 首次服务器镜像检查发现 root runtime 并拒绝验收；Dockerfile 改为固定 `10001:10001`，Helm 强制 non-root、RuntimeDefault seccomp、只读根、禁提权、drop capabilities 和 256 MiB memory `/tmp`。严格容器运行身份及全量测试通过 |
| 自动化回归 | `passed_controlled_server` | AI Agent Python 全量 `54/54`；Node 部署契约 `3/3`；`tsc --noEmit`；两份 Compose、Helm、Prometheus config 与 9 条规则真实解析；镜像 ID、命令和边界见 `docs/evidence/wave3-ai-voice-latency-server-validation-2026-07-23.md` |

仍为 `not_run`：真实第三方/自建 ASR、LLM、TTS，真实 SIP/RustPBX/LiveKit 媒体，真实
P50/P95/P99、429/超时/断流/failover、弱网、长稳、单机 frontier、Cell-10K 和 MIX-100K。
当前预算是验收门槛，不是服务器已经达到的性能数字；`capacity_claim=none`。

## 31. Wave 3 AI Agent Provider 故障切换闭环（2026-07-23）

本节在第 30 节分段延迟之上补齐独立 STT-LLM-TTS pipeline 的运行时故障切换。它只改变 AI
Agent 的 Provider 选择和失败语义，不把外部请求、Prometheus、数据库、对象存储或 NATS 放入
LiveKit/RustPBX 媒体包热路径。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| Provider 链 | `implemented_controlled_server` | LiveKit Agents `1.6.6` 官方 STT/LLM/TTS `FallbackAdapter`；显式、去重、最多四候选；未配置 URL/key 的候选自动排除，无候选时 fail closed |
| 实时失败语义 | `implemented_controlled_server` | 默认 STT/LLM/TTS 单次上限 `2000/1200/1500 ms`，候选内部重试为 0；LLM 已输出 token、TTS 已输出音频后禁止跨 Provider 重放；CosyVoice 继承 session TTS 上限而非独立等待 60 秒 |
| 监控与告警 | `implemented_controlled_server` | `opc_ai_voice_provider_transitions_total{capability,provider,state}` 仅使用固定低基数标签，经 loopback 非阻塞 UDP 汇聚；Compose 与 Helm 均新增 Provider unavailable 规则 |
| 部署与凭据 | `passed_controlled_server` | 两份 Compose 接线主/后备 Provider、超时和错误阈值；Helm 在不可变 digest 和生产必填值门禁下渲染成功，API key 只从 `aiAgent.providers.credentials.existingSecret` 引用 |
| 自动化回归 | `passed_controlled_server` | AI Agent Python `63/63`；Node 部署合同 `4/4`；`tsc --noEmit`；两份 Compose、Helm、Prometheus config 与 10 条规则真实解析；严格候选镜像和命令见 `docs/evidence/wave3-ai-voice-provider-fallback-server-validation-2026-07-23.md` |

仍为 `not_run`：真实第三方/自建 ASR、LLM、TTS，429/超时/断流/区域故障注入，真实
SIP/RustPBX/LiveKit 音频中的切换和重复内容检查，多副本 Secret 轮换、P50/P95/P99、长稳、单机
frontier、Cell-10K 和 MIX-100K。当前只能声明代码和受控服务器部署合同成立；
`capacity_claim=none`。

## 32. Wave 3 实时语音 Provider 故障矩阵（2026-07-23）

本节补齐第 29 节实时 ASR/翻译链路缺少的可重复故障矩阵。验收运行于
`64.225.122.227` loopback，直接使用正式 WSS adapter、正式策略路由和
`IntelligenceProviderGovernanceStore`；受控 Provider 只产生确定性协议响应，不作为真实供应商。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 错误分类 | `passed_controlled_server` | 429、5xx、终态输入拒绝、认证失败、协议错误和启动超时分别保留为 `provider_rate_limited`、`provider_transient_failure`、`provider_rejected`、`provider_auth_failed`、`protocol_mismatch` 和 `provider_timeout`；Provider 原始 message 不进入应用错误或报告 |
| 音频与背压 | `passed_controlled_server` | 成功路径传输真实二进制 `IVAF` PCM envelope 并收到 normalized final event；100 ms 有界队列第六个 20 ms 帧返回 `dropped_overflow`，不等待 socket I/O |
| 路由边界 | `passed_controlled_server` | retryable 5xx 只在启动阶段切到第二 profile；终态错误不切换；已建立 primary 断开只发 `provider.degraded` 并关闭后续写入，未启动 fallback |
| 自动化回归 | `passed_controlled_server` | 独立验收报告 11/11 checks passed；实时语音、LiveKit/RustPBX audio tap、投影和部署相关 Node 回归 `51/51`；`tsc --noEmit` 退出码 `0` |
| LED 隔离 | `passed_controlled_server` | 验收后仅有 7 个既有 LED 容器运行，无 OPC/Provider 验证容器遗留 |

命令为 `npm run ivekit:realtime-speech-provider-acceptance`，报告固定声明
`verification_scope=controlled_loopback_realtime_provider` 和 `real_vendor_evidence=false`。
完整时间、文件 hash、命令结果和未运行边界见
`docs/evidence/wave3-realtime-provider-failure-matrix-server-validation-2026-07-23.md`。

仍为 `not_run`：真实 WSS Provider 与凭据、真实 RustPBX RTP/LiveKit track、网络 loss/jitter、
Provider 区域故障、CloudNativePG 主备和 gateway Pod 滚动、字幕客户端、真实 P50/P95/P99、长稳、单机
frontier、Cell-10K 和 MIX-100K。`capacity_claim=none`。

## 33. Wave 3 实时旁路恢复与投影隔离（2026-07-23）

本节关闭第 32 节之后可在受控服务器完成的两个代码缺口：LiveKit audio tap 的重连预算此前不会在
成功恢复后重置，且初次启动不等待短暂 gateway 重启；Provider event 到 PostgreSQL projection
此前是无界 fire-and-forget Promise，在数据库短停时可能持续积累。修复不改变主媒体所有权，也不把
数据库、Provider 或监控引入 RTP/WebRTC 热路径。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| LiveKit transport 恢复 | `passed_controlled_server` | 初连与断线统一最多 8 次有界重试，成功后重置预算；服务器真实 loopback WebSocket 监听器关闭后在同一端口重启，客户端重新授权并送达当前 PCM 帧。第 34 节进一步完成实际 Node gateway 子进程重启；仍不是生产 Pod rolling 或真实 LiveKit track 证据 |
| PostgreSQL 投影隔离 | `passed_controlled_server` | gateway 回调只执行同步 `offer`；默认队列 4096，最多 100000，另有 1 个 in-flight；final 使用 100/250/500/1000/2000 ms 重试并优先于已排队 partial，partial 失败不重试，shutdown 默认 1000 ms。第 34 节进一步完成实际 PostgreSQL 容器进程停启 |
| 部署合同 | `passed_controlled_server` | 两份 Compose 暴露同名参数；standalone/full-platform Helm values、API Pod 和 RustPBX gateway sidecar 保持一致，并对队列 `1..100000`、shutdown `10..30000 ms` fail closed。两份 Compose、两套 Helm lint/template 在服务器通过 |
| 自动化回归 | `passed_controlled_server` | 实时链路 Node `73/73`；AI Agent Python `67/67`，其中 transport 专项 `8/8`；`tsc --noEmit` 与 `git diff --check` 通过。完整命令、hash 和环境见 `docs/evidence/wave3-realtime-audio-tap-recovery-server-validation-2026-07-23.md` |

仍为 `not_run`：CloudNativePG 主备切换、gateway Kubernetes Pod 滚动和多副本 draining、
真实 LiveKit/RustPBX 媒体连续性、真实外部 Provider、弱网、字幕客户端、长稳、P50/P95/P99、单机
frontier、Cell-10K 和 MIX-100K。受控故障测试不产生容量或生产可用性结论；
`capacity_claim=none`。

## 34. Wave 3 实时旁路实际进程恢复（2026-07-23）

本节把第 33 节的 dependency/listener 故障注入提升为隔离服务器上的实际进程故障，同时不扩大
证据边界。验收入口为 `npm run ivekit:realtime-recovery-acceptance`，所有 PostgreSQL 容器、
网络、卷、Node gateway 子进程和 Python transport 容器均使用唯一运行身份并在退出时清理。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| PostgreSQL 实际进程恢复 | `passed_controlled_server` | 建立生产 `initPostgres` pool 后停止实际 PostgreSQL 16 容器；final 投影观察到 3 次重试，恢复后成功，`persisted_rows=1`。停库首次暴露的空闲连接 `error(57P01)` 未监听问题已修复；runtime/migration pool 只记录低敏错误码，同步和异步 reporter 故障均被隔离，失效连接由 `pg` 丢弃 |
| Node gateway 实际进程恢复 | `passed_controlled_server` | Python transport 先向 PID `3764056` 送达序号 1，终止 gateway 后重新授权，向 PID `3764266` 送达序号 2；授权共尝试 4 次。容器以 `/workspace` 为首个 import path，并校验模块路径和源码 SHA-256 |
| 验收隔离 | `passed_controlled_server` | PostgreSQL 只发布到 loopback；transport 使用不含 PostgreSQL/LED 的专属 internal bridge 访问授权 HTTP 和 WebSocket，不使用 host 网络；宿主状态、只读事件/控制和 transport 可写输出分离；Python UID/GID 10001、只读根、drop all capabilities、禁止提权；固定 PostgreSQL 端口有 3 次有界绑定重试；所有等待硬有界；成功和注入失败后均无验收容器/网络/卷残留；LED 七容器 ID、启动时间不变且全部 healthy |
| 自动化回归 | `passed_controlled_server` | 恢复合同 `5/5`、Pool error `3/3`、相关 Node `78/78`、AI Agent Python 当前源码 `67/67`、`tsc --noEmit`、`sh -n` 和 `git diff --check` 通过 |

机器证据与源码哈希见
`docs/evidence/wave3-realtime-process-recovery-server-validation-2026-07-23.md` 和
`docs/evidence/wave3-realtime-process-recovery-2026-07-23.json`。报告固定声明
`verification_scope=controlled_server_process_recovery`、
`real_media_continuity_evidence=false`、`real_vendor_evidence=false` 和
`capacity_claim=none`。

仍为 `not_run`：真实 LiveKit subscribed track、RustPBX RTP、电话/视频主媒体连续性、
CloudNativePG 主备、gateway Kubernetes Pod rolling、多副本路由/draining、真实 Provider、
弱网、跨地域、字幕客户端、P50/P95/P99、长稳、单机 frontier、1/2/4/8 扩展效率、
Cell-10K 和 MIX-100K。

## 35. Wave 3 Tinode 真实协议容量采集器（2026-07-23）

本节开始关闭第 8 个 Wave 3 任务中的真实端点采集缺口，但不把低负载协议回归升级为容量结论。
新的 worker 使用实际 Tinode WebSocket、实际自编译 Tinode 进程和 PostgreSQL，不通过 mock
协议填充 finalizer。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 消息采集器 | `passed_controlled_server` | 20/20 publish ACK 与 delivery；持久丢失、重复和最终业务乱序均为 0；send-to-ACK P95/P99 为 `6.293/7.885 ms`，send-to-delivery P95/P99 为 `6.250/7.837 ms` |
| 离线恢复 | `passed_controlled_server` | marker + `since` cursor 恢复 5/5，P99 `79.027 ms`；Tinode 倒序历史回放在线上产生 4 次 regression，但 provider sequence 精确匹配并重建为 0 次业务乱序；wire 与 converged order 分别记录 |
| 长连接采集器 | `passed_controlled_server` | 2/2 socket 同时活跃并正常关闭；真实执行 10 次 presence get 与 10 次 typing note；协议错误 0 |
| Worker 与凭据 | `implemented_controlled_server` | 通用 `CapacityStartShardCommand`；interaction/connection 双 domain；有界并发与超时；`0600` credential bundle；所有 worker 使用同一不可变 binding table，按 `run_id + phase_id + shard_id` 精确选取 bundle 并核验 SHA-256；测试覆盖两个非零全局序号分片和错误 hash fail closed；证据不包含 API key/token/password；SHA-pinned `0755` 外部入口和 capacity 镜像打包已接线 |
| 回归与隔离 | `passed_controlled_server` | focused `9/9`、capacity TypeScript 和相关 diff gate 通过；Tinode 只读根、drop all capabilities、禁止提权；临时容器/网络/凭据残留 0；LED 七容器全部 healthy |
| 复合负载模型 | `implemented_controlled_server` | 审计确认 Profile 的设备连接是承载活跃会话的总连接池，不能把 `tinode_im` 再实现成额外 socket。新增 composite generator/runner/provisioner，一条坐席连接可订阅 3 个主题，额外设备复用同一坐席身份；provisioner 可按分片生成非零 connection/interaction 全局 ordinal，账号身份以全局 connection ordinal 派生，同一 campaign namespace 连续预置两个分片无冲突。协议测试证明 N 条连接承载 M 个会话时服务端只接收 N 条 WebSocket。限速器按客户端实际启动时间发放令牌，事件循环迟滞只延长 ramp，不再追赶形成尖峰，并记录 connection/interaction start window |
| 复合调度与证据 | `implemented_controlled_server` | Profile compiler 以 `tinode_websocket` 为物理分片并用 `covered_workloads` 按比例覆盖一个连续 `tinode_im` 逻辑负载，Cell-10K 不再产生 6000 条额外 socket；migration 100 保存复合关系，租约、outbox 与 `CapacityStartShardCommand` 原样传递；正式 Tinode worker 调用 composite runner，在同一连接池执行 IM 并输出连接/交互双维度证据；finalizer 以 phase + physical shard + workload dimension 分别核对。服务器容量回归 `191/191`（另 1 项真实 PostgreSQL 环境门禁默认跳过），capacity TypeScript 通过；临时 PostgreSQL 16 实测历史 migration 077→升级 082→新增 100，创建、分配、命令、证据与完成屏障 `1/1` 通过 |
| 受控单机阶梯 | `passed_controlled_server_current_source_to_1000` | 当前严格 composite generator、runner、provisioner 和验收器 SHA-256 已记录；ramp 为 100 connections/s、33 interactions/s，连接保持 10 秒。100/250/500/1000 四点全部通过 start-window 门禁并由客户端与 Tinode expvar 对账。1000 点 1000/1000 attempted/accepted/active/closed、666/666 interactions、1332/1332 delivery，建连 P95/P99 `6.342/9.603 ms`，delivery P95/P99 `3.728/5.689 ms`，Tinode 峰值 CPU `29.85%`、内存 `92,620,718.08 bytes`，零丢失、重复、乱序、协议和采样错误；凭据、容器和网络残留为 0，LED 七容器 ID/健康状态不变。该点是配置上限，不是失败 frontier 或生产容量结论 |

机器证据与实现说明见
`docs/evidence/wave3-tinode-capacity-collector-2026-07-23.json` 和
`docs/evidence/wave3-tinode-capacity-collector-server-validation-2026-07-23.md`。报告固定声明
`verification_scope=controlled_server_tinode_protocol`、
`observation_scope=client_only`、`production_capacity_evidence=false` 和
`capacity_claim=none`。

阶梯机器证据见
`docs/evidence/wave3-tinode-composite-frontier-2026-07-23.json`（历史限速器）和
`docs/evidence/wave3-tinode-composite-strict-staircase-2026-07-23.json`（当前严格限速器）。
当前证据绑定自编译 Tinode/PostgreSQL 镜像、服务器硬件、五个执行源码 SHA-256、四个点的
结果 SHA-256、逐时资源样本和 Tinode `LiveSessions`。凭据与输入文件均已删除，临时
容器/网络残留为 0，LED 七容器保持 healthy。完整服务器容量回归为 `191/191`，另 1 项真实
PostgreSQL 环境门禁默认跳过；capacity TypeScript 通过。

仍为 `not_run`：实际分布式 campaign 的逐分片 composite credential 真实预置与执行、
Tinode 超过 1000 的失败 frontier、独立生成器见证、
慢消费者/重连风暴/长稳、三节点故障切换，
LiveKit 真实媒体采集，SIP/RTP 质量采集，RustDesk 双 Windows，弱网/跨地域，完整资源与
成本曲线、1/2/4/8 扩展效率、Cell-10K 和 MIX-100K。manifest/finalizer 已不再重复连接，
但现有阶梯仍缺独立见证和完整 campaign，因此不得直接升级为生产容量结论，
`capacity_claim` 继续为 `none`。

## 36. Wave 3 LiveKit 首媒体与弱网恢复测量闭环（2026-07-24）

本节修正浏览器采集器对首视频和首音频的测量干扰，并把验证过的 PLI、连接准备和接收端缓冲策略
提升为显式部署/容量合同。它不启动新的容量压测，也不把单房间弱网结果解释成单机或 Cell 容量。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 首媒体定义 | `implemented_controlled_server` | first video 在第一个 `requestVideoFrameCallback` 记录，不再等待 visual marker；marker 只负责 glass-to-glass。playout audio probe 在 video decoder 前启动。schema `1.7.0` 记录 primary publish、remote tracks ready、ready 后首音频和首渲染视频四个阶段尾延迟 |
| 启动模式与接收策略 | `implemented_contract` | plan 显式绑定 `connection_preparation_mode=cold\|signal_prewarmed`、`receiver_jitter_buffer_target_ms` 和 subscriber quality；默认容量基线为 cold、`0`（浏览器控制）和 auto。prewarmed/非零 buffer 只能作为独立命名 profile，不能替代 cold baseline |
| PLI 部署配置 | `implemented_controlled_server` | renderer、standalone edge 与 bundled-dev Kubernetes 均写 `rtc.pli_throttle`；iveKit profile 为 low/mid/high `100/100/100 ms`，每项限制 `50..5000 ms`，独立机 `deployment-summary.json` 保留实际值。lower throttle 的 keyframe/egress 代价必须和 NACK/PLI、freeze、G2G 一起验收 |
| loss+jitter 修正复测 | `passed_controlled_server_profile` | 1 房间/2 浏览器、60 秒、双向 `3 Mbps`、`120 ms` RTT、`40 ms` jitter、`5%` loss；signal prewarm、receiver buffer `400 ms`、PLI `100/100/100 ms`。join P99 `1508.4 ms`、首音频 P99 `2093.6 ms`、首渲染视频 P99 `2343.5 ms`、G2G P95/P99 `656.8/791.3 ms`、freeze `4.205%`/`7.999 per minute`、接收 FPS `29.946`，manifest-bound 结果 `controlled_pass` |
| 启动/缓冲四格校准 | `completed_controlled_server_matrix` | LED 停服后以相同弱网 profile 各跑 1 次 cold/0、cold/400、prewarmed/0、prewarmed/400。只有 prewarmed/400 `controlled_pass`；prewarmed/0 freeze `41.11%`，证明预热不能替代接收缓冲；cold/400 只剩 G2G P99 `1355.7 ms` 超过 1200 ms。单次校准不构成重复性或生产默认结论 |
| 浏览器小房间边界 | `blocked_by_same_host_generator` | 1 房间生成器/整机 CPU P95 `44.95/47.10%`；2 房间达到 `84.81/86.58%` 并触发 generator/host `60/85%` 资格线，尽管 4/4 tracks、0 loss、0 freeze。按门禁停止 4/6 房间；必须使用独立浏览器生成器 |
| 原生 SFU track 边界 | `passed_controlled_server_to_90` | workload-bound `lk` 在 90 tracks 得到 90/90、26.0 Mbit/s、0 loss/error，生成器/LiveKit/整机 CPU P95 `30.53/12.44/62.63%`，`controlled_pass`；160 tracks 得到 160/160、48.7 Mbit/s、0 loss/error，但整机 P95 `90%`，结果 `invalid_generator_capacity`，故未跑 250 tracks |
| 官方 Helm 生产 Profile | `implemented_server_rendered` | 精确 vendored `livekit/livekit-helm@8f0ad0809c2be8cbed375a6f8bef10625e5e8a2b`，iveKit delta 只增加 Valkey 密码/TLS Secret、双 Zone spread 和 PDB；生产 Profile 强制 manifest digest、host network、8 CPU request、无 CPU limit、2→32 HPA、10001 RTC UDP ports、100/100/100 ms PLI、API/Valkey/TURN 外部 Secret。服务器使用 checksum-pinned Helm `v4.2.1` 完成 validator、lint、template 和 8 个对象结构门禁；fixture digest 仅用于静态渲染，未部署 Kubernetes |
| 证据与回归 | `passed_controlled_server` | 新证据 `wave3-livekit-network-loss-jitter-first-frame-controlled-pass-2026-07-24.json` SHA-256 `0398f6e128ec3d9c9ef0458a3abfdc69360059dac4d8e48400b0f40b2ceb5912`；本机和服务器相同 RTC/renderer/Compose/Helm 契约集均 `102/102`；服务器完整 `tsc --noEmit` 退出码 0 |

当前仍为 `not_run`：四格矩阵多次重复、独立 generator/SUT、浏览器正式并发阶梯、LiveKit
单机失败 frontier、1/2/4/8 扩展曲线、外部 TURN/TLS、handoff、cross-region、长稳、
Cell-10K、MIX-100K，以及官方 Chart 在目标 Kubernetes 的 install/upgrade/rollback、真实
双 Zone 调度、扩缩和节点故障。LED 服务已经停止并完成本节受控阶梯，但生成器和 SUT 仍共享
同一 4-vCPU Linux boot domain；90 tracks 只能作为本机受控合格点，160 tracks 不能升级为
容量点。所有新增证据均保持 `capacity_claim=none`。

## 37. Wave 3 Kamailio/RustPBX 持续信令边界与 503 隔离（2026-07-24）

本节在 LED 服务停服后，以同一组不可变镜像运行
`SIPp -> Kamailio -> RustPBX -> authenticated Router -> PostgreSQL CDR` 的 60 秒持续阶梯。
场景以 486 结束且不携带 RTP；因此只验证 SIP 控制面，不代表媒体、录音、转码或完整 PBX 容量。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 1,200 CPS 故障定位 | `fixed_controlled_server` | 首轮 1,200 CPS 中一次 RustPBX Router send failure 返回 503；Kamailio 将 503 当作硬节点故障，三次快速响应跨过 probing threshold 并摘除唯一目的地，放大为 3,999 个失败。72,000 INVITE 全部到达 Kamailio，排除生成器和网络丢失 |
| 软/硬失败分类 | `implemented_tested_server` | INVITE/REGISTER 的 503 改为 soft rejection：只尝试下一个目的地，不修改节点健康；无备选时返回带 `Retry-After` 的有界 503。408/500/502/504 继续标记硬故障并主动探测。先红后绿的 focused 回归 `14/14` |
| 修正后持续阶梯 | `passed_controlled_server_to_1250` | 1,000 CPS 为 60,000/60,000，P95/P99 `15/44.001 ms`；1,200 CPS 为 72,000/72,000，P95/P99 `20/51.001 ms`；均零失败、零剩余、零重传。1,250 CPS 为 75,000/75,000，P95/P99 `29/90.002 ms`，是当前同机最高合格点 |
| 同机失败边界 | `blocked_by_same_host_generator` | 1,300 CPS 的 78,000 INVITE 全部到达 Kamailio，77,862 在硬时限内完成、138 未收口、171 重传，P95/P99 `1758.03/7624.13 ms`；宿主 CPU P95 `98%`。1,400 CPS 同样表现为整机饱和和尾延迟累积，没有再次出现 503 摘除放大 |
| 容量解释 | `capacity_claim_none` | SIPp、Kamailio、RustPBX、Router、PostgreSQL 共用 4 vCPU，合格点宿主 CPU P95 已为 `92%`。1,250 CPS 是该共享主机/486 无媒体场景的受控稳定线，不是 RustPBX 单组件上限，也不能直接宣称优于 FreeSWITCH/Asterisk |

机器证据为 `wave3-sip-kamailio-frontier-led-off-2026-07-24.json`、
`wave3-sip-kamailio-frontier-soft503-fix-led-off-2026-07-24.json` 和
`wave3-sip-kamailio-frontier-refine-soft503-fix-led-off-2026-07-24.json`，SHA-256 分别为
`ff2a01b0e940802b5e76f086a70b8e5a3f2108bb3c58b7b5c6d8e54b54c9ac0b`、
`d62a56ab5491c8f6722bb000eb531302b35c4d444a41a732a6725f6b957b7fed` 和
`ecdb0866029422bc4dc91be5b0c4566961102649c4ea83a7812183c7d4634089`。
真实 RustPBX 上限仍需独立 generator/SUT；同硬件同场景 FreeSWITCH/Asterisk A/B、G.711/SRTP、
录音、转码、IVR、会议、长稳、过载恢复和 1/2/4 节点边际效率保持 `not_run`。
`capacity_claim=none`。

## 38. Wave 3 RustPBX/rustrtc RTP socket 与媒体边界（2026-07-24）

本节不改变 SIP 信令第 37 节的结论。它新增固定 `rustrtc` 源码、RTP/RTCP socket 缓冲控制、
UDP 错误归因和真实 PCMU RTP 回归；SIPp UAC/UAS、Kamailio、RustPBX、Router 与 PostgreSQL
仍共享一台 4-vCPU/8-GB 服务器，所以所有结果保持 `capacity_claim=none`。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 固定源码与镜像 | `passed_controlled_server` | RustPBX `6c49ee76...`、rsipstack `8318e97b...`、rustrtc `166c6d2...`；固定 Rust 1.94.1 执行 `cargo build --locked --release` 通过，生成 `ivekit.19` 本地镜像 `sha256:da8407a...a288cb`，OCI 标签精确匹配三份提交和 patchset |
| UDP socket 合同 | `implemented_tested_server` | RTP 与直接 RTCP socket 使用 `socket2`；配置范围 64 KiB..16 MiB；Compose、两套 Helm 与基线接线。活动通话实测 1 MiB/512 KiB 请求对应 Linux `rb=2 MiB/tb=1 MiB`，默认 socket 仍为 212,992 bytes |
| 严格媒体序列 | `passed_controlled_server_to_10` | 10 路、20 秒 PCMU，SIP 双端 10/10、零重传；双向 durable loss、sequence gap、duplicate、reorder 均为 0。150 路为 UAC 149/150、UAS 150/150，生成器约 96% CPU，故 `invalid_generator_capacity`，不能写成通过 |
| RTP 吞吐合格线 | `passed_controlled_server_to_800` | 600/800 路均双端精确 SIP 对账、零失败、零重传、零 `RcvbufErrors/SndbufErrors/InErrors`。800 路 RustPBX 平均/峰值 CPU `150.881/204.58%`、最大内存 `441,869,926.4` bytes |
| 900 路边界 | `mixed_or_inconclusive` | 1-MiB 样本 UAC 900/900、UAS 878/900、117 重传、75 `RcvbufErrors`；生成器与 SUT/protocol 信号同时存在。2-MiB 诊断仍失败并出现 242 `RcvbufErrors`，不接受继续堆 buffer 作为扩容方案 |
| 与 ivekit.18 对照 | `no_regression_observed` | 相同 800 路受控样本旧版平均/峰值 CPU `151.502/218.86%`、约 444 MB；新版为 `150.881/204.58%`、约 442 MB。单次样本只证明未观察到回归，不构成统计性能提升 |

机器证据、SHA-256 与完整限制见
`docs/evidence/wave3-rustpbx-rtp-media-capacity-server-validation-2026-07-24.md`。仍为
`not_run`：独立 generator/SUT、物理 mouth-to-ear、PSTN、SRTP、转码、录音、IVR、会议、
长稳、过载恢复、rustrtc worker/socket sharding、1/2/4 节点扩展效率，以及同硬件同场景
FreeSWITCH/Asterisk A/B。当前证据只能说明 RustPBX 在既定 RTP 直通场景具有较好效率，
不能证明其综合性能已经优于 FreeSWITCH 或 Asterisk。

## 39. Wave 1 HOMER PostgreSQL/HEPv3 受控服务器闭环（2026-07-24）

本节把此前只有静态合同的 HOMER 11 PostgreSQL fork 推进到精确源码构建、真实 HEP 呼叫检索和
故障隔离。HOMER 始终是 Kamailio 的 fail-open 诊断副本，不进入 SIP/RTP admission、readiness
或同步事务确认。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 精确源码和镜像 | `passed_controlled_server` | HOMER `11.0.297@ac4e1ae7...` 接受 overlay 并通过 PostgreSQL catalog Go 测试；Go 1.26.5 编译出 Linux amd64 候选镜像 `sha256:fe0d45e...c893d`，inspect size `121,407,366` bytes，UID/GID `10001:10001`。三份基础镜像均由 manifest digest 固定，二进制内嵌完整 commit 并由 build script 复核 |
| PostgreSQL catalog | `passed_controlled_server` | PostgreSQL DuckLake catalog attach 成功并创建 28 张 metadata 表；Chart 继续强制 `catalogType=postgres` 和一 Cell 一个 writer。最终镜像不含 SQLite CLI 或 `sqlite_scanner` |
| HEP 完整呼叫 | `passed_controlled_server` | 真实 PCMU 呼叫按 Call-ID 检索到 14 条记录，覆盖 `INVITE -> 100 -> 180 -> 200 -> ACK -> BYE -> 200`；双 Kamailio 受控 trace 点的重复记录符合拓扑预期 |
| 排除规则 | `passed_controlled_server` | `include_options=false` 时，唯一 OPTIONS 收到 200、唯一 KDMQ 收到 403，二者在 HOMER 中均为 0 行 |
| Collector 故障隔离 | `passed_controlled_server` | HOMER 停止期间 5/5 UAC、5/5 UAS 成功，零失败和 SIP 重传；RTP coverage `99.36%`，durable loss、gap、duplicate、reorder 均为 0；恢复 collector 未重启呼叫基线 |
| PostgreSQL 故障隔离 | `passed_controlled_server` | PostgreSQL 停止期间 HOMER 保持运行，3/3 UAC、3/3 UAS 成功，零失败和 SIP 重传；RTP coverage `99.20%`，durable loss、gap、duplicate、reorder 均为 0 |
| PostgreSQL 恢复写入 | `passed_controlled_server` | PostgreSQL 恢复后无需重启 HOMER；新 INVITE 收到 100/486，按唯一 Call-ID 检索到 8 条新记录。最终候选镜像接管 catalog 后再次检索到 8 条新记录，关闭了源码 hash、镜像 ID 和运行时证据错位 |
| 运行时加固 | `passed_controlled_server` | 只读根文件系统、`/tmp/homer-core.pid`、非 root、restart count 0、OOM false；最终镜像没有 Node、npm、`package.json`、lockfile 或 `node_modules` |
| 供应链 | `partial_not_released` | 上游 lockfile 仍有 8 项构建期 npm 告警，运行镜像不包含相关包；共享 OCI gate 尚未执行，因此没有 Registry digest、最终漏洞门禁、SBOM、Cosign 或 provenance，`production_eligible=false` |

机器证据为
`docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.json`，研发说明为
`docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.md`。

第 40 节已经补齐同硬件 HEP A/B 和隔离 retention/compaction/删除，第 41 节补齐动态 high-water、
确定性采样和无需重启的 trace transition。其余仍为 `not_run`：HEP deliberate loss/持续限速、
生产数据量 retention 吞吐和长稳、目标 Kubernetes、
双 Zone、生产 PostgreSQL failover、独立 generator/SUT、Cell-10K、MIX-100K，以及多架构
Registry 发布和完整供应链门禁。`capacity_claim=none`。

## 40. Wave 1 HOMER HEP A/B 与维护闭环（2026-07-25）

本节继续关闭第 39 节在当前服务器可以执行的两个缺口：同机 HEP enabled/disabled A/B，以及
独立 PostgreSQL DuckLake catalog 的 retention、expiration、compaction、删除和幂等性。
HOMER 仍是 fail-open 旁路；所有结果都是共享四 vCPU 主机上的受控证据，不是生产容量结论。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| HEP 400 CPS | `passed_controlled_server` | enabled/disabled 各 2 次均为 8,000/8,000，零失败、remaining 和 retransmission；enabled 两次均精确写入 64,000/64,000 HEP rows。双重复中位 P95/P99 从 `6/9 ms` 变为 `10/15.001 ms`，本机可观察开销约 `+4/+6.001 ms` |
| HEP 700 CPS | `passed_controlled_server` | enabled/disabled 各 2 次均为 14,000/14,000，零失败、remaining 和 retransmission；enabled 两次均精确写入 112,000/112,000 HEP rows。共享主机已接近饱和，顺序方差较大，只接受完整性，不宣称时延改善 |
| HEP 900 CPS | `rejected_controlled_server` | 首个 enabled 样本 17,988/18,000、12 failed、624 retransmissions；第二个 enabled 样本虽为 18,000/18,000 且 144,000/144,000 rows，但 route P95/P99 `151.003/330.006 ms` 超过既有 `150/250 ms` 门槛。该点不合格 |
| HEP 运行决策 | `implemented_evidence_bound` | 400 CPS 可观察到 HEP edge 和 HOMER CPU 明显增加；700 CPS 共享主机方差已不可用于精确归因。本轮 A/B 当时要求补 HEP queue/drop/high-water 和无重启动态采样/关闭；第 41 节已经完成该代码与受控服务器闭环，独立 generator/SUT 后才能给 safe CPS |
| 维护 CLI 缺陷 | `fixed_controlled_server` | 首次探索发现 modular config 未把 threads/memory/temp directory 传入 CLI，fallback 又把 PostgreSQL DSN 当本地 path 并进入 warning。该探索证据被判无效并删除；`ivekit.2` 同时传播 tuning 并拒绝 postgres/postgresql/libpq DSN 派生 spill path |
| 精确镜像 | `passed_controlled_server` | `11.0.297-ivekit.2-ac4e1ae7` image ID `sha256:d062461...1e389`，size `121,408,787` bytes，UID/GID `10001:10001`；精确 upstream commit、DuckLake/CLI Go test、UI build、二进制 commit 和 DuckDB `1.5.4` 均已验证 |
| 隔离 retention | `passed_controlled_server` | 40 天前 HEP rows `200→0→0`，当前 rows `200→200→200`；30 天策略第一次和第二次幂等执行均完成 |
| 隔离 compaction | `passed_controlled_server` | snapshots `30→1→1`，catalog data files `2→1→1`，Parquet files `2→1→1` |
| 安全和清理 | `passed_controlled_server` | 证据生成前删除 env，按随机值与 DSN pattern 双重脱敏扫描；最终日志无 PostgreSQL URI、spill-path warning、error 或 warn；isolated container/network/volume/data 残留为 0，基线容器未连接、未重启 |
| 供应链 | `partial_not_released` | 新镜像仍是服务器本地 candidate；上游 frontend lockfile 本次报告 9 项构建期 advisory，Node/npm/package artifacts 不在运行镜像。Registry digest、最终 vulnerability policy、SBOM、Cosign 和 provenance 未运行 |

HEP A/B 机器证据和解释报告为
`docs/evidence/wave1-homer-hep-ab-server-validation-2026-07-25.json` 与
`docs/evidence/wave1-homer-hep-ab-server-validation-2026-07-25.md`；维护机器证据和解释报告为
`docs/evidence/wave1-homer-retention-compaction-server-validation-2026-07-25.json` 与
`docs/evidence/wave1-homer-retention-compaction-server-validation-2026-07-25.md`。两组证据均
绑定执行源码 SHA-256，固定 `capacity_claim=none` 且
`production_capacity_evidence=false`。

第 41 节已补齐 queue/CPU/packet/gap high-water、动态 trace transition 和无重启恢复。仍为
`not_run`：HEP deliberate loss、持续限速、长稳和生产数据量维护吞吐，独立 generator/SUT，
目标 Kubernetes/双 Zone/node loss，生产 PostgreSQL
HA failover，Cell-10K/MIX-100K，以及多架构 Registry、SBOM、签名和 provenance。

## 41. Wave 1 HOMER HEP 动态高水位闭环（2026-07-25）

本节关闭第 39、40 节留下的 HEP 高水位、确定性采样、动态关闭和无重启恢复代码缺口。它只证明
观测旁路保护机制，不改变第 37、38 节关于 RustPBX 信令和 RTP 容量的边界。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 高水位控制器 | `implemented_tested_server` | route-agent 抓取 HOMER queue ratio、CPU cores、HEP packet rate 和 receive/process gap；严重度上升立即 full→sampled→off，恢复按连续健康样本逐级执行；导数预热禁止恢复；collector 连续失败先 sampled 后 off；RPC 失败保持目标状态并重试；并发 poll 单飞。Kamailio 重启初始 `off/0`；route-agent 单独重启也从 `off` 启动并在导数预热期间保持保护模式；revision reset、部分 RPC 写入和已提交但响应丢失均有恢复覆盖，desired/applied/pending/observation-valid 分离暴露 |
| 确定性采样 | `passed_controlled_server` | 10% 编译为稳定 `102/1024` Call-ID buckets；`core_hash(...,10)` 的 1..1024 返回边界使用 `<=102`；1,000/1,000 SIP 成功，实际采到 100 个 Call-ID、800 rows，采样率 10.0%；每个会话恒定 8 rows，未出现半条会话 |
| 完全关闭 | `passed_controlled_server` | mode `off/302` 下 200/200 SIP 成功、HEP 0 rows；观测旁路关闭没有改变预期 486 主路径 |
| 无重启恢复 | `passed_controlled_server` | full/304 为 200 calls/1,600 rows，sampled/301、off/302 后恢复 full/303，再次得到 200 calls/1,600 rows；Kamailio restart count 0、OOM false、最近日志无 product error |
| 部署与告警 | `implemented_server_rendered` | Helm/Compose/env 接入所有阈值和 HOMER metrics endpoint；source/target NetworkPolicy 同时允许 HEP UDP 与 metrics TCP；生产 Helm 在 trace 打开但 high-water 或 NetworkPolicy 关闭时拒绝渲染；Compose 同样拒绝 trace/high-water 任一单独启用；新增 collector unavailable、control failure、control pending、trace disabled 告警及 Grafana 状态面板 |
| 回归 | `passed_controlled_server` | 聚焦 Node 测试 63/63、根 `tsc --noEmit`、Helm 正向与两个 fail-closed 反例、Compose 双向 fail-closed、真实 Kamailio config check、真实 htable.get、route-agent restart 保守启动和 restart/replay 全部通过 |
| 容量解释 | `capacity_claim_none` | 运行场景是无 RTP 的 486 SIP 回归，用于证明模式切换和 HEP 对账；不构成 RustPBX、Kamailio、HOMER 或平台容量上限 |

机器证据和解释报告为
`docs/evidence/wave1-homer-hep-high-water-server-validation-2026-07-25.json` 与
`docs/evidence/wave1-homer-hep-high-water-server-validation-2026-07-25.md`。机器证据 SHA-256 为
`591b84dfb4fa56c08a4da57806579c87aedfb019d618924c35ba72e14536f53b`，并绑定源码、镜像、
渲染配置、场景与 SIPp 哈希。

仍为 `not_run`：HEP 高负载下主动 UDP 丢包注入、多小时 soak、生产数据量 retention 吞吐、
独立 generator/SUT、目标 Kubernetes 双 Zone/节点丢失/PostgreSQL HA、Cell-10K/MIX-100K，
以及 Registry 多架构发布、SBOM、签名和 provenance。`capacity_claim=none`。

## 42. Wave 3 RustPBX 录音存储 ENOSPC 与真实 RTP 隔离（2026-07-25）

本节关闭第 16、22、29、38 节一直保留的 RustPBX“真实 RTP 通话中录音盘写满”证据缺口。
验收使用独立 Compose 网络、16 MiB tmpfs spool、固定 SIPp 3.7.7、真实 PCMU 双向 RTP 和
新的 `ivekit.21` 精确源码镜像。它证明一次已建立呼叫的存储故障隔离和故障后录音恢复，不是
单机容量、生产 HA 或 PSTN 结论。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 精确镜像 | `passed_controlled_server` | RustPBX `6c49ee76...`、rsipstack `8318e97b...`、rustrtc `166c6d2...`；`cargo build --locked --release` 生成 `ivekit.21` 本地镜像 `sha256:b119f7a...db57dba`，大小 `71,065,985` bytes，OCI 标签精确匹配三份提交与 patchset |
| 合法 SIP 路由 | `fixed_tested_server` | 快照路由原来只接受裸 SIP URI，合法 `To: 显示名 <sip:+号码@host>` 被 404；`.21` 从 angle brackets 提取 URI，嵌入 Rust 测试绑定该报文，真实验收越过路由并建立媒体。公共 SIPp RTP plan 同时支持可选前导 `+`，仍拒绝 URI 注入 |
| Owner 合同 | `fixed_tested_server` | fixture 不再把带 `@` 的 provider Call-ID 冒充内部 interaction ID；改为 `vcall-*`，返回独立 `provider_call_id`，并使用 `cell_lease_epoch << 32 | local_epoch` 的 `4294967297`，真实 Rust guard open 通过 |
| ENOSPC 注入 | `passed_controlled_server` | 录音 spool 可用空间 `16,777,216→0` bytes，观察到 2 次显式 recorder write-failure marker；故障录音终态 `failed/local_spool_enospc`，且没有错误发布 completion |
| 主媒体连续性 | `passed_controlled_server` | 故障前 UAC 生成/接收 `11/9`、UAS `10/11`；盘满时推进到 `31/29`、`29/30`；writer 熔断后再次推进到 `49/46`、`48/48`。四向计数在两个故障阶段都严格增长，证明录音失败未停止或反压已建立 RTP |
| 存储恢复 | `passed_controlled_server` | 仅移除 fault filler 后发起新呼叫，恢复录音 `complete`，payload `528,324` bytes、7 segments，manifest 和 completion 均存在 |
| 进程与隔离 | `passed_controlled_server` | RustPBX restart `0`、OOM false；验收容器、网络、卷残留 0；9 个既有 HOMER/LiveKit/RustPBX 基线容器全部 running、restart `0`、OOM false |
| 诊断安全 | `implemented_tested` | 启动失败会在清理前保存 Compose 状态和 RustPBX 尾部日志；URL credentials、Bearer、authorization、password、token、secret 统一脱敏，文件为 `0600`。本轮由此精确定位旧 `nofile=65536`，验收拓扑已提升为镜像要求的 `262144` |
| 容量解释 | `capacity_claim_none` | 单呼叫、同一 4-vCPU 主机的故障隔离结果，不提供并发录音或 PBX 单机上限 |

机器证据和研发说明为
`docs/evidence/wave3-rustpbx-recording-storage-isolation-server-validation-2026-07-25.json` 与
`docs/evidence/wave3-rustpbx-recording-storage-isolation-server-validation-2026-07-25.md`；
机器证据 SHA-256 为
`9e2189ff2144cd2b0746519b9ffa75147037bfa40f983a91a81da1e2baed69cb`，原始服务器文件权限
`0600`，不含 endpoint 或 credential。

仍为 `not_run`：并发录音饱和、慢/阻塞磁盘、inode exhaustion、只读重挂载、多小时存储中断、
spool watermark admission 与对象上传故障负载，SRTP、转码、IVR、会议、PSTN、长稳、
独立 generator/SUT、1/2/4 节点边际效率、Cell-10K 和 MIX-100K。Registry digest、SBOM、
签名与 provenance 也尚未完成；`capacity_claim=none`。

## 43. Tinode IM 关闭一致性服务器终审（2026-07-28）

本节记录 IM 正确性优先于下一轮性能优化的最终收口。服务器只滚动
`ivekit-goal3-0f9b063-opc-1`，没有修改或重启 LED 容器、代码、配置和数据。

| 项目 | 结果 | 直接证据与边界 |
| --- | --- | --- |
| 镜像与迁移 | `passed_server` | `ivekit/opc:im-final8-3f1a7d3ab2f3`，image ID `sha256:530e6e3...51484ea`；容器 healthy、restart 0；schema migration 105/106 已按序落库，readiness 报告 migrations missing 为空 |
| HTTP/Tinode E2E | `passed_server` | 建会话、两名参与人、Tinode binding、两份带短期 token 的 client-plan、后端消息 publish、edit mutation、close 和重复 close 全部成功；关闭后 participant/bind/client-plan/message/edit/delete/delivery-retry 七条路径均返回 409 |
| PostgreSQL 终态 | `passed_server` | session closed 且有 closed_at；两个 provider user 全部 revoked；一个 inbound cursor paused；edit mutation 为 `dead_letter/session_closed`；该 session 的非终态 delivery/mutation 均为 0 |
| facade RLS | `passed_server` | 使用真实 runtime root Pool 直接调用 iveKit facade 重复关闭成功，证明 facade 在同一 tenant RLS 事务内获取 advisory lock，不再出现无上下文假 404 |
| 本地门禁 | `passed` | 根 typecheck、完整 communication/IM/Tinode 回归、delivery bundle/readiness/standalone migration 契约和 fork SHA-256 门禁通过；独立复审为 0 P0 / 0 P1 |
| 残余容量风险 | `not_run` | migration 106 在生产级历史队列上的锁时长，以及真实阻塞 Provider 网络调用下的并发 close 压测尚未执行；二者进入下一性能目标，不改变本节 IM 正确性结论 |

Provider 撤权与 PostgreSQL COMMIT 不能形成分布式原子事务。当前顺序优先避免越权：撤权失败不提交
本地关闭；撤权成功后数据库失败可能留下本地 open、provider 已撤权的可用性恢复场景，需要
retry/reconciliation，不能自动放宽 ACL。该边界已写入详细设计和 LED 对接规则。
