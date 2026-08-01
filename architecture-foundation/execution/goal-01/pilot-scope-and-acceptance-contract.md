# Converact Resolve Assist — Pilot Scope and Acceptance Contract

> Offer：`resolve-assist-pilot-a-b1-v1`
> Profile：`converact-resolve-v1@1.0.0`
> 当前销售状态：`not_run`；没有签约客户
> 本文是 Order Form/SOW 的产品基线，不是已签合同或业绩证明

## 1. 固定商业范围

| 项目 | 不可静默改变的合同值 |
| --- | --- |
| 价格 | USD 20,000；税费、线路和约定外第三方用量另计 |
| 付款 | 50% 签署；25% Milestone A；25% Milestone B1/最终复盘 |
| 周期 | 12 周：2 周接入、8 周运行、2 周结果复盘 |
| 客户范围 | 1 个团队、1 个产品族、1 个双方 agreed Resolution flow |
| Product family | `led-display-system-v1`：LED 显示系统及完成安装所需的控制/配置组件 |
| Flow | `remote-installation-commissioning-v1@1.0.0`：美国现场首次安装调试未通过→现有电话→免 App 视频/中英文字协作→Evidence→人工验收或明确派工 |
| 用户 | 最多 20 名 named experts |
| 样本 | 最多 300 个 agreed eligible ResolutionItems；最低样本签约前计算 |
| Converact 实施 | 最多 20 person-days |
| 外部连接 | 1 个 provider-specific 电话 Adapter、1 个 CRM/FSM Connector |
| 语言 | 中文↔英文 captions/text translation；不注入 translated TTS |
| 里程碑 | Milestone A + 必验 Milestone B1 |
| 培训/支持 | 2 次远程管理员/专家培训、运行手册、约定时区 business-hours 支持 |
| 转正抵扣 | Pilot 完成后 30 天内且范围不变的年约，50% Pilot 费抵首年平台费 |

当前没有 Market Gate Evidence，因此不得公开宣称该 Offer 已 market-qualified 或可激活交付。
为避免“必须先有签约才能通过 Market Gate、又必须先通过 Market Gate 才能签约”的循环，签约
与激活采用两个正交状态：

```text
Offer sales status: not_run/planned
  -> signed_conditional（商业 Evidence 状态，不是销售状态）
  -> Market Gate 满足
  -> capability/security/procurement/runtime gates 满足
  -> activated pilot（客户范围内的销售/交付状态）
```

在 Platform/Resolve Contract Gate、ICP/flow/value/budget/data 资格、固定 A+B1 Order Form、采购
路径和有效期均明确后，可以签署**附条件的 USD 20k Pilot**；该签署可计入 Market Gate，但不
自动启动交付、不证明功能可用，也不把 Offer 升级为 `pilot`。只有 Market Gate 及所签范围的
Capability、安全/DPA、采购和 Runtime production-eligibility Gate 全部通过，才可激活 Pilot。

## 2. 客户与 Converact 前置责任

客户在 Week 0 前提供：

- Budget Owner、Champion、Service manager、Data/IT owner 和 human verifier；
- 唯一 `led-display-system-v1` 产品族、`remote-installation-commissioning-v1@1.0.0` 流程、
  设备/问题 taxonomy 与安全排除规则；
- 脱敏历史基线、eligible volume、派工/停机/返工/专家等待和客户变更成本；
- 电话 Provider 与 CRM/FSM 的合法测试/生产沙箱、版本化接口和责任人；
- named experts、测试用户、培训时间、DPA/Consent/Retention/Region 决定；
- agreed observation window、争议与外部 Case/WorkOrder 关闭口径。

Converact 提供：

- 固定 Profile/Offer/Eligibility/Metric/VerificationPolicy 版本；
- Overlay 主链的配置、测试、操作手册和每周 Evidence review；
- agreed 指标计算、成本归因、失败/降级和 query/reconcile 报告；
- 不超过 20 person-days 的标准实施；
- 对所有未资格能力显示 `not_run/planned/option`，不以概念演示代替交付。

任何一方未按时交付前置项，记录 `customer_blocked` 或 `converact_blocked` 的时间窗口；不能把它
静默从分母删除，也不能自动延长、扩大范围或宣称业务成功。

## 3. 周计划与里程碑

| 周 | 阶段 | 必须产出 | 退出条件 |
| --- | --- | --- | --- |
| 0/签署前 | Qualification | ICP、flow、价值池、数据/样本、责任、DPA、安全、最低样本 | Market/采购依赖真实满足；否则 no-bid/延期 |
| 1 | Baseline & contract | Eligibility、problem fingerprint、指标、观察窗口、Outcome/争议、成本版本 | 双方签署；不得事后修改分母 |
| 2 | Integration | 一个电话 Adapter、一个 CRM/FSM Connector、身份/consent/audit、演练 | 主链和降级在约定环境可复查 |
| 3–6 | Milestone A run | 电话关联→no-app video→Evidence→人工 Outcome→CRM Receipt | A 的所有必验项通过；失败项留在报告 |
| 3–10 | Operations | agreed eligible items、每周质量/成本/采用/阻塞复盘 | 8 周完整观察，不能只挑最好周 |
| 7–10 | B1 qualification/run | 双声道中英 captions/text translation、原文、低置信和人工回退 | B1 全部 mandatory gate 通过 |
| 11–12 | Review | 基线对比、置信区间、护栏、ROI/单位经济、争议与未决项 | 双方签署复盘；未达到 Gate 不转年约 |

Milestone A 与 B1 可以时间重叠，但必须分别验收。B1 失败时 Pilot 不算完成；不得用 A 成功、
Copilot/OCR 演示或供应商语音 benchmark 抵扣 B1。

## 4. Milestone A 客观验收

同一 agreed flow 至少证明：

1. 客户从现有电话入口进入，外部 PBX/CCaaS 保持 Call Authority；
2. 唯一 Engagement/Resolution 与稳定 Interaction 建立，Call/Room 只是引用；
3. 工程师发送一次性 no-app 视频邀请；视频失败时电话继续；
4. Consent 后客户加入，Fabric 使用显式 bridge generation；Room/Participant 由 LiveKit 拥有；
5. 现场照片/视频片段/注释/步骤等 Evidence 有 provenance、consent、retention 和 hash；
6. 指定 human verifier 按冻结 VerificationPolicy 处理 OutcomeClaim；AI 不自动 Finalize；
7. 一个 CRM/FSM effect 有 idempotency、Attempt、Receipt、query/reconcile；外部系统保留关闭权；
8. 返回普通语音、参与者/Room/Bridge generation 清理和 orphan reconcile 可观察；
9. AI、翻译、录音、对象存储和 Connector 故障不因果性终止已建立 Human Communication；
10. eligible/excluded、失败、deferred、unknown、disputed 和 reversal 全部进入报告。

G01 不声称这些运行时路径已实现；它们由后续 Capability/Implementation Goal 逐项提供 Evidence。
签署 Pilot 时若任何依赖仍 `not_run`，相应里程碑不能被标为可验收。

## 5. Milestone B1 客观验收

B1 只替换/提供重叠 SpeechRuntime 的字幕和文本翻译，不改变 LiveKit/RustPBX/Engagement/Agent
Authority。必须覆盖：

- 双声道/说话人归属与 coverage；
- 中文、英文及 agreed 口音；现场噪声、双讲、长停顿、丢包和重连；
- 设备术语、命令、否定、单位、数字和序列号；
- source transcript、translation、model/config/revision 和人工 correction 的可追溯性；
- 低置信可见、原文始终可见、人工关闭/更正/回退；
- controlled set 中关键数字/序列号不得发生未标记篡改；
- 每一阶段的延迟/coverage/错误按统一 clock 和定义测量；
- Speech worker/模型/GPU 故障时 Human Communication 继续；
- 不向外部电话或 WebRTC participant 注入 translated TTS。

VAD、STT、翻译、LLM 或 TTS 的供应商默认配置不能被假设最优。HF、保留的 LiveKit Agents
非重叠能力和任何未来候选必须使用同一音频集、语言、硬件、网络、turn 定义、质量护栏、
成本和长会话进行资格测试；没有原始输出保持 `not_run`。

## 6. Eligibility、分母与排除

`eligible_item` 在看见 Outcome 前依据冻结规则判定。每个 item 只表达一个规范化
ProblemStatement，并有 `problem_fingerprint + asset_reference + VerificationPolicyVersion +
observation_window`。

进入分母需同时满足：

- 属于唯一团队、产品族和 agreed flow；
- 在 Pilot 观察窗口内 Qualified；
- 来源系统有可审计基线/状态引用；
- 远程处理不违反安全/保修/监管政策；
- 必要 Consent/Data/Region 条件满足；
- 不是已计入的重复 problem fingerprint；
- 位于双方同意的最多 300 items 范围。

排除类别在签署前编码：非目标业务、无基线、重复、禁止远程处理、缺失合法授权、超范围、
Pilot 前已解决。每个排除仍保留 pseudonymous ID、规则版本、时间和 reviewer；事后以失败、网络
或不满意为由排除被禁止。

客户阻塞、Converact 不可用、外部 Provider 不可用、用户拒绝 Consent 和产品本身不适用必须
分别归因。它们可以进入预签的敏感性分析，但不能从审计台账消失。

## 7. 唯一主指标与护栏

每份 Order Form 只能从下列业务指标选一个 `primary_outcome_metric`，不得在结果后切换：

| 指标 | 规范公式 |
| --- | --- |
| Remote Resolution Rate | 无需现场派工且有 Finalized OutcomeClaim 的 eligible items / 全部 eligible items |
| Avoided Dispatch Rate | 已取消派工或匹配冻结历史基线的 avoided eligible items / baseline dispatch-eligible items |
| Installation Success | 首次 agreed 安装流程通过人工验收的 eligible installation items / started eligible installation items |
| Mean Time to Resolve | `Qualified` 到 Finalized 的持续时间；同时报告分位数和 censored items |

次级指标：First Contact Resolution、First Time Fix、Time to Expert、Expert Leverage、Case-level
Closure、Downtime Avoided、Translation Cost Avoided。电话升级视频仍算首次 Interaction 的前提是
InteractionId 不变、客户未离开且未重新排队。

强制非劣效护栏：

- 安全事件/不安全指导；
- CSAT（使用预签量表与响应率）；
- Repeat Incident Rate（冻结 fingerprint 和观察窗口）；
- 人工升级/派工率；
- 外部 Case/WorkOrder 错误关闭、重复动作和未对账 `unknown`；
- Human Communication 的 Converact 因果中断；
- Consent、数据驻留、Retention、Evidence/Recording coverage。

Order Form 在签署前定义每个护栏的可接受 margin。任何 mandatory 护栏失败都阻止转年约，
即使主指标改善。

## 8. Baseline、观察窗口与样本方法

Baseline 必须来自相同产品族、问题 taxonomy、区域/语言、团队和季节窗口的脱敏历史记录，或
预先登记的并行控制。记录 source system、提取查询/hash、时间窗口、missingness、case→item
拆分和外部流程变化。

最低样本不是固定“看起来够用”的数字。签约前由双方分析负责人：

1. 选唯一主指标和最小有商业意义改善 `delta`；
2. 估计 baseline rate/variance、cluster（客户/工程师/产品）与 attrition；
3. 预注册双侧 `alpha`、power、检验/区间方法和 non-inferiority margins；
4. 对比例使用预注册的两比例/配对方法，对时长使用合适分布或 bootstrap，并报告 effect size 与
   置信区间；
5. 加入重复问题、未完成 observation window、客户阻塞和缺失数据的敏感性分析；
6. 若所需样本超过 300 或 8 周可得量，Pilot 只给方向性结果，不能宣称指标优越或扩大销售。

停止规则、interim look 和排除必须预注册，防止 p-hacking。Pilot 窗口结果与保守年化模型分开；
不能把 12 周最好结果简单乘四。

## 9. Attribution、Outcome 与争议

价值归因优先级：直接外部事实（取消派工/停机记录/工时）→ 预签历史匹配 → 经双方确认的保守
估计。派工、停机、返工和专家等待使用 `(organization, asset/problem, value_pool,
observation_window)` dedupe key；同一价值不能在多个指标或 OutcomeClaim 重复计入。

OutcomeClaim 只有在以下条件同时满足才 Finalized：

- 引用 eligible item、problem fingerprint、baseline 和 VerificationPolicyVersion；
- 必要 Evidence 达到 provenance/consent/coverage 阈值；
- 指定 human verifier 或合法外部 Authority 确认；
- 观察窗口结束且没有同一问题复发；
- dispute window 结束或争议已解决。

复发、错误归因或争议成立时新增 immutable OutcomeReversal 与 Credit/Reversal；不能编辑原
OutcomeClaim。未知外部 effect 必须 query/reconcile，不能盲重试或计费。

## 10. Change order

以下任一变化必须书面 change order/new Offer version：第二团队/产品族/flow/Provider/CRM/FSM、
超过 20 experts/300 items/20 person-days、第二语言对、translated TTS、Remote Control、Native
PBX、ViLTE、B2/B3、高风险 Action、不同 Region/Retention 或指标/观察窗口变化。

Change order 必须说明增量价格、日程、责任、样本量、成本/毛利和 Gate。已观察结果不能通过
新版本回填改变原分母、基线或付款里程碑。

## 11. Pilot 完成与转年约

Pilot 完成需要 A 与 B1 均通过、8 周运行和 2 周复盘完成、所有 mandatory 护栏通过、争议/未知
有明确状态，并由双方签署复盘。转年约还需：

- `benefit / total_cost ≥ 3.0`（净 ROI ≥ 2.0）；
- Pilot 回收期目标 ≤6 个月，保守年化模型仍满足价值池；
- 标准实施 ≤20 person-days；
- 公共产品复用假设没有被单客户定制破坏；
- 后续扩大到 2/3 Pilot 转年约、≥80% 复用、≤20% 客户专属工作、≥70% 稳态毛利、CAC
  payback <12 months 的 Program Gate。

这些都是未来真实 Evidence 条件。当前均 `not_run`。

## 12. 明确不包含

完整 CCaaS/WFM/QM、客户专属媒体协议、自建 PBX、多个 Provider/CRM/FSM、通用 Vision 模型
训练、Remote Desktop/Control、高风险自主工具、translated TTS、AI Studio、多 Agent 市场、
ViLTE、OEM、多个行业/Profile。销售材料必须把它们标为 `option/planned/not_run`，不能写进
Pilot “灵活范围”。
