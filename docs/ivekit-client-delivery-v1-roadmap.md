# iveKit 客户端与独立交付闭环 V1 路线图

> 建立日期：2026-07-11  
> 开发分支：`codex/ivekit-client-delivery-v1`  
> 基线提交：`58e3f30`  
> 基线门禁：1818 项测试，1814 通过，4 项预期跳过，0 失败；TypeScript、Go、Python、Rust 与前端生产构建通过。

## 1. 最终目标

在不破坏 OPC 已验收能力和 `/api/ivekit/*` 稳定契约的前提下，完成可被 LED 及其他项目独立部署、独立集成的 iveKit V1：

1. 独立 iveKit 进程、Docker 部署包和可发布 TypeScript SDK。
2. 完整 IM 参考客户端和 Tinode 实时链路。
3. 完整 LiveKit 音视频呼叫参考客户端。
4. RustDesk 桌面客户端配置、拉起、授权、控制、文件、剪贴板、录屏、断开和审计闭环。
5. IM、音视频和远控在同一个业务协作会话中统一呈现。

首期不纳入 SIP/VoLTE、RTMP/HLS 直播、数字人和真实 OCR/ASR/AI provider 选型接入。现有 OCR/ASR/AI adapter、durable worker 和审核接口继续保留。

## 2. 稳定接口

LED 和其他项目只允许依赖以下接口：

| 接口 | 用途 |
| --- | --- |
| `@opc/ivekit-sdk` | 服务端和前端 TypeScript 调用入口 |
| `/api/ivekit/media/*` | 房间、呼叫、参与人、录制和 evidence |
| `/api/ivekit/chat/*` | 会话、消息、附件、状态、策略和审核 |
| `/api/ivekit/rustdesk/*` | 设备、远控会话、launch、事件和审计 |
| iveKit 租户事件流 | 消息、呼叫、录制、远控和审核实时状态 |

LED 不直接访问 PostgreSQL，不直接使用 OPC call-center 路由，不绕过 iveKit 向 Tinode 发布业务消息，也不在浏览器中保存平台 API key。

## 3. 里程碑

### M1：独立交付底座

**状态：本地代码与交付门禁完成。** 真实服务器部署按用户要求暂缓，部署与验收材料已保留。

实施计划：[iveKit Standalone Foundation Implementation Plan](superpowers/plans/2026-07-11-ivekit-standalone-foundation.md)

交付内容：

1. iveKit-only HTTP 进程和后台 worker 生命周期。
2. 兼容现有 URL 的独立 Compose 运行方式。
3. `@opc/ivekit-sdk` 独立构建和 npm pack。
4. OPC 旧源码入口兼容 re-export。
5. 租户/RLS、附件、webhook、录制 evidence 和 RustDesk launch 不回归。

验收终点：LED 后端无需引用 OPC 源码，即可通过 SDK 调用真实服务器上的 Media、Chat 和 RustDesk facade。

### M2：IM 参考客户端

**状态：本地代码与本地交付门禁完成，真实环境未验收。** 计划见 [iveKit IM Reference Client Implementation Plan](superpowers/plans/2026-07-11-ivekit-im-reference-client.md)。本地受控双浏览器、Tinode-only 收敛、45 项客户端测试、8 项证据校验、全仓测试、SDK/前端/Compose 门禁均已通过；JWT 会话可见性、参与人管理、退出撤权和凭证签发竞态已经 TDD 加固，独立复审无 Critical/Important。按用户要求未上传服务器，真实 Tinode、双真实浏览器和人工证据复核仍保留。

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

**状态：本地代码与本地交付门禁完成，真实环境尚未验收。** 计划见 [iveKit LiveKit Reference Client Implementation Plan](superpowers/plans/2026-07-11-ivekit-livekit-reference-client.md)。

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

**状态：本地开发进行中。** Task 1-7 已完成；下一步进入 Task 8 受控 Remote 浏览器 E2E。真实服务器和物理双客户端验收按用户要求暂缓。计划见 [iveKit RustDesk Real Terminal V1 Implementation Plan](superpowers/plans/2026-07-12-ivekit-rustdesk-terminal-v1.md)。

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

交付内容：

1. 同一个 `business_ref` 下统一会话、IM、音视频和远控入口。
2. 统一参与人、授权状态、事件时间线和 evidence 列表。
3. 路由级代码拆分，消除当前约 1.29 MB 的单一前端 chunk 警告。
4. 桌面和移动端关键视口 Playwright 截图与交互验收。
5. SDK、Compose、迁移、升级、回滚和 LED 对接文档。
6. 完整单测、契约测试、浏览器 E2E、真实服务 smoke 和真实桌面验收包。

验收终点：LED 研发仅使用部署包、SDK 和参考客户端模块即可完成接入，不需要理解 OPC 内部 call-center 实现。

## 4. 执行顺序

严格按 `M1 -> M2 -> M3 -> M4 -> M5` 执行。每个里程碑遵守以下门禁：

1. 先写该里程碑详细实施计划。
2. 每项行为变更先写失败测试并确认 RED。
3. 小步实现并运行专项测试。
4. 完成后运行 `npm run verify` 和相关前端/SDK 构建。
5. 做独立代码审查并解决 Critical/Important 问题。
6. 更新详细设计、OpenAPI、LED 指南和本路线图状态。
7. 上一个里程碑通过后才能开始下一个里程碑。

## 5. 完成定义

整个 Goal 只有同时满足以下条件才完成：

1. M1-M5 的代码和文档全部完成。
2. OPC 现有能力无行为回归。
3. SDK 可独立构建、打包和被参考客户端消费。
4. 真实 LiveKit、Tinode、MinIO 和 RustDesk 服务链路通过。
5. 真实浏览器与真实桌面客户端证据齐全。
6. 长稳、容量、弱网和断线恢复达到 V1 验收阈值。
7. 不存在未解决的 Critical 或 Important 审查问题。
