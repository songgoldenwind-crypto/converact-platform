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
| Tinode IM | implemented | 双向 durable sync、附件安全导入/发布门禁、operation snapshot、dead-letter replay、指标；focused 与 PostgreSQL harness 通过 | 当前 release 的真实 Tinode 多客户端、长稳和公网故障切换 |
| 文件安全 | implemented | migration 061、magic MIME、clamd/HTTP scanner、quarantine、FFmpeg/HTTP 派生、multipart/resume、retention cleanup；受控故障矩阵通过 | 生产对象存储、真实病毒样本库升级、目标容量和长稳 |
| LiveKit | implemented | migration 063、QoS degraded/recovered、防抖、connection revision、terminal rejoin、preflight、参考客户端 Node `158/158` 和 Chromium Media `3/3` | 真实摄像头/麦克风、目标 TURN/Egress、弱网和公网媒体质量 |
| Compose | implemented_and_rendered | standalone quiet config 通过；ClamAV 私网、探针、持久卷、资源和 worker 默认值已校验 | 目标服务器实际启动与长稳 |
| Helm | implemented_and_rendered | Chart、digest 门禁、ClamAV Deployment/Service/PVC、API wait init、CI gate 已实现；2026-07-17 使用 Helm `v3.18.4` 完成 lint/template 和 `20/20` 发布合同 | 目标集群 install/upgrade/rollback 尚无执行证据 |
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
| Tinode Kubernetes | implemented_not_run | standalone Chart 保留兼容型 bundled 单副本 ConfigMap/Secret refs、Deployment、Service、PVC、PDB、HTTP `/health` 探针、资源、安全上下文和 NetworkPolicy；Cell-10K 另提供三节点 fork StatefulSet、headless cluster Service、client Service、稳定 `cluster_self`、本地 sidecar 和 `minAvailable: 2` PDB；每个 API Pod 仍用 init container fail-closed 创建或验证 Tinode service account；Helm `v3.18.4` lint/template 已通过 | 目标集群 Helm install/upgrade/rollback、三节点 cluster/failover、真实 PVC 和长稳 |
| Tinode 原生 mutation | implemented | migration 074；本地 edit/delete 与 provider mutation outbox 同事务；版本串行、lease fencing、retry/dead-letter/replay、replacement/delete wire frame、inbound echo suppression、外部客户端投影、SDK sync status 和事件；edit pub ACK 丢失或过期 processing lease 被接管时立即以 `provider_outcome_uncertain` 死信，阻止重复 replacement，并提供 OpenAPI/SDK 人工对账重放；迟到 echo 在同一事务纠正 delivered 并以稳定幂等键写 durable correction event，提交后广播失败可由 replay/Webhook 恢复；bootstrap 兼容已有账号的 304/409；真实 PostgreSQL 已覆盖过期 edit claim 和 inbound 结果透传 | 真实 Tinode 1.4.7/0.25.1 多原生客户端一致性、ACK 丢失对账与故障恢复 |
| RustDesk 精准断开 | implemented_not_run | migration 075 emergency authorization；ACL session registry/resolver；package v6 与 fixed native-control v2；命令、operation observation 和 evidence 全链携带 interaction/reservation/owner epoch；companion 每会话分片持久化最大 epoch，拒绝 stale owner 后才由 1.4.7 overlay 调用指定 `ui_cm_interface::close(native_id)`；普通失败不重启，owner/admin 显式确认后才允许 emergency restart | 两台 Windows、同机并发会话、owner handoff、UAC/login-screen 和物理断开观察 |
| RustDesk 原生证据 | implemented_not_run | 定制 RustDesk allowlist scanner 基线并自动产出稳定新文件候选；device-token context 按 controller/operation/文件名/时间窗唯一关联；15 分钟会后 finalization window；watcher、稳定性/变更/hash gate、durable spool、单文件/分片 uploader、设备/session/operation 二次授权、secure-file、扫描/隔离/衍生物、PDF OCR、录屏 ASR+帧 OCR、AI 质检和 `remote.rustdesk.evidence.*` 状态事件；migration 076 对 unsupported/ignored 持久标记并补偿 missed callback；设备侧死信 payload 默认 7 天/数量上限成对清理；远端成功后的本地删除失败保留 `uploaded + manifest` 并跨重启只重试删除，所有 manifest-backed 状态禁止普通终态压缩；手工 PowerShell 仅为恢复工具 | 定制 RustDesk 1.4.7 Windows 编译、真实文件/录屏、ClamAV/对象存储和物理 Windows |
| 八组真实验收与交付 | implemented_not_run | `ivekit-v6-real-acceptance.ts` 固定八组、source/digest/environment/run/operator/QA/observation 绑定，拒绝 mock/controlled、符号链接、路径逃逸、hash 漂移和 `not_run` 伪证据；模板、校验器、V6 文档、Tinode Helm 与 RustDesk Windows/overlay 进入 hash/tamper 保护交付包 | Provider、Tinode、LiveKit、RustDesk、PSTN、商业通知、生产对象存储、Kubernetes 均缺真实资源 |

RustDesk 未经自动 scanner/correlator/watcher/uploader 的内容仍保持 `native_unscanned` 或 `local_only`，不能由审计事件或静态配置推导为已扫描。placement-enabled Windows package builder 只接受同时声明 `ivekit-rustdesk-native-control-v2` 与 `rustdesk-native-evidence-v1` 的自定义 1.4.7 制品；v1 只允许在 placement 关闭时用于滚动兼容。交付白名单同时包含 control/evidence 两个 Rust 模块、owner epoch fence 与 correlator，SDK client-profile 投影保留 v2。Windows CI 已配置拉取固定上游、应用 overlay、安装 vcpkg manifest 并执行 `cargo check`；本工作区不具备 Windows runner，因此该远程 CI 与实际签名制品、候选扫描、授权关联和上传行为仍须在 GitHub/双机验收。

V6 统一真实验收规范位于 `docs/ivekit-v6-real-environment-acceptance.md`。截至本节日期，八组均为 `not_run`；这表示外部环境尚未验收，不表示已完成的代码/部署合同失败，也绝不等价于生产可放行。

V6 原始本地门禁为全仓 `2939` 项、`2928` pass、`0` fail、`11` 个环境检查 skip；真实 PostgreSQL harness `6/6`；delivery/OpenAPI/event/release 聚合 `54/54`；根 TypeScript、SDK build 与 83-file dry-run pack、313-source/391-payload standalone context build、三套 Compose quiet render、`git diff --check` 和 changed-line secret scan 全部通过。2026-07-17 又使用 Helm `v3.18.4` 实际完成 standalone Chart lint/template、external LiveKit + shared Redis + digest-bound Egress 双池和 RustPBX recording-spool Chart 渲染；目标集群 rollout/rollback 继续为 `not_run`。

三轮独立复审先后发现并关闭 Windows installer placeholder、交付包漏 Rust module、会后录屏窗口、dead-letter payload 生命周期、reconciliation 饥饿、迟到 echo 纠正、Tinode 304、Windows CI、纠正事件提交后丢失和上传成功后本地孤儿文件等问题。最终复审对 transaction-scoped durable correction、稳定幂等键、默认/自定义 publisher、`uploaded + manifest` checkpoint、跨重启 cleanup 和 compaction 重新检查后，报告 `0 Critical / 0 Important`。持续 OS 文件锁可能积累受跟踪的 cleanup 记录，需要监控和人工处置；远端成功但本地 checkpoint 前崩溃可能重复 HTTP 调用，但 secure-file ID/checksum/idempotency 会收敛到同一文件。

因此 V6 可判定为“代码、迁移、部署模板、自动化验收入口和交付文档完成；外部真实环境待验收”。Windows GitHub overlay job、签名 RustDesk 制品、双 Windows、真实 Tinode/LiveKit/TURN/Egress/PSTN/Provider/商业通知/对象存储和目标 Kubernetes 均不得因本地门禁通过而改写为 passed。十万并发属于下一独立容量与性能目标，本轮只保留横向扩展前提，不声明容量达标。

## 13. MIX-100K / Cell-10K 架构追加审计（2026-07-16）

本节不是重新实现 IM、视频、远控、语音或通知。既有 Tinode、LiveKit、RustDesk、RustPBX、通知 API、SDK 和业务行为保持不变；新增内容位于其下方的 placement、admission、owner routing、lease fencing、backpressure、容量探针和分布式验收层，用于提高单节点密度并让多 Cell 横向扩展时边际效率可测、可控。

| 能力 | 实现状态 | 当前代码与自动化证据 | 仍为 not_run |
| --- | --- | --- | --- |
| Cell placement 与 owner fencing | implemented | 签名 placement snapshot/token、Region/Zone/Cell top-two admission、精确 interaction owner、32+32 位 owner epoch、LiveKit/Tinode/RustDesk/RustPBX 边界接线 | 目标双 Zone 故障演练、真实多 Cell 流量迁移 |
| Cell admission 持久化 | implemented | migration 078/083/084、PostgreSQL Cell lease、逐 reservation 权威账本、reserve/activate/close 先持久化后应答、重启恢复容量与 owner sequence；lease 绑定规范化 topology SHA-256 | 真实 PostgreSQL 双副本杀主、延迟/断网和长稳 |
| Cell admission 高可用 | implemented_not_run | 双副本主动/待命；待命 `/livez=200`、`/readyz=503` 且拒绝准入；只重试 retryable lease；活动 lease 同时要求 owner 与 topology hash 一致；变更拓扑只能在释放/过期后递增 epoch 接管；Service 只路由 ready 主实例；RollingUpdate、PDB、拓扑分散；待命 projector 不重复探测组件 | 目标 Kubernetes 实际 rollout、PDB/节点驱逐、主实例失联接管时延和错配拓扑演练 |
| 组件节点准入 | implemented_not_run | LiveKit/Tinode/RustDesk/RustPBX 通用 sidecar；稳定 ordinal 节点池、Cell 容量精确聚合、node lease、checkpoint、recovery-complete、drain、单条及最多 64 条批量授权、节点级故障隔离；Cell 重启自动重放未终态 owner，已删除 owner node 的恢复 fail closed；RustPBX Helm/Compose、LiveKit StatefulSet、三节点 Tinode StatefulSet 和配对 hbbs/hbbr RustDesk StatefulSet 均支持本地 sidecar 与相同稳定节点身份 | 多节点进程重启、真实 lease takeover、节点动态扩缩和真实热路径 |
| 上游源码 hook | implemented_not_run | Go hook 面向 LiveKit/Tinode，Rust hook 面向 RustDesk/RustPBX；RustPBX 固定源码 release 编译、本地 custom image 和 12 个受控 SIPp 信令场景通过；LiveKit 固定 `v1.13.3@8f6a9cb...` 的 owner/router/SFU overlay、Go 1.26/race 测试与离线 arm64 custom image/fork marker smoke 通过；Tinode 固定 `v0.25.3@22a7c18...` 的 topic owner、稳定 `cluster_self`、mutation fencing、lazy timer/fanout 优化及 arm64 source-built custom image/fork marker smoke 通过；RustDesk Server 固定 root `1.1.15@9bae9f2...` 与 `hbb_common@83419b6...` 的 owner/relay 优化、`cargo test --locked`、digest-pinned arm64 custom image、非 root 运行和 fork marker smoke 通过；媒体包、帧和 fanout 热路径禁止远程调用 | 不可变 Registry digest/SBOM/provenance；RustPBX 真实 RTP/PSTN/overload；LiveKit/Tinode/RustDesk 真实多节点/双 Windows、真实媒体/relay/profile 和容量 |
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
| 1 | Tinode IM 完整集成 | `src/agent-runtime/collaboration/tinode-*` 实现双向同步、会话、附件、已读/状态、离线恢复、原生 edit/delete outbox、迟到 echo 纠正、重放和指标；migration 062/074 持久化文件投递与 mutation；`services/ivekit-service/helm/ivekit/templates/tinode-*` 提供 bundled Kubernetes；`infra/ivekit/tinode/` 提供固定 `v0.25.3` 三节点 owner-aware fork；OpenAPI、SDK 和参考客户端均含消息、附件与 mutation 状态 | `implemented` | 真实 Tinode 多客户端收敛、三节点故障、目标 PVC/长稳为 `not_run` |
| 2 | LiveKit 全部基础音视频 | `src/agent-runtime/livekit/` 覆盖房间、Token、参与人、音视频、屏幕共享、Webhook、moderation、录制、QoS、超时和重入；migration 063/087/088/089 覆盖质量与 Egress job/reconciliation/capacity；`infra/ivekit/livekit/` 固定 `v1.13.3` owner overlay；Egress 双池仅接受批准仓库 `ivekit/livekit-egress` 的 digest-bound 镜像，并与 external LiveKit 显式共享 Redis address/认证/TLS，缺 digest/shared Redis、使用上游全限定别名或任意其他仓库均 Helm fail-closed；参考客户端实现断线恢复与 320/390 移动布局；第 17 节已记录精确源码 Egress 本机镜像构建证据 | `implemented` | 不可变 amd64 生产 Egress 镜像、Registry digest/SBOM/签名/provenance、双客户端、摄像头/麦克风、TURN、对象链路、弱网和多实例为 `not_run` |
| 3 | RustDesk Windows 远控闭环 | `src/agent-runtime/collaboration/rustdesk-*`、`scripts/rustdesk-*` 与 `scripts/rustdesk-windows/` 覆盖授权码、device command、session hook、精准断开、owner epoch、剪贴板/文件/多屏/录屏观察、durable spool、evidence 上传、审计和 emergency fallback；`integrations/rustdesk-1.4.7/` 含 native control/evidence overlay；Windows workflow、安装包、SDK/LED facade 和参考工作区已交付 | `implemented_not_run` | 定制签名 Windows 制品、双物理机、UAC/login screen、同机多会话和真实文件/录屏为 `not_run` |
| 4 | RustPBX、SIP、WebPhone、IVR 与呼叫 | `src/agent-runtime/ivekit/voice/`、`ivr/` 和参考客户端 Voice/IVR 工作区覆盖注册、呼入/呼出、接听/拒绝、Hold、DTMF、设备、呼叫控制、路由、录音和 provider event；固定 RustPBX/rsipstack 源码 release 编译与本地 custom image 通过；`scripts/ivekit-rustpbx-sipp-acceptance.ts` 使用 SIPp 3.7.7 完成 12 个受控信令场景、19 个请求且 Router/CDR 增量均为 19 | `implemented_not_run` | 真实 RTP 音频连续性、浏览器 WSS/物理音频、PSTN、overload 曲线和 supervisor mixer 为 `not_run` |
| 5 | OCR、ASR、翻译、AI 质检、防绕单与 Provider 治理 | collaboration intelligence、attachment text、translation、quality review、policy scan 与 provider registry/governance/route 覆盖第三方 HTTP 和自建 Provider 双模式、健康检查、配额、熔断、降级、故障切换、OCR/ASR/帧 OCR、AI finding、人工复核和文本/图片防绕单；migration 059/060/076、OpenAPI、SDK 和参考质量工作区提供持久状态与操作面 | `implemented` | 真实厂商/自建模型、凭据、准确率语料、配额与故障切换为 `not_run` |
| 6 | 通知、文件安全、安全与运维 | `src/agent-runtime/ivekit/notifications/` 覆盖站内、Webhook、SMTP/HTTP Email、HTTP SMS、模板、偏好、回执、重试、死信和 Provider 治理；secure-file 模块覆盖 magic MIME、ClamAV/HTTP 扫描、隔离、转码、缩略图、分片续传、清理与 legal hold；authorization/audit/rate-limit/retention/heartbeat、监控、备份恢复、多副本 worker 和 Helm HPA/PDB/ServiceMonitor/PrometheusRule/Grafana/CronJob 已接线 | `implemented_not_run` | 商业邮件/短信、公网 Webhook、生产对象存储/ClamAV、目标监控栈、真实恢复和 Kubernetes 故障演练为 `not_run` |
| 7 | MIX-100K 双 Zone/Cell 生产代码 | migration 077–092、placement/admission/component-node runtime、稳定 owner/epoch、双 Zone/Cell lease、分布式 dispatcher/controller/worker/finalizer、JetStream/PostgreSQL/S3 evidence、容量探针、九组件 platform campaign 和 fork manifest 真值链已实现；LiveKit/Tinode/RustDesk 精确源码 overlay 已编译/测试，RustPBX 补丁队列和所有热路径优化接口已纳入交付 | `implemented_not_run` | 单机 frontier、1/2/4/8 曲线、Cell-10K、MIX-100K、真实多主机/JetStream/S3 和容量结论全部为 `not_run`，`capacity_claim=none` |
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

八项总目标的代码、架构、migration、API/SDK、部署模板、自动化入口和交接材料已经闭环；没有发现
仍需编写而被真实环境验收掩盖的功能代码缺口。唯一未勾选的当前计划项是目标 Kubernetes 的
Operator/Alertmanager/Grafana、rollout/rollback 与真实多副本故障演练，性质明确为环境验收。

本机 Docker daemon 在终审时不可用，因此没有伪造一次新的 PostgreSQL 容器复跑；历史独立
PostgreSQL harness 证据保留，但本轮容量 PostgreSQL integration 明确为 `not_run`。服务器
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
| RustDesk Client 1.4.7 | `implemented_not_run` | tag `1.4.7` 固定为 `0c86d4616298f09435f6236599b300964aa61460`；overlay 改为识别真实 `mod ui_cm_interface;` 源码锚点、校验 Git HEAD 并重复应用通过；Windows 编译、签名和双物理机仍为 `not_run` |
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
LiveKit Client `2.20.1`、Server SDK `2.15.4`、Playwright `1.61.1`、tsx `4.22.4`，并 override
esbuild `0.28.1`。runner 优先解析包内依赖，源码 checkout 才 fallback 到 reference client；配置支持
一个 Compose file 或有序 JSON base/overlay 列表及可选 env file。`/tmp` 离仓执行 `npm ci` 安装 28 个
package、`npm audit` 0 vulnerability，并成功加载 runner/runtime 与解析三个本地依赖；交付生成、hash、
秘密扫描和 README 命令也进入自动门禁。该改善只使受控验收工具可独立运行，不改变生产项 `not_run`。

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
