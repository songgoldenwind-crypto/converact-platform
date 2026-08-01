# Converact Platform

Converact 是连接人、AI、设备与企业系统的 AI-native 多模态通信与业务执行平台。仓库同时承载产品运行时、通信底座、SDK、基础设施、架构合同、Goal 和可验证证据；设计存在不代表实现或生产资格已经通过。

## 产品组合

```text
Converact Platform
├── Converact Fabric         SIP/PSTN、WebRTC、视频、IM、远程协作与未来 ViLTE 通信底座
├── Converact Engage         Engagement、Interaction、Evidence、Action、Outcome 与业务协作
├── Converact Agent Runtime  跨渠道 Agent、Speech、Context、Tool、Handoff、Evaluation 与治理
└── Converact Resolve        首个 resolution Profile 与可销售垂直 Offer
```

每个域只有一个事实 Authority。Kamailio 保持 SIP Edge；Unified RustPBX 保持电话 Call/Leg/路由 Authority；RTPengine 是普通 RTP/SRTP 性能基线；`voice-media-rs` 处理需要解码的媒体；LiveKit 保持 Room/WebRTC/SFU Authority。rvoip 只能按证据选择性吸收低层能力，不形成第二套 PBX、Call、SIP、媒体或计费权威。

## Canonical 文档

- [统一领域语言](./CONTEXT.md)
- [架构与产品导航](./docs/design/README.md)
- [AI-native 平台与产品 Profile 索引](./docs/architecture/ai-native-platform-index.md)
- [通信底座索引](./docs/architecture/communication-foundation-index.md)
- [Converact Platform 范围、领域模型与产品组合 R2](./docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)
- [Converact Fabric 统一通信底座 R5.1](./docs/design/unified-communication-foundation-r5.md)
- [Converact Resolve Profile R1](./docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md)
- [Goal 00–17 执行总表](./goals/README.md)
- [Goal 机器清单与 SHA-256](./goals/manifest.json)

## 状态纪律

| 主线 | 文档状态 | 实现与生产状态 |
| --- | --- | --- |
| Platform / Engage / Agent Runtime | R2 与 ADR 已冻结目标边界 | 未附直接证据的能力保持 `not_run` |
| Fabric | R5.1 完整继承 R4、G.729、RTPengine、rvoip、Voice↔LiveKit、ViLTE 接口及性能 Gate | `accepted architecture / target`；不等于 `production_eligible` |
| Resolve | 首个 `resolution` Profile、Pilot、B1、Evidence/Outcome 与商业 Gate | `retained_vertical_profile`；不代表整个平台边界或市场资格 |
| Goal 执行线 | G00–G17、依赖、Authority、Gate 和 manifest 齐全 | 初始状态以每个 Goal 和 manifest 为准 |

厂商公开数字、mock、loopback、microbenchmark、旧版本服务器结果和其他 profile 的测试不能借用为 Converact 生产证据。普通语音、解码媒体、Bridge、Agent、翻译、录音、AV 和 mixed-cell 必须分别验收。

## 仓库结构

```text
clients/       参考客户端
docs/          设计、ADR、API、运行手册、容量合同与证据
frontend/      Converact Console
goals/         依赖有序的 Goal 00–17
infra/         Converact 与共享平台基础设施
integrations/  上游精确源码覆盖层与组件接口
sdk/           Converact SDK 与兼容层
services/      独立故障域服务与媒体/Agent 运行时
src/           Converact Platform 服务端核心
test/          合同、单元、集成与验收测试
```

## 开发边界

- 新代码、新配置和新制品使用 `Converact`、`converact-*`、`CONVERACT_*` 或 `CONVERACT_FABRIC_*`。
- 已发布 API 路径、数据库/迁移标识、事件/指标 ID 和精确上游 patch provenance 只有在版本化迁移后才能改变；旧名仅作为明确兼容或历史证据存在。
- 不从本仓库任务修改冻结生产服务器或客户项目。运行时变更必须有独立授权、发布与回滚证据。
- 每次只执行一个 Goal；完整规则见 [PROGRAM-RULES.md](./goals/PROGRAM-RULES.md)。

外部架构资料的原始路径、SHA-256、目标文件和冲突裁决记录在 [架构来源账本](./docs/design/converact-architecture-source-ledger-2026-07-31.md)，不再维护第二份文档权威。
