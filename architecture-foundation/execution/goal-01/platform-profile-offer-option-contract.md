# Platform / Profile / Offer / Deployment Option Contract

> Version：1.0.0
> Authority：Converact platform/product contract
> Market status：`not_run`
> Runtime status：`not_run`

## 1. 四层定义

| Layer | 问题 | 拥有内容 | 不拥有内容 | Gate |
| --- | --- | --- | --- | --- |
| Horizontal Platform | 所有业务形态共同需要什么？ | 上位领域、Authority、接口、Evidence/Action 纪律、隔离 | 某行业 ICP、价格、专属 KPI | Platform Contract |
| Engagement Profile | 某类 Engagement 如何特化？ | namespaced schema/policy/metrics/UI/connector requirements/Stop Gate | 第二平台状态、第二 Authority | Profile Contract + Market Gate |
| Product Offer | 客户现在购买什么？ | 固定范围、价格、SLA、验收、责任、依赖 Gate、change order | 路线图愿望、未资格化 Option | Offer/Pilot/Production Gate |
| Deployment Option | 用什么交付/能力组合？ | Native/Overlay/Dedicated/On-prem/OEM/ViLTE 等条件 | 自动改变业务 Authority 或销售状态 | Option/Capability Gate |

层级是组合关系，不是继承式越权：

```text
Platform Contract
  └─ Profile Contract(profile_type, version)
       └─ Offer Contract(offer_id, scope, commercial_version)
            └─ Qualified Option Set(option_id, evidence_revision)
```

任何 Offer 必须绑定恰好一个 Profile 版本和一个平台合同版本；一个 Option 只有在 Offer 明确列出
且自身 Gate 通过后才可启用。

## 2. Horizontal Platform v1

平台冻结：

- `Engagement`/`EngagementItem` 上位模型；
- Tenant、Identity、Consent、Region、Retention、Audit；
- Interaction/CommunicationSession/BridgeIntent；
- Task/AgentRun/ContextRevision/Handoff/Evaluation；
- Evidence/ActionIntent/Attempt/Receipt/Verification/OutcomeClaim；
- 单一 Authority、version/epoch/fence、idempotency/query/reconcile；
- 普通通信与 AI/录音/Connector 故障隔离；
- Capability、Profile、Offer、Option 分层 Gate。

平台没有永久 ICP、行业、产品族、语言对或 Pilot 价格。首发 Resolve 的选择不能写入这些平台
不变量。

## 3. Resolve Profile v1

`profile_type="resolution"` 只增加：

- `Resolution`/`ResolutionItem(problem)` 术语投影；
- 问题症状、复发、安装阶段与设备/配置组件引用；本 commercial revision 只绑定
  `led-display-system-v1` / `remote-installation-commissioning-v1@1.0.0`，售后维修、例行维护和
  其他产品族 deferred；
- avoidable dispatch/downtime/rework/expert-wait 价值池；
- 视觉 Evidence、步骤验证、Outcome verification；
- Resolve ICP/JTBD、A+B1 Pilot、Win/No-bid/Stop Gate。

它复用平台 Engagement/Interaction/Communication/Task/Evidence/Action/Outcome Authority，不创建
第二数据库或第二状态机。Profile validator 崩溃只拒绝/延迟 Resolve 请求，不影响其他 Profile
或已建立的人类通信。

## 4. 首发 Offer：Resolve Assist Pilot A+B1

| 字段 | 固定值 |
| --- | --- |
| Offer ID | `resolve-assist-pilot-a-b1-v1` |
| 销售状态 | `pilot` 仅在 Market Gate 与签约条件满足后；当前 `not_run` |
| 价格 | USD 20,000 |
| 付款 | 50% 签署、25% Milestone A、25% 最终复盘/交付 |
| 周期 | 12 周：2 周集成、8 周运行、2 周复盘 |
| 范围 | 一个客户团队、一个产品族、一个 agreed Resolution flow |
| Product family | `led-display-system-v1` |
| Flow | `remote-installation-commissioning-v1@1.0.0` |
| 人员上限 | 20 named experts |
| eligible items | 最多 300 个双方书面同意的 eligible items |
| Converact 服务 | 最多 20 person-days |
| 连接 | 一个 provider-specific phone adapter；一个 CRM/FSM connector |
| Milestone A | 保留电话/CRM Authority的无 App 视频升级、Evidence 与人工验证主流程 |
| B1 | 中英 captions/text translation 必验；不向通话注入 translated TTS |

任何增加第二团队、产品族、流程、Provider、CRM/FSM、语言对、translated TTS、远程控制、ViLTE、
Native PBX 或高风险自主动作的请求都必须是 change order 或新 Offer，不能稀释验收分母。

## 5. Deployment/Capability Option register

| Option | Layer | 当前销售词 | 可进入首发 Pilot | 独立 Gate |
| --- | --- | --- | --- | --- |
| Overlay customer PBX + CRM/FSM | deployment | `pilot`（签约后） | 是，默认 | G01 contract + G11 selected connectors |
| Native Converact PBX | deployment | `option` | 否 | 通信、安全、VOS-EQ/100K、商业 Gate |
| Dedicated/On-prem | deployment | `option` | 仅书面资格化后 | 安全、运维、升级、容量、支持成本 |
| OEM/white-label | deployment | `option` | 否 | 品牌、支持、供应链、责任和单位经济 |
| ViLTE/operator AV | capability/deployment | `option` | 否 | IMS/Carrier/codec/legal/security/AV evidence |
| Resolve B1 text translation | capability | `planned`；Pilot 必验 | 是，达到 G12 Gate 后 | Speech/Translation capability |
| Translated TTS injection | capability | `not_run` | 否 | 单独安全、体验、延迟和市场 Gate |
| Remote desktop/control | capability | `option` | 否 | 授权、审计、安全、平台支持和市场 Gate |
| B2/B3 autonomous assist | capability/offer | `not_run` | 否 | 独立客户转正、风险、Action/Eval Gate |

“Option”不表示已实现或可售；“planned”不表示 Pilot 可用；只有依赖 Evidence 与 Offer 版本同时
满足才可升级为 `pilot` 或 `available`。

## 6. Profile registration contract

新增 Profile 必须提交：

1. 唯一 `profile_type` 和版本；
2. 上位术语映射，不得更名替代平台 Authority；
3. namespaced schema 与纯 validator；
4. Objective/metric/VerificationPolicy；
5. 明确 ICP/JTBD、Budget Owner/Champion 和真实 Market Evidence；
6. 所需 Capability/Connector/Option；
7. threat/failure、human accountability、隐私/保留；
8. Win/No-bid/Partner/Stop Gate；
9. 测试、trace 和独立审查；
10. 失败仅停止该 Profile 的证明。

同时开发多个未经验证 Profile 被禁止。首个 Resolve 的结果不能自动授权第二 Profile。

## 7. Offer change control

Offer 每次改变价格、付款、团队、产品族、流程、语言、连接器、人员/样本/person-days 上限、
Outcome 归因或责任，必须：

- 新增不可变 commercial version；
- 说明原因、请求方、成本/价值影响；
- 重算样本量、ROI、毛利和交付容量；
- 重跑适用 Gate；
- 保留旧版本、签署范围和 Evidence 链；
- 禁止回填改变已完成 Pilot 的分母或 Outcome。

## 8. Sales status machine

```text
not_run --(approved plan only)--> planned
planned --(conditional path)----> option
planned/option --(signed scope + all pilot gates)--> pilot
pilot --(production + commercial evidence)--------> available
```

状态不能只靠时间或内部决定升级。Gate 失败时保持原状态或降为 no-bid/stopped；不得用 `beta`、
`ready`、`supported` 等模糊词替代五个销售状态。

### 8.1 Market-validation signature 不是第六个销售状态

`signed_conditional` 只描述一份固定 A+B1 Order Form 已由双方签署、金额/范围/审批路径/到期日
可复查；它是商业 Evidence 状态，不表示 Offer 已 `pilot`、Capability 已通过或交付已激活。
它允许作为 Market Gate 所需的一份 USD 20k 签约 Evidence。交付激活仍要求 Resolve Market、
适用 Capability、安全/DPA、采购和 Runtime production-eligibility Gate 全部满足。

## 9. Gate non-propagation

- Platform Contract 通过：只证明水平语义可继续设计；不证明 Resolve 付费需求；
- Resolve Profile Contract 通过：只证明产品合同可测；不证明有客户；
- Resolve Market Gate 通过：只授权同一 ICP/flow 的后续 Pilot 依赖工作；不证明生产资格；
- 某 Capability/Option 失败：只排除该能力/交付方式；不改写 Platform Authority；
- Resolve Stop Gate 触发：停止 Resolve 扩张；不自动否定水平平台，也不授权另一个 Profile。

## 10. 验收

机器合同必须拒绝：Profile 自建 Authority、Resolution 成为 platform root、Offer 没有固定 Profile
版本、Option 自动改变 Authority、未通过 Gate 却标 `available/pilot`、以及首发 Offer 的固定范围
发生静默漂移。
