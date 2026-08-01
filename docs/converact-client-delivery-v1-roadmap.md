# Converact Fabric 客户端与独立交付闭环 V1 路线图

> 建立日期：2026-07-11  
> 开发分支：`codex/converact-client-delivery-v1`
> 基线提交：`58e3f30`  
> 基线门禁：1818 项测试，1814 通过，4 项预期跳过，0 失败；TypeScript、Go、Python、Rust 与前端生产构建通过。

## 1. 最终目标

在不破坏 Converact Platform 已验收能力和 `/api/ivekit/*` 稳定契约的前提下，完成可被 LED 及其他项目独立部署、独立集成的 Converact Fabric V1：

1. 独立 Converact Fabric 进程、Docker 部署包和可发布 TypeScript SDK。
2. 完整 IM 参考客户端和 Tinode 实时链路。
3. 完整 LiveKit 音视频呼叫参考客户端。
4. RustDesk 桌面客户端配置、拉起、授权、控制、文件、剪贴板、录屏、断开和审计闭环。
5. IM、音视频和远控在同一个业务协作会话中统一呈现。

首期不纳入 SIP/VoLTE、RTMP/HLS 直播、数字人和真实 OCR/ASR/AI provider 选型接入。现有 OCR/ASR/AI adapter、durable worker 和审核接口继续保留。

## 2. 稳定接口

LED 和其他项目只允许依赖以下接口：

| 接口 | 用途 |
| --- | --- |
| `@converact/sdk` | 服务端和前端 TypeScript 调用入口 |
| `/api/ivekit/media/*` | 房间、呼叫、参与人、录制和 evidence |
| `/api/ivekit/chat/*` | 会话、消息、附件、状态、策略和审核 |
| `/api/ivekit/rustdesk/*` | 设备、远控会话、launch、事件和审计 |
| Converact Fabric 租户事件流 | 消息、呼叫、录制、远控和审核实时状态 |

LED 不直接访问 PostgreSQL，不直接使用 Converact Platform call-center 路由，不绕过 Converact Fabric 向 Tinode 发布业务消息，也不在浏览器中保存平台 API key。

## 3. 里程碑

### M1：独立交付底座

**状态：本地代码与交付门禁完成。** 真实服务器部署按用户要求暂缓，部署与验收材料已保留。

实施计划：[Converact Fabric Standalone Foundation Implementation Plan](superpowers/plans/2026-07-11-converact-standalone-foundation.md)

交付内容：

1. Converact Fabric-only HTTP 进程和后台 worker 生命周期。
2. 兼容现有 URL 的独立 Compose 运行方式。
3. `@converact/sdk` 独立构建和 npm pack。
4. Converact Platform 旧源码入口兼容 re-export。
5. 租户/RLS、附件、webhook、录制 evidence 和 RustDesk launch 不回归。

验收终点：LED 后端无需引用 Converact Platform 源码，即可通过 SDK 调用真实服务器上的 Media、Chat 和 RustDesk facade。

### M2：IM 参考客户端

**状态：本地代码与本地交付门禁完成，真实环境未验收。** 计划见 [Converact Fabric IM Reference Client Implementation Plan](superpowers/plans/2026-07-11-converact-im-reference-client.md)。本地受控双浏览器、Tinode-only 收敛、45 项客户端测试、8 项证据校验、全仓测试、SDK/前端/Compose 门禁均已通过；JWT 会话可见性、参与人管理、退出撤权和凭证签发竞态已经 TDD 加固，独立复审无 Critical/Important。按用户要求未上传服务器，真实 Tinode、双真实浏览器和人工证据复核仍保留。

交付内容：

1. 会话列表、会话摘要、参与人、历史消息分页和搜索。
2. 文本、图片、视频、语音和文件消息。
3. 上传进度、失败重试、预览、下载和附件处理状态。
4. 已送达、已读、未读、presence、typing、编辑和软删除。
5. 引用回复、转发、表情回应、@成员和置顶。
6. Tinode receive-only SDK、断线重连、增量补偿和本地镜像收敛。
7. 会话结束后的参与人权限回收。
8. 防绕单 finding 和人工审核入口，但不接真实 OCR/ASR/AI provider。

验收终点：两个浏览器可以在真实 Tinode 上持续聊天、传附件、断网恢复，并且所有业务消息均经过本地镜像和 policy scan。

### M3：LiveKit 音视频参考客户端

**状态：本地代码与本地交付门禁完成，真实环境尚未验收。** 计划见 [Converact Fabric LiveKit Reference Client Implementation Plan](superpowers/plans/2026-07-11-converact-livekit-reference-client.md)。

交付内容：

1. 呼叫、响铃、接听、拒绝、取消、超时、未接和结束状态机。
2. 摄像头、麦克风和扬声器预览与切换。
3. 静音、开关摄像头、屏幕共享和屏幕音频。
4. 多人宫格、主讲人模式和共享画面模式。
5. 主持人静音、移除参与人和关闭房间。
6. 网络质量、重连、设备变化、弱网和长时间通话状态。
7. 开始/停止录制、录制列表、播放、下载和 evidence 展示。
8. durable call/participant/action PostgreSQL 状态机、FORCE RLS、幂等和自动响铃超时 worker。
9. 官方 `livekit-client` adapter 边界、prejoin、设备切换、主持控制、重连与终态撤权。
10. 短令牌持续刷新、WebSocket subprotocol 认证、到期主动断开和零持久化。
11. call-bound 录制行锁、evidence 持久化、公开 DTO 脱敏和服务端流式导出。

本地验收证据：

- 参考客户端单元/组件测试 `101/101`。
- 受控浏览器 E2E `4/4`，其中媒体 `3/3`、IM `1/1`。
- LiveKit 真实环境验收契约 `14/14`；无真实报告时明确返回 `not_run`。
- 全仓 `1908` 项测试中 `1903` 通过、`5` 个预期跳过、`0` 失败；TypeScript、Go、Python、Rust、SDK、前端和 Compose 门禁通过。
- 独立审查发现的 `3 Critical + 8 Important` 已全部用回归测试关闭，当前无未解决 Critical/Important。
- 未上传或部署到服务器；真实 LiveKit/ICE/TURN/Egress/MinIO、真实摄像头麦克风、两个真实浏览器和长稳/弱网证据仍为 `not_run`。

验收终点：两个真实浏览器完成完整呼叫生命周期，在网络切换后恢复，并产生可查询、可导出的录制证据。

### M4：RustDesk 真实终端闭环

**状态：本地代码与交付材料完成。** Task 1-10 已完成；未上传服务器，真实 hbbs/hbbr 和物理双客户端验收按用户要求保持 `not_run`。下一步进入 [M5 统一协作客户端实施计划](converact-m5-unified-collaboration-plan.md)。RustDesk 专项计划见 [Converact Fabric RustDesk Real Terminal V1 Implementation Plan](superpowers/plans/2026-07-12-converact-rustdesk-terminal-v1.md)。

Task 8 本地受控浏览器 E2E 为 `3/3`：覆盖设备解析、scope 展示、会话创建、宿主协议拉起、控制锁获取/转交、操作审计幂等、结束、断开状态推进、撤权、旧链接失效、参与人/租户隔离、暂态重试、过期 launch 抑制、token 零持久化以及桌面/手机布局。该结果仅是控制面本地回归证据，不代表 RustDesk 原生画面、键鼠、多显示器、文件、剪贴板、录屏、relay 或物理断开已经真实运行。

Task 9 已将真实终端报告升级为 schema v2：强制 hbbs/hbbr 与两端客户端版本、平台/架构、target ID、key fingerprint、ID/relay 路径、不同 operator/QA 身份；每个检查使用唯一 JSON observation 并按 SHA-256 绑定 run/environment/full commit/external_id/rustdesk_id/time/tool。受控 E2E、Playwright、mock、synthetic、符号链接、越目录、重复、过期、上下文或哈希不匹配以及含敏感内容的证据均被拒绝。命令成功与人工观察到物理断开独立校验；无真实报告时结果是 `not_run`。

Task 10 最终本地证据：全仓 `2042` 项中 `2037` 通过、`5` 项真实 PostgreSQL 环境检查按预期跳过、`0` 失败；Go/Python/Rust sidecar、SDK build/pack（34 files，约 51.2 kB）、参考客户端 `105/105`、前端构建、统一浏览器 E2E `7/7` 和 Converact Fabric Compose 静态解析通过。浏览器 dist、SDK dist 与新生成 acceptance bundle 未发现私钥、JWT、Authorization 或实际启动 token；无真实环境的 bundle 状态为 `not_run`。

交付内容：

1. Windows、macOS 和 Linux 客户端配置包及版本矩阵。
2. LED 页面一键拉起、目标设备匹配和授权 scope 展示。
3. 有人值守授权和无人值守策略接口，首期不保存明文无人值守密码。
4. 画面、键鼠、多显示器、剪贴板、文件传输和录屏验收。
5. 操作事件采集 adapter、幂等转发、dead-letter 和审计覆盖。
6. 断网恢复、撤权、会话结束和物理断开。
7. 多工程师控制锁、移交和高权限二次确认。

验收终点：两台真实桌面设备完成上述操作；撤权或结束后画面和控制能力实际停止；事件、文件和录屏证据可按同一 `external_id` 审计。

### M5：统一协作客户端与交付验收

**状态：本地代码与独立交付闭环已完成，真实环境未验收。** M5.1-M5.7 已完成：统一业务上下文、导航/深链接、参与人/授权摘要、PostgreSQL 统一事件/evidence 时间线、前端拆包预算和独立 LED 交付包均已完成。viewer 级 evidence 过滤、稳定 cursor、资源级 URL、浏览器历史、跨业务旧资源清理和只读授权投影均有自动化覆盖。`npm run converact:delivery-bundle` 可单命令生成 SDK tgz、参考客户端 dist、Compose、通信域迁移、文档、示例、验收状态、manifest 和 SHA-256 清单；交付版 Compose 不依赖 Converact Platform 源码路径，必须使用同提交构建的 Converact Fabric 应用镜像。最终本地门禁为全仓 2051 项中 2046 通过、5 项预期跳过、0 失败，客户端 113/113、完整受控 E2E 9/9，SDK、Compose、chunk 预算、交付秘密扫描与 checksum 均通过。按当前“不上传服务器”范围，LiveKit/Tinode/RustDesk 真实状态保持 `not_run`。

交付内容：

1. 同一个 `business_ref` 下统一会话、IM、音视频和远控入口。
2. 统一参与人、授权状态、事件时间线和 evidence 列表。
3. 路由/provider 拆分与硬预算已完成：initial 约 315 kB、Tinode 103 kB、Media workspace 62 kB、Remote 13 kB、LiveKit vendor 509 kB；初始 HTML 不 preload provider，构建无超限警告。
4. 桌面和移动端关键视口 Playwright 截图与交互验收。
5. SDK、Compose、迁移、升级、回滚和 LED 对接文档。
6. 完整单测、契约测试、浏览器 E2E、真实服务 smoke 和真实桌面验收包。

验收终点：LED 研发仅使用部署包、SDK 和参考客户端模块即可完成接入，不需要理解 Converact Platform 内部 call-center 实现。

### M7：V3 多模态智能与翻译

**状态：代码、SDK、参考客户端、standalone、交付合同和隔离服务器受控验收已完成；真实厂商/物理客户端仍为 `not_run`。** 实施计划见 [Converact Fabric V3 Multimodal Intelligence and Translation](superpowers/plans/2026-07-13-converact-v3-multimodal-translation.md)，运维手册见 [V3 intelligence operations](converact-fabric-v3-intelligence-operations.md)，证据状态见 [V3 completion audit](converact-fabric-v3-completion-audit.md)。

交付内容：

1. OCR、ASR、AI 质检和翻译统一 `self_hosted|third_party` Provider profile；token 只从环境/Secret 解析。
2. 租户策略控制 capability、自动任务、profile、第三方许可、置信度和翻译目标语言。
3. 图片、音频、视频、屏幕录制、LiveKit 录制和远控录屏通过稳定 ID 进入 durable job。
4. AI finding 保持 advisory；租户 operator/admin 使用 Quality 队列和不可变 review audit。
5. 消息/附件翻译保留原文并绑定 source hash，编辑、删除、重试和并发不会展示陈旧结果。
6. PostgreSQL migration 043-045、FORCE RLS、worker lease/retry、Provider health/preflight、Compose/Kubernetes 和独立服务已接入。
7. `@converact/sdk` 提供 `intelligence` 与翻译 API；参考客户端提供 Quality 和 Translation 工作区。
8. 交付 manifest 绑定 source commit、migration、SDK、client、image metadata、SBOM、Provider 示例和 acceptance 状态 SHA-256；受控验收 `passed` 还必须绑定交付内证据文件大小/hash。

完成边界：受控 Provider 和服务器测试证明协议、重试、脱敏、RLS 与恢复，不代表真实 OCR/ASR/AI/翻译厂商准确率、合规、配额和生产延迟。真实厂商未选型前必须保持 `not_run`。

## 4. 执行顺序

V1 已按 `M1 -> M2 -> M3 -> M4 -> M5` 完成；V3 扩展按独立 M7 计划执行。每个里程碑遵守以下门禁：

1. 先写该里程碑详细实施计划。
2. 每项行为变更先写失败测试并确认 RED。
3. 小步实现并运行专项测试。
4. 完成后运行 `npm run verify` 和相关前端/SDK 构建。
5. 做独立代码审查并解决 Critical/Important 问题。
6. 更新详细设计、OpenAPI、LED 指南和本路线图状态。
7. 上一个里程碑通过后才能开始下一个里程碑。

## 5. 完成定义

整个 Goal 只有同时满足以下条件才完成：

1. M1-M5 和 M7 的代码、文档与交付合同全部完成。
2. Converact Platform 现有能力无行为回归。
3. SDK 可独立构建、打包和被参考客户端消费。
4. 当前 release 的受控 PostgreSQL、Provider、浏览器和 restart recovery 证据齐全。
5. 真实 LiveKit/Tinode/RustDesk 与真实 OCR/ASR/AI/翻译厂商按各自状态裁决；未执行项明确为 `not_run`。
6. 受控功能、重启和断线恢复达到代码交付阈值；真实多副本长稳、容量和弱网在目标环境验收，未执行前保持 `not_run`，不冒充代码门禁。
7. 不存在未解决的 Critical 或 Important 审查问题。
