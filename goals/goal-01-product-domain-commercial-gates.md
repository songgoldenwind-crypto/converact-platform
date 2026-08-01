# Goal 01 — 平台、Profile 领域与首发商业 Gate

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G01` |
| 初始状态 | `not_run` |
| 前置 Goal | G00 `completed` |
| 解锁 | Platform Contract 解锁 G02/G09；Resolve Market Gate 解锁 G11/G16 |
| Authority | Converact 平台/Engagement Profile/Offer 定义；客户继续拥有其业务与采购决定 |
| 主要来源 | [平台 R2](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 §3、§7、§19–§25](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

先冻结 Converact Platform、Engagement Profile、Product Offer 和 Deployment Option
的边界，再冻结一个可销售、可测量、可停止的首发产品合同。平台类别是 AI-native 多模态
通信与业务执行平台；首发 Offer 仍固定为面向中国出口设备企业的 `Converact Resolve`：
保留现有电话和 CRM/FSM Authority，以跨语言远程安装/售后 Resolution、视觉 Evidence 和
可验证 Outcome 作为赢单核心。

文档合同完成不等于市场证明。访谈、付费意向、合同、ROI 和转化必须来自真实买家；缺失时
记录 `blocked_external` 或 `not_run`，不得伪造。

## 3. Required outcomes

1. 冻结 Platform/Profile/Offer/Deployment Option 四层产品合同，明确哪些是 Horizontal
   Platform、首个 Profile、可销售 Offer 和条件式 Option。
2. 冻结领域语言：Engagement、EngagementItem、Engagement Profile、Objective、Interaction、
   CommunicationSession、Task、Evidence、Action、OutcomeClaim；把 Resolution/ResolutionItem
   定义为第一个 Profile 的严格特化，禁止 Call、Room、Ticket 或 Opportunity 冒充上位对象。
3. 冻结通用 Native/Overlay Authority、Profile extension contract、失败/降级边界、人工责任
   和 AI 边界；Profile 不创建第二平台 Authority。
4. 为 Resolve Assist 冻结唯一 ICP、Budget Owner、Champion、用户角色、JTBD、产品族、
   语言对和主流程；这些选择不得被写成整个 Converact 平台的永久行业边界。
5. 冻结 12 周固定范围 Pilot：价格、付款、单一团队/产品族/流程、20 named experts 上限、
   300 agreed eligible items 上限、20 person-days 上限、Milestone A 与必验 B1。
6. 冻结 Pilot 指标、基线、eligible/excluded 规则、观察窗口、样本量方法、归因、争议与
   Outcome verification；不能只测模型或通话指标。
7. 冻结销售状态词 `available/pilot/planned/option/not_run`，No-bid/Partner Gate、变更单
   规则和不能在首发销售的范围。
8. 建立 Resolve Profile 的真实市场 Evidence 协议：至少 20 次 Budget Owner/Champion 访谈、3 家同一流程的
   书面付费意向或合同，其中至少 1 家签署 USD 20k Pilot，另外 2 家有期限的付费承诺。
9. 建立 Resolve Profile 的 ROI 与单位经济模型：价值池、派工/停机/返工基线、实际线路/SFU/GPU/模型/存储/
   支持成本、CAC、毛利、退款/Credit/Reversal。
10. 冻结分层 Stop Gate：Resolve 只要便宜视频、传统 CCaaS、工单系统、低价 Bot 或不提供
    基线时 no-bid；三客户形成三套定制需求时停止该 Profile 扩张。该结论不自动否定
    Horizontal Platform，也不授权未经验证的第二 Profile。
11. 分两层建立可复查竞争基线：平台层按 Enterprise Contact Center、CPaaS/RTC、AI Agent、
    CRM/FSM/Workflow、Telecom/OEM 和开源构件划分买家与替代预算；Resolve 层再比较远程支持、
    视频协作和现有售后流程。Genesys、Zoom、LiveKit、SightCall/TechSee/CareAR、CRM/FSM、
    企业 Agent 与 HF/Active 等只按届时公开或 Converact 同源实测能力比较；明确 Build/Absorb/Buy/
    Partner、Win/No-bid 边界，不能靠功能数量取胜。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-01/`：

- `product-domain-contract.md`
- `platform-profile-offer-option-contract.md`
- `ubiquitous-language-v1.json` 与 schema
- `engagement-profile-contract-v1.json` 与 schema
- `authority-and-user-journey.md`
- `pilot-scope-and-acceptance-contract.md`
- `market-evidence-protocol.md`
- `interview-and-demand-evidence-register.json` 与 schema
- `roi-unit-economics-model.md`
- `platform-market-and-competitive-map.md`
- `competitive-and-build-buy-partner-review.md`
- `commercial-stop-gates.md`
- `traceability-v1.json` 与 schema
- `independent-review.md`
- `2026-07-31-goal-01-product-commercial-plan.md`

真实访谈记录可引用受控外部存储，不得把个人信息、合同机密或凭据复制进 Git。

## 5. Work order

1. 从 G00 trace、平台 R2 和 Resolve R1 提取候选，不新增平行 Offer。
2. 先冻结 Platform/Profile/Offer/Option、术语、Authority 与 Profile extension contract。
3. 再冻结 Resolve Pilot acceptance 和 Evidence schema；不得反向把售后字段写进通用核心。
4. 用合成 fixture 验证指标公式与 schema；合成数据只能证明工具可用。
5. 执行真实访谈/付费验证或记录精确外部阻塞。
6. 基于证据更新 Resolve ICP、scope 和 no-bid；任何修改保留版本和理由。
7. 独立审查平台可扩展性、Profile 隔离、首发可售性、可测性、隐私和定制风险。

## 6. Acceptance gates

### Platform contract gate

- Platform/Profile/Offer/Option 边界、Engagement 上位模型和单一 Authority 无歧义。
- Resolution 是第一个 Profile，不是平台根对象；Profile schema/policy 不能旁路平台状态。
- 通信、Speech、Agent、Action、Evidence 和部署 Option 可在稳定接口后独立资格化。
- 平台级竞争地图与 Resolve 竞品/赢单条件分离；没有把某一垂直结果外推成平台领先或失败。
- 所有机器合同、schema、trace 和链接通过验证。

### Resolve profile contract gate

- 一个 ICP/JTBD/Resolution 主流程与一个 Pilot 合同均无 Authority 歧义，并明确只属于
  Resolve Profile。
- Milestone A、B1、ROI、Outcome、失败降级和 change order 可客观验收。
- 竞争结论区分公开事实、推断和 Converact 实测，且能导出清晰 Win/No-bid/Partner 决策。

### Market gate

- ≥20 次可审计的目标买家/Champion 访谈。
- 3 家验证同一主流程；至少 1 份已签付费 Pilot，另 2 份有期限书面付费承诺。
- 价值池、预算、数据可得性和共同范围真实存在。
- 不用供应商 benchmark、概念演示或内部意见代替买家 Evidence。

Platform/Resolve contract gate 完成但 Market gate 未完成时，G01 只能为
`blocked_external`；Platform Contract 可以解锁 G02/G09 和不依赖 Resolve 的 Horizontal
工作，但不得据此声称 Resolve 市场资格、启动 G11/G16 或偷偷开发另一个 Profile。全部通过
才是 G01 `completed`。

## 7. Explicit non-goals

- 不在本 Goal 构建通用 CCaaS、低代码 Studio、多 Agent 市场或完整 CRM/FSM。
- 不同时选择多个电话 Provider、多个 CRM 或多个首发行业。
- 不开发通信、AI、Connector 或 UI。
- 不承诺 ViLTE、Native PBX、远程控制、通用 Vision 或自主高风险动作。
- 不把用户要求“平台通用、未来先进”解释成跳过每个 Profile 的真实商业验证。

## 8. Completion and commit boundary

建议按合同与真实 Evidence 两个可审查提交分开：

- `docs(platform): freeze engagement and profile boundaries`
- `docs(product): freeze resolve assist domain and pilot contract`
- `docs(commercial): record market qualification evidence`

不得把未提交的客户承诺写成已签合同。任何未证明项保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-01-product-domain-commercial-gates.md`
using its manifest SHA-256, after G00 is completed. Obey PROGRAM-RULES.md.

Freeze the horizontal Converact platform contract first: Engagement/EngagementItem,
Profile/Offer/Deployment Option boundaries, single authorities and profile
extension rules. Then freeze one sellable Converact Resolve
ICP/JTBD/Resolution journey, fixed-scope Pilot A+B1 contract, acceptance
metrics, ROI/unit economics, evidence protocol and profile-scoped stop/no-bid
gates. Keep platform contract, profile contract and real market qualification
separate.
Real market completion requires at least 20 target-buyer interviews, three
same-flow paid commitments including one signed USD 20k Pilot, and auditable
value/budget/data evidence. Do not fabricate customer evidence or implement
features. Anything unproved remains not_run or blocked_external.
```
