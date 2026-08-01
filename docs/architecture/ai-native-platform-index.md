# Converact Platform、Engage、Agent Runtime 与 Resolve 文档清单

## 平台级当前总纲

[《Converact AI-native 多模态通信与业务执行平台：平台范围、领域模型与产品组合 R2》](../design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)

| 属性 | 当前值 |
| --- | --- |
| 文档状态 | `accepted_scope_direction` |
| SHA-256 | 由 `goals/manifest.json` 的 R2 source artifact 固定 |
| 用户批准 | 平台不能被首个售后场景限制的方向已明确 |
| R2 实施授权 | `false`；按逐个 Goal 启动 |
| R2 生产资格 | `false` |
| 未证明能力 | `not_run` |

R2 决定 Converact Platform 是 AI-native 多模态通信与业务执行平台，并以
Converact Fabric、Converact Engage、Converact Agent Runtime 和 Converact Resolve
形成清晰产品边界；领域层采用 Horizontal Platform、
Engagement Profile、Product Offer 和 Deployment Option 四层结构，并以 Engagement/
EngagementItem 作为 Resolution、客户服务、Agent、咨询、运营和未来 Profile 的共同上位
模型。

## 首个垂直产品 Profile

[《Converact Resolve：首个垂直产品 Profile 与演化方案 R1》](../design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md)

R1 保留出口设备安装/售后 ICP、固定 Pilot、B1 翻译、Evidence、ResolutionItem、
OutcomeClaim、ROI、定价和商业停止条件。它不再定义 Converact 的全部平台类别；其
`Resolution/ResolutionItem` 分别映射 R2 的 `Engagement/EngagementItem`。

## 通信约束和实现参考

- [通信底座 R5](../design/unified-communication-foundation-r5.md)
- [ADR-CCAAS-9](../adr/ccaas-9-channel-agent-and-speech-runtime.md)
- [ADR-CCAAS-10](../adr/ccaas-10-vilte-livekit-av-participant-gateway.md)
- [RustPBX × rvoip R4](../design/rvoip-converact-communication-foundation-integration-design.md)
- [VOS5000/100K 计划](../design/communication-foundation-vos5000-parity-performance-plan.md)

R5 继续决定通信实现边界，R2 决定平台/领域上位边界，R1 决定首个 Resolve Profile。
G00/G01 必须建立新的 machine contract、traceability 和迁移计划，不能靠自然语言假定
三者已经完成代码映射。

## 旧文档边界

旧 `ainative.md`、超级联络中心愿景、`architecture-v3.md`、旧 Master Plan 和
VoiceAgentSpec 只保留历史/现状参考价值，不与 R2 并列为平台 Authority。它们可作为未来
Profile 的需求来源，但必须经过独立市场/领域/安全 Gate，不能自动并入 R2。
