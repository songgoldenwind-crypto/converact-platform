# LiveKit / IM Full Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OPC 里已经沉淀的 LiveKit 音视频能力和 Tinode/Collaboration IM 能力补成可交付、可验收、可抽离给 LED 项目复用的通用后端能力。

**Architecture:** 采用“先稳定模块边界，再补生产化链路，最后抽离服务/SDK”的路线。LiveKit 仍以 `LiveKitMediaModule` + `/api/media/livekit/*` 为核心；IM 仍以 `CollaborationStore` + `ChatGateway` + Tinode 外部服务为核心；LED 侧通过稳定 HTTP facade、OpenAPI/契约文档和可运行 smoke 套件对接，不直接耦合 OPC call-center 业务。

**Tech Stack:** TypeScript、Node.js test runner、PostgreSQL/RLS、LiveKit Server/Egress/SIP、Tinode、WebSocket、MinIO/S3 object storage、Playwright smoke、现有 OPC auth/tenant middleware、现有 iveKit collaboration/remote-assistance 模块。

---

## 0. 当前状态与开发门禁

截至 2026-07-10 文档复核，本文件是后续 LiveKit/IM 开发的准入文档。后续不能再凭临时记忆继续写代码；每一次代码改动必须能落到本文某个 Phase、某条验收标准和对应测试命令。

| 范围 | 当前状态 | 代码证据 | 后续门禁 |
|---|---|---|---|
| Phase 0 范围冻结 | 本文负责冻结范围 | `docs/livekit-im-full-capability-plan.md` | 本轮不继续扩 RustDesk，不把数字人细节并入 Media Core 主线 |
| Phase 1 LiveKit preflight | 工作区已出现实现和测试 | `scripts/livekit-deployment-preflight.ts`、`test/livekit-deployment-preflight.test.ts`、`package.json` 中 `livekit:deployment-preflight` | 服务器仍需实际执行 preflight/readiness，不能把本地单测等同真实部署验收 |
| Phase 2 LiveKit facade | 工作区已出现 `/api/ivekit/media/*` facade | `src/agent-runtime/ivekit/media-http.ts`、`src/http.ts` 中 iveKit media route | 静态 OpenAPI/完整错误码表仍需补；服务器 LiveKit 仍需真联调 |
| Phase 6 IM/Tinode facade | 本地代码已完成 | `scripts/tinode-deployment-preflight.ts`、`src/agent-runtime/ivekit/chat-http.ts`、`test/tinode-deployment-preflight.test.ts`、`test/ivekit-chat-facade.test.ts` | 真实 Tinode 仍需服务器执行 preflight/smoke；不得把本地 fake 协议测试当成部署验收 |
| Phase 7 IM 同步/可靠性 | 7A durable outbound 已完成本地代码 | `025_collaboration_message_delivery.sql`、`tinode-message-delivery.ts`、`tinode-sync-worker.ts`、投递状态/attempt API 与测试 | `direct_client_publish=false` 继续生效；只有未来开放客户端直发时才启动 7B inbound seq/cursor sync |
| Phase 8 附件、OCR/ASR | 本地代码已完成 | `027_collaboration_attachment_processing.sql`、provider/worker/preflight/API/测试 | 真实对象存储与 OCR/ASR provider 待服务器验证 |
| Phase 9 AI 质检/人审 | 本地代码已完成 | `028_collaboration_policy_findings.sql`、`029_collaboration_quality_review.sql`、provider/worker/facade/测试 | 真实模型效果、吞吐、阈值和人工审核 UI 待后续验证/开发 |
| Phase 10 IM 高级状态 | 本地代码已完成 | `030_collaboration_message_state.sql`、`message-state-store.ts`、官方 `tinode-sdk` receive-only adapter、iveKit API/事件/前端契约与测试 | 真实 Tinode 浏览器 join、真实多副本 WebSocket/Redis 和 PostgreSQL RLS 仍待服务器验证；客户端保持 `JRP`、不得直发业务消息 |

### 0.1 不再盲写的规则

1. 不新增与本文无关的功能点；发现新需求先更新本文，再进入 TDD。
2. 每个 Phase 必须先写失败测试，确认失败原因正确，再写生产代码。
3. 本地 fake provider 测试、脚本契约测试、服务器真实 smoke 必须分开描述，不能互相替代。
4. LiveKit、Tinode、MinIO、RustDesk 都是 provider；OPC/iveKit facade 和本地审计镜像才是 LED 对接边界。
5. 不引入 SQLite；继续使用 PostgreSQL、租户上下文和 RLS。
6. RustDesk 远控保留现有成果，本轮只在影响 Web Assist/LiveKit/IM 闭环时修正。

## 1. 本文定位

这份文档是后续继续开发前的目标计划，不是新的审计文档，也不是宣传性功能清单。

它解决三个问题：

1. 明确 LiveKit 和 IM 到底要做到什么程度才算“完整第一版”。
2. 明确当前仓库已经有什么、还缺什么、哪些只是本地测试通过但没有真实环境验收。
3. 明确后续代码开发顺序，避免在 RustDesk、LiveKit、Tinode、OCR/ASR、前端页面之间来回跳。

执行原则：

1. 先暂停 RustDesk 扩展开发，只保留阻塞 LiveKit/IM 的必要修复。
2. 第一优先级是 LiveKit Media Core 完整生产化。
3. 第二优先级是 IM/Tinode 完整集成。
4. 第三优先级是附件、OCR/ASR、AI 质检和防绕单闭环。
5. 最后再做抽包、独立服务、LED SDK、OpenAPI 交接包。

---

## 2. 总体目标边界

### 2.1 LiveKit 完整第一版目标

LiveKit 第一版不是只“能建房间、能签 token”。目标能力包括：

| 能力 | 第一版目标 | 当前状态 | 缺口 |
|---|---|---|---|
| 房间管理 | 创建、查询、关闭、租户隔离、业务对象绑定、关闭后拒绝 join/recording/dispatch | 已编码 | 缺服务器 preflight 与正式 OpenAPI |
| Token | agent/customer/supervisor/AI/SIP 角色 token，带租户和房间生命周期门禁 | 已编码主路径 | 需要补角色矩阵文档和契约测试 |
| Join Plan | 统一返回浏览器 join 所需 token、URL、room、identity、media 类型和 H5 path | 已编码 | 需要 LED facade 和浏览器真联调 |
| 客户邀请 | HMAC signed invite，过期和签名不匹配拒绝 | 已编码 | 需要部署前检查和错误码文档 |
| 参与人 | joined/left、role、metadata、房间关闭时收敛状态 | 已编码 | 需要乱序/重复 webhook 覆盖继续补强 |
| Webhook | LiveKit participant/room/egress webhook，验签，幂等回填 | 已编码 | 需要真实 LiveKit webhook smoke |
| Recording/Egress | start/stop/list/get，business_ref，录制 evidence 回填 | 已编码 | 需要 MinIO/S3 真实可写、可读、retention 验收 |
| AI Agent Dispatch | 派 AI agent 入房，metadata 租户门禁 | 已编码 | 数字人不作为本阶段主目标，AI dispatch 只保证媒体能力 |
| Screen Share | 坐席屏幕共享、客户/坐席画面分流 | 已编码部分前端 | 需要浏览器 E2E 和失败态检查 |
| Web Assist Media | 远协媒体 join、录屏、consent 门禁 | 已编码 | 需要真实浏览器和 LiveKit 房间联调 |
| SIP/VoLTE | LiveKit SIP bridge readiness 和配置检查 | readiness 已有 | 真实呼入/呼出桥接不算完成 |
| Readiness Suite | 一条命令串起 media/avatar/AI callback/browser/collaboration/sip | 已编码 | 需要部署 preflight 文档、报告和服务器执行记录 |
| 可抽离边界 | `LiveKitMediaModule` 不反向依赖 call-center | 已编码主边界 | 需要最终包化/服务化清单 |

### 2.2 IM 完整第一版目标

IM 第一版不是只“本地保存消息”。目标能力包括：

| 能力 | 第一版目标 | 当前状态 | 缺口 |
|---|---|---|---|
| Collaboration Session | 按 `business_ref` 创建/查询会话，支持订单/工单/通话绑定 | 已编码 | 需要 LED 对接字段文档 |
| Chat Binding | 一个 session 绑定一个 Tinode topic，本地保存 provider topic | 已编码 | 需要真实 Tinode 部署 smoke |
| 用户与参与人 | 创建/复用 Tinode 用户，加入/移除 topic，本地参与人镜像 | 已编码 | 需要浏览器 SDK token 联调 |
| 文本消息 | 经 OPC facade 发送，写本地镜像，发布到 Tinode，触发防绕单扫描 | 已编码并有 durable delivery | 真实 Tinode 仍待服务器 smoke |
| Client Plan | 给浏览器返回 Tinode topic/user/token/ws_url/api_key | 已编码 | 需要前端 Tinode SDK 真连接 |
| Tinode 实时同步 | Tinode 中直接产生的消息同步回 OPC 本地镜像、策略扫描、审计 | 未完成 | 需要 Tinode sync worker 或服务端强制消息走 OPC |
| 附件消息 | 上传、对象存储引用、处理状态、checksum、OCR/ASR 异步 job | 本地代码已完成 | 真实对象存储权限仍待服务器验证 |
| 图片 OCR | 图片中的手机号/二维码/联系方式识别后重新进入防绕单扫描 | provider-neutral 代码已完成 | 自建或第三方真实服务待选型和服务器验证 |
| 语音 ASR | 语音/视频中联系方式转写后进入质检和防绕单 | provider-neutral 代码已完成 | 自建或第三方真实服务待选型和服务器验证 |
| AI 质检 | 汇总文本、OCR、ASR，生成辅助 finding、风险分级和处置建议 | 本地代码与人审闭环已完成 | 真实模型效果、阈值和容量待服务器验证 |
| 翻译 | store 类型已存在 | HTTP/API 未形成完整链路 | 后续按 LED 需求排期 |
| 消息状态 | 参与人维度送达/已读、read-through、unread count、typing/presence TTL | 本地代码已完成 | 真实浏览器、多副本广播和真实 PostgreSQL 待服务器验证 |
| 消息变更 | 发送者限时编辑、软删除、不可变 mutation hash audit | 本地代码已完成 | Tinode 原生消息不做 edit/delete 回写；本地镜像和 OPC WebSocket 是业务展示权威 |

### 2.3 Remote Assistance 与本计划的关系

远程协助、屏幕共享、页面内控制、RustDesk 系统级远控是 iveKit 视频/协作能力的一部分，但本轮不继续扩大 RustDesk 范围。

处理口径：

1. Web Assist 的媒体能力归入 LiveKit 第一版验收。
2. Web Assist 的 consent、events、recording、audit 只在影响 LiveKit/IM 闭环时补。
3. RustDesk 作为系统级远控主 provider 保留现有结果，不再作为本计划第一优先级扩展。
4. MeshCentral/Guacamole 继续作为 fallback，不进入本轮核心开发。

### 2.4 LiveKit 完成定义

LiveKit 能力只有同时满足“API 可用、数据可追踪、真实环境可验收、LED 不耦合 OPC 内部实现”才算第一版完成。

| 子能力 | 必须实现 | 必须验证 | 不能算完成的情况 |
|---|---|---|---|
| 部署配置 | LiveKit Server/Egress/SIP/MinIO/env checklist/report 全部脱敏输出 | `npm run livekit:deployment-preflight`、`npm run render:media-configs` | 只靠 `.env.example` 人工核对 |
| 房间生命周期 | create/get/close，业务对象绑定，关闭后拒绝 join/recording/dispatch | HTTP contract test + 服务器 media smoke | 只创建房间，不处理 close 后门禁 |
| Token 与 Join Plan | agent/customer/supervisor/AI/SIP 角色矩阵，tenant/room/identity 门禁，客户 signed invite | token/join 单测 + 浏览器 smoke | 只返回 LiveKit token，不返回 LED 可直接用的 join plan |
| 参与人与 Webhook | participant joined/left、room ended、egress ended 幂等回填 | webhook fake test + 真实 LiveKit webhook smoke | 只依赖前端状态，不落本地镜像 |
| Recording/Egress | start/stop/list/get，object URL/signed read/export/retention/audit/evidence | recording 单测 + MinIO/S3 真实读写 | 只写 DB row，看不到对象是否真实存在 |
| 屏幕共享与 Web Assist Media | consent 后 join media，screen track 状态、录屏状态、失败态可见 | Playwright browser smoke + Web Assist store test | 页面能打开但无法证明 track/consent/recording 状态 |
| SIP/VoLTE | readiness 输出 dial plan、trunk/endpoint/tenant/room 映射 | `npm run smoke:media:sip-volte` 在真实电话环境跑 | 只生成 planned state 却宣称已打通电话 |
| facade/API | `/api/ivekit/media/*` 稳定入口、capabilities、OpenAPI/Markdown contract | facade contract test + LED 对接清单 | LED 直接调用 `/api/media/livekit/*` 内部路径 |
| 可抽离性 | public module entry、HTTP facade、env、smoke、迁移清单完整 | 抽离 checklist 审核 | 复制 OPC call-center 业务代码到 LED |

### 2.5 IM/Tinode 完成定义

IM 能力的核心不是聊天 UI，而是“消息必须能实时到达、能审计、能进入防绕单/OCR/ASR/AI 质检闭环”。第一版允许 UI 轻量，但后端能力不能漏扫。

| 子能力 | 必须实现 | 必须验证 | 不能算完成的情况 |
|---|---|---|---|
| 部署配置 | Tinode base/ws/api key/root auth/user secret/env checklist/report | `npm run tinode:deployment-preflight`、`npm run smoke:chat:tinode` | Tinode 能启动但 OPC 不知道如何签发 client plan |
| Session | 按 `business_ref_type` + `business_ref_id` 创建/查询，会话带 tenant | collaboration/iveKit chat HTTP test | LED 必须理解 OPC 内部 session 字段才能用 |
| Topic Binding | 一个 session 对应一个 provider topic，本地保存 provider、topic、status | bind/client-plan contract test | 每次打开聊天都新建 topic |
| 参与人 | identity、role、display name、join/leave、Tinode grant 本地镜像 | participant test + Tinode smoke | 只在 Tinode 有用户，OPC 没本地审计 |
| 文本消息 | 第一版业务消息走 OPC/iveKit facade，写本地镜像、发布 Tinode、触发 scan | message contract test + Tinode publish smoke | 浏览器直接发 Tinode，OPC 防绕单看不到 |
| Tinode 实时同步 | 如果允许客户端直发 Tinode，必须有 sync cursor、seq 幂等、scan 重放 | sync worker test | 未做 sync worker 却允许直发业务消息 |
| 附件 | presign/upload metadata/checksum/content type/大小限制/关联 message | attachment processing test | 只把图片 URL 当普通文本发 |
| OCR/ASR | 第三方和自建 provider 使用同一 adapter，回填 extracted text 后重扫 | OCR/ASR adapter contract test | 识别结果只展示，不进入策略和审计 |
| 防绕单 | 文本/OCR/ASR/AI 来源统一 finding，保存 evidence refs 和 review status | policy finding test | 只返回一次规则扫描结果，没有复核闭环 |
| AI 质检 | 第三方 LLM/自建 LLM 两种 provider，AI 只辅助判定，人审最终裁决 | quality review test | AI 直接做不可逆处置 |
| 消息状态 | delivered/read/typing/presence 作为体验增强，低于风控闭环 | state contract test | 把状态体验当成第一版必需项阻塞核心交付 |
| facade/API | `/api/ivekit/chat/*` 稳定入口、capabilities、OpenAPI/Markdown contract | facade contract test + LED 对接清单 | LED 直接依赖 `/api/collaboration/*` 内部路径 |

---

## 3. 当前实现基线

### 3.1 LiveKit 现有主要文件

| 文件 | 责任 |
|---|---|
| `src/agent-runtime/livekit/index.ts` | `createLiveKitMediaModule()` public entry |
| `src/agent-runtime/livekit/types.ts` | LiveKit room/token/join/recording/participant/webhook module interface |
| `src/agent-runtime/livekit/media-http.ts` | `/api/media/livekit/*` HTTP router |
| `src/agent-runtime/livekit/token-service.ts` | LiveKit token 签发 |
| `src/agent-runtime/livekit/room-store.ts` | 房间持久化与状态 |
| `src/agent-runtime/livekit/participant-store.ts` | 参与人 joined/left 状态 |
| `src/agent-runtime/livekit/recording-service.ts` | Egress recording start/stop/list/get |
| `src/agent-runtime/livekit/webhook-handler.ts` | LiveKit webhook 处理 |
| `src/agent-runtime/livekit/agent-dispatch-service.ts` | AI Agent dispatch |
| `src/agent-runtime/media-gateway/*` | WebRTC/SIP gateway 抽象 |
| `src/agent-runtime/media-recording-evidence.ts` | recording 到 evidence 的桥接 |

### 3.2 LiveKit 现有脚本与测试

| 脚本/测试 | 作用 |
|---|---|
| `scripts/livekit-media-smoke.ts` | 真实后端 media API smoke |
| `scripts/livekit-browser-smoke.ts` | 坐席浏览器视频 smoke |
| `scripts/livekit-customer-browser-smoke.ts` | 客户 H5 join smoke |
| `scripts/web-assist-browser-smoke.ts` | Web Assist 浏览器 smoke |
| `scripts/ai-agent-opc-callback-smoke.ts` | AI agent 回调 OPC smoke |
| `scripts/sip-volte-readiness.ts` | SIP/VoLTE 配置 readiness |
| `scripts/video-readiness-suite.ts` | 视频总 readiness |
| `scripts/render-media-configs.ts` | LiveKit/Egress 配置渲染 |
| `test/livekit-media-module.test.ts` | module 能力测试 |
| `test/livekit-media-http.test.ts` | media HTTP API 测试 |
| `test/livekit-media-smoke.test.ts` | media smoke 契约测试 |
| `test/video-readiness-suite.test.ts` | readiness 编排测试 |
| `test/media-config-render.test.ts` | config render 测试 |
| `test/media-recording-evidence.test.ts` | 录制证据桥接测试 |

### 3.3 IM/Collaboration 现有主要文件

| 文件 | 责任 |
|---|---|
| `src/agent-runtime/collaboration/index.ts` | collaboration module public entry |
| `src/agent-runtime/collaboration/types.ts` | session/message/attachment/policy/remote/evidence 类型 |
| `src/agent-runtime/collaboration/collaboration-store.ts` | session、participant、message、attachment、policy 本地镜像 |
| `src/agent-runtime/collaboration/chat-gateway.ts` | `LocalChatGateway` 和 `TinodeChatGateway` |
| `src/agent-runtime/collaboration/collaboration-http.ts` | `/api/collaboration/*` HTTP router |
| `src/agent-runtime/collaboration/policy-scan.ts` | 当前规则版防绕单扫描 |
| `frontend/src/pages/collaboration-chat.ts` | 前端聊天契约 helper |
| `frontend/src/pages/CollaborationChatPage.tsx` | 可嵌入聊天页面 |

### 3.4 IM/Collaboration 现有脚本与测试

| 脚本/测试 | 作用 |
|---|---|
| `scripts/tinode-chat-smoke.ts` | Tinode topic/user/grant/pub smoke |
| `scripts/collaboration-smoke.ts` | Collaboration API smoke |
| `test/tinode-chat-smoke.test.ts` | fake Tinode wire protocol 测试 |
| `test/collaboration-http.test.ts` | collaboration HTTP 流程测试 |
| `test/collaboration-chat.test.ts` | chat store/gateway/策略测试 |
| `test/collaboration-chat-page-contract.test.ts` | 前端聊天契约测试 |
| `test/collaboration-remote-assistance.test.ts` | 远协 store 测试 |

---

## 4. 目标 API 面

### 4.1 LiveKit 已有 API

| Method | Path | 用途 | 目标状态 |
|---|---|---|---|
| `POST` | `/api/media/livekit/rooms` | 创建媒体房间 | 保留并补 OpenAPI |
| `GET` | `/api/media/livekit/rooms/:room` | 查询房间 | 保留 |
| `POST` | `/api/media/livekit/rooms/:room/close` | 关闭房间 | 保留 |
| `GET` | `/api/media/livekit/token` | 签发参与人 token | 保留 |
| `GET` | `/api/media/livekit/join` | 生成 join plan | 保留，LED 主要消费 |
| `GET` | `/api/media/livekit/rooms/:room/participants` | 查询参与人 | 保留 |
| `POST` | `/api/media/livekit/agent-dispatch` | 派 AI agent | 保留，数字人细节后置 |
| `POST` | `/api/media/webhooks/livekit` | LiveKit webhook | 保留 |
| `POST` | `/api/media/livekit/recordings/start` | 开始录制 | 保留 |
| `GET` | `/api/media/livekit/recordings` | 列录制 | 保留 |
| `GET` | `/api/media/livekit/recordings/:id` | 查录制 | 保留 |
| `POST` | `/api/media/livekit/recordings/:egressId/stop` | 停止录制 | 保留 |

### 4.2 LiveKit 计划新增/补强 API

| API | 原因 | 阶段 |
|---|---|---|
| `/api/ivekit/media/*` facade | LED 不应被 OPC 内部 `/api/media` 命名绑死；facade 可保持兼容并输出稳定 contract | P2 |
| `GET /api/ivekit/media/capabilities` | LED 启动时检查 media/token/recording/sip/web-assist 能力和配置状态 | P2 |
| `GET /api/ivekit/media/openapi.json` 或静态文档 | 给 LED 研发和测试工具消费 | P2 |
| recording signed download API | 生产环境不能只返回内部 storage URL | P3 |
| recording retention/export API | 录制证据需要生命周期和导出能力 | P3 |

### 4.3 IM 已有 API

| Method | Path | 用途 | 目标状态 |
|---|---|---|---|
| `POST` | `/api/collaboration/sessions` | 创建协作会话 | 保留 |
| `GET` | `/api/collaboration/sessions/by-ref` | 按业务对象查会话 | 保留 |
| `POST` | `/api/collaboration/sessions/:id/participants` | 加参与人并授权 Tinode topic | 保留 |
| `POST` | `/api/collaboration/sessions/:id/participants/leave` | 离开/移除参与人 | 保留 |
| `POST` | `/api/collaboration/sessions/:id/chat/bind` | 绑定 Tinode topic | 保留 |
| `POST` | `/api/collaboration/sessions/:id/chat/client-plan` | 获取 Tinode 浏览器连接计划 | 保留，需真联调 |
| `GET` | `/api/collaboration/sessions/:id/chat` | 获取 snapshot | 保留 |
| `GET` | `/api/collaboration/sessions/:id/messages` | 查历史消息 | 保留 |
| `POST` | `/api/collaboration/sessions/:id/messages` | 发送文本/附件元数据消息 | 保留 |

### 4.4 IM 计划新增/补强 API

| API | 原因 | 阶段 |
|---|---|---|
| `/api/ivekit/chat/*` facade | LED 不应直接吃 OPC collaboration 内部路径 | P6 |
| `POST /api/ivekit/chat/attachments/presign` | 图片、语音、文件上传前签名 | P8 |
| `POST /api/ivekit/chat/attachments/:id/extracted-text` | OCR/ASR 服务回填文本并触发重新扫描 | P8 |
| `GET /api/ivekit/chat/policy-events` | LED 管理端查看防绕单事件 | P9 |
| `POST /api/ivekit/chat/policy-events/:id/review` | 人审、误报、处置闭环 | P9 |
| `GET /api/ivekit/chat/openapi.json` 或静态文档 | LED 研发对接 | P6 |

---

## 5. 数据与迁移目标

### 5.1 已有迁移

| 迁移 | 作用 |
|---|---|
| `011_collaboration_remote_assistance.sql` | Collaboration、remote assistance、consent、audit、evidence |
| `012_livekit_participants.sql` | LiveKit participant tracking |
| `013_media_recording_business_ref.sql` | recording business_ref |
| `016_collaboration_chat_bindings.sql` | chat provider topic binding |
| `017_collaboration_message_attachments.sql` | message attachments |

### 5.2 计划新增迁移

| 迁移目标 | 字段/语义 | 阶段 |
|---|---|---|
| IM provider delivery state | message provider status、retry count、last error、next retry at | P7 |
| Tinode inbound sync cursor | topic、last seq、last sync time、sync status | P7 |
| attachment processing jobs | attachment id、provider、job status、attempts、result text hash | P8 |
| policy findings | 来源 text/OCR/ASR/AI，severity，evidence refs，review status | P9 |
| message receipts/presence | delivered/read/typing/presence mirror | P10，可后置 |
| recording retention/export | retention policy、export status、download audit | P3 |

### 5.3 数据库原则

1. 继续使用 PostgreSQL，不引入 SQLite。
2. 新表必须带 `tenant_id`，并纳入 RLS/基线 schema。
3. 所有业务对象统一使用 `business_ref_type` + `business_ref_id`。
4. Tinode、LiveKit、MinIO 只作为 provider，不成为 OPC/LED 的唯一事实源；OPC 本地镜像保存审计和风控所需最小事实。

---

## 6. 分阶段实施计划

### Phase 0: 范围冻结与状态校准

目标：暂停 RustDesk 扩展，冻结当前实现状态，后续只按本计划推进 LiveKit/IM。

**Files:**
- Modify: `docs/livekit-im-full-capability-plan.md`
- No production code changes

- [ ] Step 1: 明确本轮不继续扩 RustDesk，除非阻塞 Web Assist/LiveKit/IM。
- [ ] Step 2: 对照 `git status --short`，记录当前大量未提交文件不是本阶段新增风险。
- [ ] Step 3: 以本计划作为后续开发的唯一入口。

**Verification:**
- Run: `git diff --check docs/livekit-im-full-capability-plan.md`
- Expected: no whitespace errors.

### Phase 1: LiveKit 部署 preflight 与 env checklist

目标：服务器上传前先能检查 LiveKit/Media 所需环境，生成脱敏 checklist/report，避免到服务器后靠人工猜缺什么。

**Status:** 工作区已出现本阶段实现和测试。后续只补漏，不重复发散；服务器真实执行记录仍未纳入本文完成状态。

**Files:**
- Create: `scripts/livekit-deployment-preflight.ts`
- Create: `test/livekit-deployment-preflight.test.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `infra/env.example`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`

**核心要求:**
- 校验 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`。
- 校验 `OPC_BASE_URL`、`OPC_MEDIA_API_TOKEN`、`OPC_MEDIA_INVITE_SECRET`。
- 校验 `OPC_MEDIA_SMOKE_TENANT_ID` 或 `OPC_TENANT_ID`。
- 校验 MinIO/Egress 必要 key，不泄漏 secret value。
- 根据 `OPC_VIDEO_READINESS_TARGETS` 补充浏览器、Web Assist、SIP/VoLTE 变量提示。
- 输出 JSON report 和 Markdown checklist。
- 不替代真实 `npm run smoke:media:readiness`，只做部署前环境门禁。

**TDD steps:**
- [ ] Step 1: 写 `test/livekit-deployment-preflight.test.ts`，覆盖缺 env、通过 env、secret 脱敏、文件输出、package script、env example。
- [ ] Step 2: 运行 `node --import tsx --test --test-reporter=dot test/livekit-deployment-preflight.test.ts`，确认失败原因是脚本不存在。
- [ ] Step 3: 实现 `scripts/livekit-deployment-preflight.ts`。
- [ ] Step 4: 增加 `npm run livekit:deployment-preflight`。
- [ ] Step 5: 更新 `.env.example` 和 `infra/env.example`。
- [ ] Step 6: 更新详细设计文档中的 LiveKit 验收路径。
- [ ] Step 7: 重新运行本阶段测试。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/livekit-deployment-preflight.test.ts`
- `npm run typecheck`
- `git diff --check`

### Phase 2: LiveKit LED facade 与 API 契约

目标：给 LED 一个稳定的 `/api/ivekit/media/*` 对接面，保留现有 `/api/media/livekit/*` 作为内部/兼容入口。

**Status:** 工作区已出现 media facade 基础实现。`openapi.json` 或等价静态 contract 输出仍是本阶段遗留项。

**Files:**
- Create: `src/agent-runtime/ivekit/media-http.ts`
- Create: `test/ivekit-media-facade.test.ts`
- Modify: `src/http.ts`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`

**核心要求:**
- facade 支持 room、join、participants、recordings、capabilities。
- facade 仍调用 `LiveKitMediaModule`，不复制业务逻辑。
- facade 使用 OPC/LED 平台鉴权和 tenant context。
- response shape 固定，错误码固定。
- 输出能力矩阵：`rooms=true`、`recording=true/false`、`sip=planned/ready`、`web_assist=true/false`。

**TDD steps:**
- [ ] Step 1: 写 facade contract test，先断言 `/api/ivekit/media/capabilities`、room create、join plan、recording start 的响应。
- [ ] Step 2: 运行测试确认失败。
- [ ] Step 3: 新增 route 文件并复用 `routeMediaApi()` 或 `createLiveKitMediaModule()`。
- [ ] Step 4: 接入总 HTTP router。
- [ ] Step 5: 更新文档 API 表。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/ivekit-media-facade.test.ts test/livekit-media-http.test.ts test/livekit-media-module.test.ts`
- `npm run typecheck`

### Phase 3: Recording/Egress 生产闭环

目标：录制不只创建 DB row，还要能证明对象存储可写、可读、可导出、可审计。

**Status（2026-07-10）：** 本地代码闭环已完成，真实 LiveKit Egress + MinIO/S3 服务器验收待执行。受控导出采用鉴权后的服务端下载；S3 presigned URL/CDN 可作为后续优化，不阻塞第一版。

**Files:**
- Modify: `src/agent-runtime/livekit/recording-service.ts`
- Modify: `src/agent-runtime/media-recording-evidence.ts`
- Modify: `src/agent-runtime/media-recording-object.ts`
- Modify: `src/agent-runtime/livekit/media-http.ts`
- Modify: `src/agent-runtime/ivekit/media-http.ts`
- Create: `src/migrations/026_media_recording_lifecycle.sql`
- Create: `test/livekit-recording-retention-export.test.ts`
- Modify: `scripts/livekit-media-smoke.ts`

**核心要求:**
- [x] recording start 返回 `s3://` storage URL、business_ref、生命周期、retention 和 evidence id；对象 key 含 recording UUID，避免同毫秒并发冲突。
- [x] webhook `egress_ended` 按唯一 `egress_id` 幂等更新同一 recording，重复 webhook 不重复通知完成事件。
- [x] 增加 tenant-scoped 对象可读性检查入口，记录状态、size 和 SHA-256。
- [x] 增加鉴权受控导出和 `media.recording.exported` 审计事件。
- [x] 增加 retention 字段、dry-run/confirm 清理钩子、对象删除、evidence 删除回写和失败后可重试机制；未增加后台 worker。
- [x] Egress 启动失败先留存失败记录；provider 已启动但 DB 写回失败时主动 stop Egress 做补偿。
- [x] OPC 租户合规保留天数通过依赖注入进入 Media Core，Media Core 本身不反向依赖 call-center。
- [x] PostgreSQL migration 增加 lifecycle 字段、egress 唯一索引、retention 索引和 FORCE RLS；生产不使用 SQLite。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/media-recording-evidence.test.ts test/media-recording-object-resolver.test.ts test/livekit-media-http.test.ts`
- `node --import tsx --test test/livekit-recording-retention-export.test.ts test/livekit-media-smoke.test.ts test/livekit-deployment-preflight.test.ts`
- `npm run typecheck`
- 服务器环境执行：设置 `OPC_MEDIA_SMOKE_VERIFY_RECORDING_OBJECT=1` 后运行 `npm run smoke:media`，证明 Egress 对象最终可读且可实际导出；当前本地未冒充该项通过。

### Phase 4: LiveKit Browser/Web Assist 验收补强

目标：浏览器端能真实进入房间、显示客户/坐席/屏幕共享状态，Web Assist 录屏和 consent 门禁可验收。

**Files:**
- Modify: `scripts/livekit-browser-smoke.ts`
- Modify: `scripts/livekit-customer-browser-smoke.ts`
- Modify: `scripts/web-assist-browser-smoke.ts`
- Modify: `frontend/src/pages/video-call-join.ts`
- Modify: `frontend/src/pages/RemoteAssistPage.tsx`
- Test: `test/livekit-browser-smoke.test.ts`
- Test: `test/livekit-customer-browser-smoke.test.ts`
- Test: `test/web-assist-browser-smoke.test.ts`
- Test: `test/video-call-join-contract.test.ts`

**核心要求:**
- 客户 H5 失败态明确：签名过期、token 缺失、LiveKit URL 缺失、房间关闭。
- 坐席浏览器 smoke 检查双方 connected。
- 屏幕共享 smoke 检查 screen track 或页面状态。
- Web Assist smoke 检查 consent grant 后才能 join media、recording、event。
- 所有浏览器 smoke 不在本地沙箱冒充真实 LiveKit，通过脚本契约测试和服务器 Playwright 真跑分开。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/livekit-browser-smoke.test.ts test/livekit-customer-browser-smoke.test.ts test/web-assist-browser-smoke.test.ts test/video-call-join-contract.test.ts`
- 服务器环境执行：`npm run smoke:media:readiness`

### Phase 5: SIP/VoLTE 真实桥接计划

目标：把当前 readiness 提升为可执行的 SIP/VoLTE 验收计划，但不把它挡在 LiveKit/IM 主线前面。

**Files:**
- Modify: `scripts/sip-volte-readiness.ts`
- Modify: `src/agent-runtime/media-gateway/adapters/sip-volte-gateway.ts`
- Create: `test/sip-volte-gateway-contract.test.ts`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`

**核心要求:**
- 明确 LiveKit SIP bridge、RustPBX trunk、RWI endpoint、tenant、room 的映射。
- readiness 输出可交付 dial plan。
- gateway adapter 给出 join plan 或 planned state，不假装真实拨通。
- 真实呼叫接通、DTMF、录音、挂机、失败码在服务器/电话环境验收。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/sip-volte-readiness.test.ts`
- 服务器环境执行：`npm run smoke:media:sip-volte`

### Phase 6: IM/Tinode 部署 preflight、facade 与 OpenAPI

目标：LED 可以通过稳定 `/api/ivekit/chat/*` 对接 IM，不直接理解 Tinode 内部协议。

**Status:** 本地代码已完成（2026-07-10）。Tinode preflight 、`/api/ivekit/chat/*` facade、主路由注册、详细 Markdown 契约和聚焦测试已落地；真实 Tinode 服务器、浏览器 SDK join 与生产凭据策略仍待服务器验收。

**Files:**
- Create: `scripts/tinode-deployment-preflight.ts`
- Create: `test/tinode-deployment-preflight.test.ts`
- Create: `src/agent-runtime/ivekit/chat-http.ts`
- Create: `test/ivekit-chat-facade.test.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `infra/env.example`
- Modify: `docs/iveKit视频IM通用能力详细设计.md`

**核心要求:**
- preflight 校验 `TINODE_BASE_URL` 或 `TINODE_WS_URL`、`TINODE_API_KEY`、root auth/basic auth、`TINODE_USER_PASSWORD_SECRET`。
- facade 支持 session open/by-ref、bind、client-plan、participants join/leave、messages list/post、snapshot。
- facade 响应不暴露不该暴露的 Tinode root auth。
- OpenAPI/Markdown contract 明确请求、响应、错误码。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/tinode-deployment-preflight.test.ts test/ivekit-chat-facade.test.ts test/collaboration-http.test.ts test/tinode-chat-smoke.test.ts`
- `npm run typecheck`

### Phase 7: Tinode 消息可靠性与条件式入站同步

目标：解决当前最大 IM 架构风险：如果浏览器直接用 Tinode SDK 发消息，OPC 本地镜像、防绕单、审计可能看不到。

**Recommended decision:** 第一版生产策略是“所有业务消息必须通过 OPC/iveKit facade 发送”；Tinode SDK 只负责实时连接、收消息、typing/presence。若 LED 强要求客户端直接发 Tinode，则必须先完成 sync worker。

**Status:** Phase 7A durable outbound 本地代码已完成（2026-07-10）。消息先进入 PostgreSQL 并完成 policy scan，再通过 claim lease 发布 Tinode；失败进入退避、到期由后台 worker 重试，attempt 历史可查询。`direct_client_publish=false` / `provider_inbound_sync=false` 仍是明确门禁，因此 Phase 7B inbound seq/cursor worker 尚未启动，也没有被误报为完成。

**Files:**
- Create: `src/agent-runtime/collaboration/tinode-sync-worker.ts`
- Create: `src/agent-runtime/collaboration/tinode-message-delivery.ts`
- Create: `test/tinode-sync-worker.test.ts`
- Create: `test/tinode-message-delivery.test.ts`
- Modify: `src/agent-runtime/collaboration/chat-gateway.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-store.ts`
- Create: `src/migrations/025_collaboration_message_delivery.sql`

**Phase 7A 已完成:**
- 本地消息、附件和 idempotency key 先持久化，再执行 policy scan 和 provider publish。
- `pending/publishing/retry_wait/delivered/failed` 状态、attempt count、claim lease、最后错误和 delivered time 是显式字段。
- `collaboration_message_delivery_attempts` 保留每次 started/delivered/retry_wait/failed/lease_expired 历史并启用 FORCE RLS。
- `Idempotency-Key` 防止 LED/OPC HTTP 重试重复创建本地消息或重复扫描。
- worker 按 PostgreSQL due queue 自动重试，多副本通过 claim token 防止旧回包覆盖新 claim。
- Tinode `pub.head` 携带稳定 OPC message ID / idempotency key，供后续审计和入站去重使用。
- claim lease 必须覆盖五段 provider timeout 加 1 秒；preflight、Compose 和 K8s 已接入。
- root token、API key、basic password 和用户密码派生 secret 不写入消息、attempt、API 响应或 worker 日志。

**Phase 7B 条件式待办:**
- 只有产品决定把 `direct_client_publish` 改为 `true` 时，才按 topic 维护 last seq/cursor。
- 届时 Tinode inbound `data` 必须按 provider topic + seq 幂等写入 `collaboration_messages` 并触发 `scanPolicy()`。
- Phase 7B 完成前，浏览器 SDK 只能收消息、typing/presence，不能发布业务消息。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/tinode-message-delivery.test.ts test/tinode-sync-worker.test.ts test/tinode-deployment-preflight.test.ts test/collaboration-chat.test.ts test/ivekit-chat-facade.test.ts test/collaboration-http.test.ts test/tinode-chat-smoke.test.ts`

### Phase 8: 附件上传、OCR、ASR 处理链

目标：图片、语音、视频附件能走对象存储，OCR/ASR 提取结果重新进入防绕单和质检。

**Status:** 本地代码已完成（2026-07-10）。已实现受限二进制上传、对象引用、PostgreSQL durable job、claim lease、重试/终态、OCR/ASR 自建与第三方 HTTP adapter、提取文本回填、policy 重扫、后台 worker、iveKit facade、部署参数和静态 preflight。真实 OCR/ASR、真实对象存储和多副本负载仍待服务器验证。

**Files:**
- Create: `src/agent-runtime/collaboration/attachment-processing.ts`
- Create: `src/agent-runtime/collaboration/ocr-provider.ts`
- Create: `src/agent-runtime/collaboration/asr-provider.ts`
- Create: `test/collaboration-attachment-processing.test.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-http.ts`
- Create: `src/migrations/027_collaboration_attachment_processing.sql`

**Provider strategy:**
- Third-party mode: 通过 HTTP adapter 调用外部 OCR/ASR，配置 base URL、token、timeout。
- Self-host mode: 通过 adapter 调本地服务或队列 worker，接口保持一致。
- 第一版不绑定具体 OCR/ASR 厂商；只实现 provider interface、job 状态、回填入口和扫描闭环。

**核心要求:**
- 生成上传签名或本地 upload endpoint。
- 附件写入 `collaboration_message_attachments`。
- OCR/ASR 回填 `extracted_text`、`ocr_text`、`asr_text`。
- 回填后重新扫描政策，生成 policy event/finding。
- 图片手机号、二维码文本、语音号码都统一进入同一套 policy pipeline。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/collaboration-attachment-processing.test.ts test/collaboration-http.test.ts test/collaboration-chat.test.ts`

### Phase 9: 防绕单与 AI 质检闭环

目标：从“规则扫描事件”升级为“可审计、可复核、可处置”的质检 finding。

**Status:** 本地代码已完成（2026-07-10）。规则文本、OCR、ASR、AI 已统一进入 finding；AI job 采用 PostgreSQL/RLS、内容哈希、claim lease、退避和后台 worker；人工复核带状态机、行锁和不可变审核记录。AI 只生成 `action=review` 的辅助 finding，provider 建议保留在脱敏 metadata 中，不直接执行不可逆业务动作。真实自建/第三方模型效果与吞吐仍待服务器验证。

**Files:**
- Create: `src/agent-runtime/collaboration/policy-finding-store.ts`
- Create: `src/agent-runtime/collaboration/quality-review.ts`
- Create: `src/agent-runtime/collaboration/quality-review-worker.ts`
- Create: `test/collaboration-policy-finding.test.ts`
- Create: `scripts/quality-review-preflight.ts`
- Modify: `src/agent-runtime/collaboration/policy-scan.ts`
- Modify: `src/agent-runtime/collaboration/collaboration-http.ts`
- Create: `src/migrations/028_collaboration_policy_findings.sql`
- Create: `src/migrations/029_collaboration_quality_review.sql`

**核心要求:**
- 统一来源：text、OCR、ASR、AI。
- 保存 matched text hash，不保存敏感原文全文。
- 支持 severity、action、evidence refs、review status。
- 支持人审：confirm false_positive resolved escalated。
- 支持 AI provider 两种模式：第三方 LLM 与自建 LLM。
- 第一版 AI 质检做辅助判定，不绕过规则扫描和人审。
- API 覆盖 finding 列表/详情/复核、message quality-review 入队/查询和租户级 due batch；iveKit facade 提供同构路径。
- Worker 在 OCR/ASR 回填后按新内容哈希重新入队，旧输入不会送给 provider。
- rationale、review note 和自由格式 metadata 会脱敏手机号/邮箱；任务表不保存输入原文。

**Verification:**
- `node --import tsx --test --test-reporter=dot test/collaboration-policy-finding.test.ts test/collaboration-attachment-processing.test.ts test/ivekit-chat-facade.test.ts test/collaboration-http.test.ts`
- `npm run quality:deployment-preflight`（配置静态预检，不代表真实 provider 已通过）

### Phase 10: IM 高级状态

目标：补齐用户体验相关状态，但不阻塞第一版交付。

**Status:** 本地代码已完成（2026-07-10）。P10A-P10D 已落地：PostgreSQL/RLS receipt、未读、TTL 状态、限时 edit/soft delete、mutation hash audit、iveKit facade、租户 WebSocket 事件、官方 `tinode-sdk@0.25.1` 浏览器 receive-only adapter 和页面状态消费。Tinode topic 用户只授予 `JRP`，不含 `W`；JWT 身份不能冒用他人领取 client-plan 或发消息。真实 Tinode、真实浏览器双端、真实 PostgreSQL migration/RLS、多实例 Redis 广播仍待服务器验证。

**Architecture decision (2026-07-10):**
- provider 的 publish ack 继续只表示“Tinode 已接受”，不冒充收件人 delivered/read。
- delivered/read 以参与人维度持久化到 PostgreSQL/RLS，可按目标消息推进并计算 unread count。
- typing/presence 是带 TTL 的会话状态，通过 iveKit API 和租户 WebSocket/Redis 广播；不写永久逐次审计。
- edit/delete 只允许发送者在配置时间窗内操作文本消息；删除为软删除，原始 `body` 保留，外部读取使用 current body；每次 mutation 写不可变哈希审计。
- 浏览器 Tinode SDK 只负责接收、typing/presence/read note 等实时协议；业务消息仍经 iveKit facade，`direct_client_publish=false` 不变。
- Tinode 客户端 topic mode 固定为 `JRP`；`W` 权限只保留给后端管理/投递身份，防止绕过本地镜像、防绕单和质检。
- edit/delete 当前只更新 PostgreSQL 本地镜像并通过 OPC WebSocket 广播；不伪装成 Tinode 原生消息变更已完成。

**Files:**
- Modify: `src/agent-runtime/collaboration/chat-gateway.ts`
- Create: `src/agent-runtime/collaboration/message-state-store.ts`
- Create: `src/migrations/030_collaboration_message_state.sql`
- Modify: `frontend/src/pages/CollaborationChatPage.tsx`
- Create: `frontend/src/pages/tinode-realtime.ts`
- Create: `test/collaboration-message-state.test.ts`
- Create: `test/tinode-realtime-adapter.test.ts`

**能力:**
- P10A: per-participant delivered/read receipts、read-through、unread count。
- P10B: typing/presence TTL state、iveKit API、跨实例 WebSocket 广播。
- P10C: sender-only edit/delete window、soft delete、mutation audit。
- P10D: 官方 Tinode browser SDK adapter；禁止业务消息直发门禁测试。

**Local verification:**
- Collaboration/Tinode/OCR/ASR/质检/远协相关回归：176/176。
- 根目录 `npm run typecheck`：通过。
- 两份 Compose `config --quiet`：通过。
- 前端全量 `tsc --noEmit`：最终门禁已通过。收口时同时修正了 Remote Assist Canvas context/payload 的结构类型和 VideoCall LiveKit URL 显式收窄，并通过 31 项 RemoteAssist/VideoCall 回归。

**Priority:** 低于 OCR/ASR/质检和 LiveKit 生产验收。

### Phase 11: 抽包/独立服务交接

目标：让 LED 项目能低成本复用，而不是复制 OPC 业务代码。

**Status:** 本地交接代码与文档已完成（2026-07-10）。新增无 store/数据库/provider import 的 `createIveKitHttpSdk`，覆盖 Media + Chat 全部稳定 facade；RustDesk 继续复用已有高层 LED SDK。新增可运行 LED 串联示例、API/事件契约、部署拓扑、migration/RLS 清单、抽离文件边界和真实验收矩阵。当前没有机械创建 `packages/ivekit-*` 或搬服务端目录，因为 HTTP 边界已经可独立复用，而服务端搬迁必须连 migration、tenant context、workers 和事件总线一起完成。

**Files:**
- Create: `docs/ivekit-led-integration-guide.md`
- Create: `docs/ivekit-openapi.md`
- Create: `src/agent-runtime/ivekit/http-sdk.ts`
- Create: `scripts/ivekit-led-integration-example.ts`
- Create: `test/ivekit-http-sdk.test.ts`
- Create: `test/ivekit-led-integration-example.test.ts`
- Candidate package target after facade stabilization: `packages/ivekit-media/`
- Candidate package target after facade stabilization: `packages/ivekit-chat/`
- Candidate service target after API stabilization: `services/ivekit-media-collaboration/`

**交付内容:**
- HTTP API contract。
- env checklist。
- Docker Compose/K8s 依赖清单。
- smoke 命令清单。
- LED 后端对接时序图。
- LED 前端 join/chat/client-plan 用法。
- 数据库迁移清单。
- 已验证/未验证矩阵。

**抽离策略:**
- 短期：不迁目录，稳定 module public entry 和 HTTP facade。
- 中期：抽 `packages/ivekit-media`、`packages/ivekit-chat`，但数据库接口仍通过 adapter 注入。
- 长期：独立 `ivekit-collaboration-service`，OPC 和 LED 都通过 HTTP/gRPC 消费。

**Local verification:**
- HTTP SDK 文件边界、方法面、API key/Bearer 身份、路径、幂等 header、附件/录制二进制和结构化错误：3/3。
- LED 示例实际执行 Media + Chat 五步 fake fetch 序列且不输出 secret：1/1。
- iveKit Media/Chat facade + HTTP SDK + RustDesk LED SDK 聚焦回归：16/16。
- LiveKit/Recording/Browser/Web Assist/Collaboration/Tinode/iveKit/RustDesk/Remote/SIP 综合本地回归：594/594。
- 根目录和 frontend `tsc --noEmit`：均通过。
- 两份 Compose `config --quiet` 与 `git diff --check`：通过。

---

## 7. 优先级排序

| 优先级 | 阶段 | 原因 |
|---|---|---|
| P0 | Phase 1 LiveKit deployment preflight | 立刻降低服务器验证成本 |
| P0 | Phase 2 LiveKit facade/API contract | LED 对接需要稳定入口 |
| P0 | Phase 6 IM preflight/facade | IM 完整集成的入口 |
| P0 | Phase 7 Tinode sync 策略裁决 | 防绕单不能漏消息 |
| P1 | Phase 3 Recording production closure | 视频证据链必须能验收 |
| P1 | Phase 4 Browser/Web Assist | 真实体验验收 |
| P1 | Phase 8 OCR/ASR attachment chain | LED 防绕单核心 |
| P1 | Phase 9 AI 质检闭环 | LED 质检核心 |
| P2 | Phase 5 SIP/VoLTE | 重要但不阻塞 LED IM/视频主线 |
| P2 | Phase 10 IM 状态 | 体验增强 |
| P2 | Phase 11 抽包/服务化 | 基础能力稳定后再做 |

推荐实际开发顺序：

1. Phase 6
2. Phase 7
3. Phase 3
4. Phase 4
5. Phase 8
6. Phase 9
7. Phase 11
8. Phase 5 / Phase 10 按业务需要穿插

Phase 1 和 Phase 2 已经在工作区出现代码结果，但仍保留在本文中作为背景和服务器验收依据。

---

## 8. 验收标准

### 8.1 本地代码验收

每次阶段提交前至少运行：

```bash
npm run typecheck
git diff --check
```

按阶段运行对应聚焦测试，不用每次都跑全仓库所有测试。

### 8.2 LiveKit 服务器验收

服务器部署后至少运行：

```bash
npm run livekit:deployment-preflight
npm run render:media-configs
npm run smoke:media
npm run smoke:media:readiness
```

如果只验证后端，不跑浏览器：

```bash
OPC_VIDEO_READINESS_TARGETS=media,ai-callback,collaboration npm run smoke:media:readiness
```

如果验证 Web Assist：

```bash
OPC_VIDEO_READINESS_TARGETS=media,web-assist-browser,collaboration npm run smoke:media:readiness
```

### 8.3 Tinode/IM 服务器验收

服务器部署后至少运行：

```bash
npm run tinode:deployment-preflight
npm run smoke:chat:tinode
npm run smoke:collaboration
```

完成 facade 后补：

```bash
node --import tsx --test --test-reporter=dot test/ivekit-chat-facade.test.ts
```

### 8.4 LED 对接验收

LED 研发拿到交付包后，必须能完成：

1. 创建业务订单 `business_ref=service_order/<order_id>`。
2. 创建 collaboration session。
3. 创建 LiveKit room 并拿到客户 join path。
4. 客户通过 signed invite 加入视频。
5. 坐席/工程师加入视频。
6. 开始/停止录制，查询 evidence。
7. 创建 Tinode chat binding。
8. 获取 chat client plan。
9. 发送文本消息并触发防绕单扫描。
10. 上传图片/语音附件并回填 OCR/ASR 文本。
11. 查询 policy finding 并执行人审。

---

## 9. 关键风险与裁决

| 风险 | 裁决 |
|---|---|
| 浏览器直接发 Tinode 消息导致 OPC 防绕单漏扫 | 第一版强制业务消息走 OPC facade；若要客户端直发 Tinode，先做 sync worker |
| 真实 LiveKit/Tinode 未部署却误报完成 | 所有 smoke/readiness 区分“本地 fake 测试”和“服务器真实验收” |
| 功能边界过大导致继续发散 | RustDesk 扩展暂停；数字人细节后置；先 Media Core + IM Core |
| OCR/ASR 供应商未定 | 先做 provider interface、job、回填、扫描闭环；第三方和自建都按同一契约接 |
| SQLite 被误引入 | 明确继续 PostgreSQL + RLS |
| LED 直接耦合 OPC 内部路径 | 增加 `/api/ivekit/media/*` 和 `/api/ivekit/chat/*` facade |
| 录制对象只写 DB 不可读 | Phase 3 明确补对象读/导出/retention 验收 |
| AI 质检误判影响业务 | AI finding 默认进入人审，不直接做不可逆处置 |

---

## 10. 下一步

Phase 3、4、6、7A、8、9、10 已按 TDD 落地并通过本地代码验证。下一段进入 Phase 11 对接/抽离交付：

1. 稳定 iveKit OpenAPI/Markdown 契约、最小 SDK 和 LED 对接时序。
2. 形成 Media、Chat、Remote 三个可抽离边界和部署/迁移清单，但暂不为搬目录而搬目录。
3. 保持 `direct_client_publish=false` 和客户端 `JRP`；只有明确改变该产品裁决时，才回到 Phase 7B 实现 inbound seq/cursor sync。
4. 服务器环境到位后集中执行 LiveKit/Tinode/RustDesk/OCR/ASR/AI provider 的真实验收，不把当前本地结果写成真实环境通过。

服务器环境到位后，Phase 6/7A 仍必须执行 `npm run tinode:deployment-preflight`、`npm run smoke:chat:tinode`、真实浏览器 Tinode SDK join，并观察 PostgreSQL delivery queue 从创建到 delivered；本地 fake Tinode 和 MemoryPg 测试不替代这些部署证据。

### 10.1 2026-07-10 本地部署加固补记

在不上传服务器的前提下，已补齐下一次真实验收所需的基础编排：

1. 本地 Compose 增加 PostgreSQL 版 `tinode/tinode`；production 通过 `infra/docker-compose.tinode.yml` 自建 overlay 启用，base Compose 保留给外部/共享 Tinode，避免两种部署模式互相要求配置。
2. LiveKit 统一映射 `7881/tcp` 和 `7882-7892/udp`，生产渲染支持 `use_external_ip=true`。
3. Egress 使用与 LiveKit 相同 Redis，并按 `storage.s3` 配置对象存储。
4. Tinode preflight 新增 `external/self_hosted` 模式；自建模式缺 PostgreSQL DSN、32 字节 auth key 或 16 字节 UID key 时直接失败，所有生产模式都要求公网 WSS，报告不泄密；production overlay 对三项 server runtime 配置采用 required interpolation。

这只推进了 Phase 1/6 的部署准备，不改变真实完成定义。PostgreSQL volume 与 MinIO bucket 的代码级初始化门禁已在 2026-07-11 继续补齐，见下一节；TURN/NAT、Tinode K8s 和本文件第 8 节全部真实验收仍未完成。

### 10.2 2026-07-11 production bootstrap 补记

在继续遵守“不上传服务器”的前提下，Option A 的本地实现已经完成：

1. 新增 `infra/scripts/bootstrap-postgres-databases.sh`，只接受 `opc/keycloak/tinode/chatwoot` 固定白名单且要求 owner 为 `opc`；production base 幂等确认 `keycloak`，自建 Tinode overlay 扩展为 `keycloak,tinode`，existing volume 不会被删除或重置。
2. 新增 `infra/scripts/bootstrap-minio-bucket.sh`，对 endpoint 有界重试，使用 `mb --ignore-existing` 创建录制 bucket，执行 `anonymous set none`，回读确认 private 并用 `stat` 验证存在。
3. production Compose 新增 `postgres-bootstrap` 与 `minio-init` one-shot 服务。PgBouncer/Keycloak/Tinode 等待数据库 bootstrap 成功；OPC 等待经过 PgBouncer 6432 的认证 `psql SELECT 1` 成功；Egress/RustPBX/OPC 等待 bucket bootstrap 成功。
4. Chatwoot 放入显式 `omnichannel` profile，不再进入默认 iveKit startup/readiness。其 image pin、pgvector、`db:chatwoot_prepare`、Sidekiq、升级/回滚仍是独立生产化任务，没有被误报完成。
5. fake `psql`/`mc` 行为测试覆盖首次创建、重复幂等、白名单/输入拒绝、有限重试、秘密不出现在进程输出、bucket private 回读和 `stat` 失败；静态 Compose 契约与 external/self-hosted/profile 渲染门禁均已执行。

本节只把“数据库和 bucket 初始化在代码中缺失”改为“代码与配置已具备”。真实 PostgreSQL fresh/existing-volume 创建、PgBouncer 连接、MinIO bucket 私有性和持久化、LiveKit Egress 对象写入、服务重启恢复以及端到端服务器执行仍为未验证项，persistent deployment/E2E goal 继续保持开放。

### 10.3 2026-07-11 LiveKit production edge 补记

LiveKit 第一版的代码级生产网络缺口已经按独立 Media Core 方向收口：

1. `LIVEKIT_URL` 只承担 OPC、AI Agent、RoomService、Egress 等服务端连接；新增 `LIVEKIT_PUBLIC_URL` 专供浏览器 Join Plan。生产必须显式使用 `wss://`，不会回退到容器内地址。
2. capabilities 新增内部服务配置、公网地址配置和浏览器 join readiness 三类布尔状态，不返回 URL 或密钥。
3. preflight 现在区分 `external`、`standalone-vm`、`bundled-dev`，分别检查内部地址、公网 WSS、独立 VM 域名/ACME 邮箱和固定镜像版本。离线报告继续脱敏，也不把静态检查冒充网络验收。
4. `infra/livekit/` 已形成 OPC 无关的 Linux host-network 部署包，包含 LiveKit 内置 TURN、Caddy L4 SNI 分流、Redis、Egress、健康检查、配置渲染和防火墙清单。
5. production Compose 默认外置 Media Core；内置 Server/SIP/Egress 放入 `media-bundled` profile。Kubernetes 默认关闭仓库内 bundled LiveKit，生产要求外部地址和公网地址，媒体节点应使用官方 LiveKit Helm chart。
6. K8s Egress 模板已改为当前 `logging`、`redis`、`health_port`、`storage.s3` schema，并增加 `SYS_ADMIN` 与健康检查；镜像版本固定为 Server `v1.13.3`、Egress `v1.13.0`、SIP `v1.6.0`、Caddy L4 `v2.11.3`、Redis `7.4.9`。
7. production Token 服务在 LiveKit 内部地址/key/secret 不完整时 fail-closed，不再产生 dev token；Compose 与 Helm 同样在解析/渲染阶段要求真实凭据。preflight 拒绝示例占位密钥，并校验 standalone signal/turn 域名不同且 ACME 邮箱合法。

本地专项测试、TypeScript 检查和 Compose 静态解析已经通过。Docker daemon 当前未运行，Helm CLI 当前未安装，因此镜像启动和 Helm render 没有被声明为通过。DNS、证书、WSS、ICE UDP/TCP、强制 TURN、双浏览器音视频/屏幕共享、Egress 对象写入、多副本和性能仍属于服务器验收，且遵守用户当前“不上传服务器”的约束。
