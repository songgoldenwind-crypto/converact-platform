# OPC AI-native 产品框架文档包

## 1. 唯一当前总纲

[《OPC AI-native 多模态技术问题解决平台：完整产品框架与演化方案 R1》](../../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md)

| 属性 | 当前值 |
| --- | --- |
| 文档状态 | `complete_for_user_review / proposed_for_review` |
| SHA-256 | `1f85fc736dace8029a5cf870f7a576ac4e0f7593b6b89a71bcc46c500bc36264` |
| 独立预审 | 商业、领域、通信/AI 架构三路 blocker-only 复核完成 |
| 用户批准 | `pending` |
| R1 实施授权 | `false` |
| R1 生产资格 | `false` |
| 未证明能力 | `not_run` |

R1 已完整覆盖产品类别、首个 ICP、商业 Offer、Resolution 领域模型、通信/AI Authority、
多模态协作、人工/AI Handoff、Speech Runtime、Agent、Evidence、Action、Outcome、
性能与故障隔离、部署模式及 2026–2031 演化路线。

“完整”表示已经可以进行用户最终评审；不表示 R1 已被批准、冻结、开发或获得生产容量。

## 2. 与通信底座的关系

AI-native R1 不重写 SIP/RTP/WebRTC 基础设施。以下材料作为通信约束和实现候选，只提供
supporting reference，不成为第二套产品 Authority：

- [通信底座 R5](../../docs/design/unified-communication-foundation-r5.md)
- [ADR-CCAAS-9：Channel Agent 与 Speech Runtime](../../docs/adr/ccaas-9-channel-agent-and-speech-runtime.md)
- [ADR-CCAAS-10：ViLTE 与 LiveKit AV Gateway](../../docs/adr/ccaas-10-vilte-livekit-av-participant-gateway.md)
- [RustPBX × rvoip R4 整合设计](../../docs/design/rvoip-opc-communication-foundation-integration-design.md)
- [VOS5000/100K 计划](../../docs/design/communication-foundation-vos5000-parity-performance-plan.md)

在 R1 获批前，R5 继续决定现有通信实现边界。R1 获批后必须建立新的 traceability，把
R1 的产品/领域要求映射到 R5/R4 通信合同，不能靠自然语言假定二者已经完全对齐。

## 3. R1 明确保留和替换的边界

- Hugging Face `speech-to-speech` 只替换 Active Call、LiveKit Agents 和旧 Python 链中
  功能相同的实时 VAD/STT/LLM/TTS speech loop。
- LiveKit Agents 的 Room/participant/job/workflow/tool/handoff 等非重叠能力保留为
  Adapter 能力。
- Active Call 的电话 Agent、Playbook、DTMF、REFER、interrupt 等非重叠能力保留为
  Telephony Channel Agent 候选。
- Pi、Nanobot 和其他框架只能通过稳定 Adapter 接入，不能拥有跨渠道 Task、Memory、
  Policy、Action 或通信状态。
- AI、录音、GPU、模型或 Provider 故障不得拖垮已建立的人类主通信。
- 未来 ViLTE/4G 视频只保留经过 Gate 的扩展边界，不冒充当前可交付能力。

## 4. 不进入当前权威包的旧文档

下列文件仍保留历史和现状参考价值，但不能与 R1 并列为未来产品 Authority：

- `docs/ainative.md`
- `docs/design/super-contact-center-platform-vision.md`
- `docs/design/architecture-v3.md`
- `docs/design/revised-master-plan.md`
- `docs/voice-agent-spec-v1.md`
- Phase/Sprint、AI avatar、旧 Agent video、旧多模态翻译和旧 CCaaS 规划

R1 §1.3 规定：只有用户批准 R1 后，这些旧产品/AI 总纲才统一转为
`superseded_reference`。当前不能提前删除，也不能从旧文档继续推断目标架构。

## 5. 用户批准后才创建的执行资料

1. R1 binding objective；
2. R1 machine contract 和 JSON Schema；
3. 旧 Goal、R4/R5、AI/产品要求的逐条 traceability 和 Schema；
4. W0–W10 依赖化 TDD 实施计划；
5. Evidence/claim index，初始状态全部为 `not_run`；
6. R1 与通信 R5 的冲突/吸收 ADR。

在上述资料生成并通过独立审查前，不进入 AI-native R1 开发。
