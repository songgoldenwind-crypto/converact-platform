# iveKit V3 完成审计与验收记录

更新日期：2026-07-13。本文对应 `codex/ivekit-v3-multimodal-translation`，用于记录 V3 多模态智能与翻译从代码审计、交付包到隔离服务器验收的可复验证据。

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
