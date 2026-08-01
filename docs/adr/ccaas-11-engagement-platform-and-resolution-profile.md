# ADR-CCAAS-11：以 Engagement 为平台核心，Resolution 作为垂直 Profile

Converact 的长期产品边界是 AI-native 多模态通信与业务执行平台，而不是仅面向设备售后的技术
问题解决产品。平台采用 `Engagement` 与 `EngagementItem` 表达跨渠道、跨天的通用业务目的
及其独立结果单元；`Resolution`/`ResolutionItem` 作为 `resolution` Profile 的严格特化。
这样可以保留首个 Resolve Assist Offer 的聚焦、Evidence、复发和 Outcome 语义，同时让
Contact Center、AI Voice/Video Agent、咨询、运营、OEM 和未来电信能力复用同一平台而不
伪装成故障工单。

## Considered Options

1. **只修改市场文案，继续以 Resolution 为平台上位对象**：拒绝。非售后业务会持续增加
   特例并污染指标、状态和 API。
2. **每个垂直行业建立独立业务核心**：拒绝。会复制 Interaction、Task、Action、Evidence、
   Billing 和 Agent Authority。
3. **一个 Engagement Core + 版本化 Profile**：采用。共同对象保持单写，Profile 只扩展
   领域字段、政策、指标、UI、Connector 和验收 Gate。

## Consequences

- `Converact Resolve` 仍是首个且唯一当前执行的垂直 Offer；平台范围扩大不授权并行开发
  其他 Profile。
- Resolve 的市场失败只停止该 Profile，不能自动否定通信和 Horizontal Platform；新的垂直
  扩张仍必须先取得自己的市场 Gate。
- `Interaction` 表示一次连续参与窗口，`Engagement` 才是跨多个 Interaction/跨天的业务
  容器；Call、Room、Ticket、Opportunity 和 Provider session 都不是二者的替代 ID。
- Goal、机器合同和停止条件必须明确其作用层次：Platform、Profile、Capability 或
  Deployment Option。
