# Resolve ROI and Unit Economics Model

> Formula version：`resolve-roi-v1`
> Executable evaluator：`evaluate-roi.mjs`
> 当前客户数据：无；所有 fixture 为 `synthetic_non_market_evidence`
> 本模型不能凭自身证明价格、需求、ROI 或转年约

## 1. 核心原则

价格从真实、去重、可验证的客户价值池和完整交付成本反推；不能从竞品标价、供应商 benchmark
或理想化节省反推。Pilot 窗口结果、保守年化价值、Converact 收入、客户总成本和 Outcome 奖励
分别计算。

## 2. 年价值公式

```text
primary_avoided_event_value
= eligible_annual_items
× baseline_avoidable_event_rate
× verified_value_per_avoided_event

primary_value_dedupe_key
= (organization, product_family, flow, value_event_class, observation_window)

annual_addressable_value
= primary_avoided_event_value
+ deduped(downtime, rework, expert_wait and other signed value pools)

annual_first_year_cost
= subscription
+ expected carrier/SFU/GPU/model/storage usage charged to customer
+ onboarding/integration/training
+ customer internal labor and change cost

qualification candidate only when
annual_addressable_value / annual_first_year_cost ≥ 3.0
```

主价值和每个附加价值池都使用同一命名空间的
`(organization, product_family, flow, value_event_class, observation_window)` dedupe key。同一停机
损失不能同时作为 avoided dispatch、downtime 和 Outcome reward 重复相加。附加项与主价值 key
相同则完全排除；两个附加项共享 key 时 evaluator 只采用较小的保守值；真实分析仍需 reviewer
解释来源。

`verified_value_per_avoided_event` 必须来自已签口径：派工订单/取消、停机记录、返工工时、专家
工时或财务批准模型。销售人员主观估计单独列敏感性分析，不进入 base case。

## 3. Pilot 实际 ROI 与年化

```text
pilot_benefit
= sum(finalized and unreversed eligible value within pilot window)

pilot_total_cost
= pilot_fee + third_party_usage + Converact onboarding not in fee
+ customer integration + training + internal labor + process change

pilot_benefit_cost_ratio = pilot_benefit / pilot_total_cost
pilot_net_roi = (pilot_benefit - pilot_total_cost) / pilot_total_cost
```

转年约候选要求 `benefit / total_cost ≥ 3.0`（net ROI ≥2.0）且回收期目标 ≤6 个月，并通过全部
安全、CSAT、复发和升级护栏。Pilot 实际发生与年化模型分开：年化使用全年 eligible volume、
季节性、保守改善率和 attrition，不能把 12 周最好结果乘四。

如果分母为零、负成本、来源缺失、value pool 重复无法裁决或 observation window 未结束，计算
fail closed；不输出“无限 ROI”。

## 4. Converact 收入与贡献毛利

```text
gross_recognized_revenue
= subscription + usage + implementation_amortization
+ eligible_finalized_outcome_rewards

net_recognized_revenue
= gross_recognized_revenue
- refunds - credits - outcome_reversals

steady_state_attributable_cost
= carrier/line/SFU
+ GPU/model/speech/translation
+ storage/egress
+ customer-specific runtime and support/SRE
+ implementation amortization
+ partner and payment fees

contribution_gross_margin
= (net_recognized_revenue - steady_state_attributable_cost)
/ net_recognized_revenue
```

所有成本按 Tenant/Engagement/Resolution 可归因；共享容量采用预签分摊规则。不能把 GPU、线路、
Support 或免费集成藏在平台公共成本中来提高毛利。

扩张 Gate：稳态综合毛利 ≥70%。`credits/reversals/refunds` 必须从收入扣除；Finalized Claim
保持不可变，冲正用独立事实，不能删除不利 Outcome。

## 5. CAC 与交付经济

```text
fully_loaded_cac
= founder/sales time + SDR/marketing + presales solution work
+ security/legal/procurement review + free integration
+ travel + partner commission + allocated tooling

monthly_contribution_profit
= annual_contribution_profit / 12

cac_payback_months
= fully_loaded_cac / monthly_contribution_profit
```

当 contribution profit ≤0 时 payback 视为不可达而非零。Founder-led 阶段 Gate 为 CAC payback
<12 个月。

交付/复用 Gate：

- 标准 Pilot ≤20 Converact person-days；
- 核心产品/Connector/Playbook 复用 ≥80%；
- 客户专属代码与流程 ≤总交付工作 20%；
- 至少 2/3 完成的 Pilot 转年约后才扩第二 flow；
- ≥70% eligible items 能按 Pilot flow 提供能力；
- 每周 ≥60% assigned experts 有有效使用，客户阻塞和系统不可用分别归因。

## 6. 成本/价值数据字典

| 字段 | 单位 | Authority/来源 | 规则 |
| --- | --- | --- | --- |
| `eligible_annual_items` | items/year | 客户 CRM/FSM 查询 + agreed mapping | 去重 problem fingerprint；保留 query/hash |
| `baseline_avoidable_event_rate` | 0..1 | 历史同类 cohort/控制 | 签约前冻结；报告区间 |
| `verified_value_per_avoided_event_usd` | USD/event | 派工/财务/运营事实 | 同币种、同窗口、保守口径 |
| `primary_value_dedupe_key` | opaque tuple key | 双方签署的归因口径 | 与所有附加池共用命名空间；重叠附加项排除 |
| `additional_value_pools` | USD/year | 财务批准来源 | 必须有 dedupe key；不能重复 |
| first-year cost components | USD/year | Order Form + 客户内部成本 | 含 onboarding/change/labor |
| recognized revenue | USD/year | Billing ledger | 只含可确认收入 |
| Credit/Reversal/Refund | USD/year | immutable billing/outcome ledger | 负向事实不得省略 |
| attributable costs | USD/year | carrier/SFU/GPU/model/storage/support/partner invoices | 可追到客户/Resolution |
| CAC | USD | CRM/工时/费用 | 含 founder、法务、安全、免费集成 |

汇率使用签署的 rate source/date，并分别报告原币；税费与 pass-through 不冒充收入或价值。

## 7. 情景与敏感性

每个真实客户至少报告 conservative/base/upside 三种情景，但商业 Gate 只看 conservative/base
中预签的一个。敏感性至少覆盖：

- eligible volume、baseline avoidable rate、每次价值；
- adoption/coverage、seasonality、客户阻塞；
- carrier/SFU/GPU/model 价格和峰值；
- support/SRE、Connector 定制和实施天数；
- Credit/Reversal/Refund、复发和 attribution haircut；
- 汇率与 Region/On-prem 增量成本。

不得选择最有利情景签约后再把它称为 actual。

## 8. Synthetic fixtures

| Fixture | 预期 | 允许结论 |
| --- | --- | --- |
| `roi-qualifying.synthetic.json` | 跨过 3×、70% 和 CAC Gate，并验证 duplicate dedupe key | evaluator 算术可工作 |
| `roi-no-bid.synthetic.json` | 低于 Gate，`no_bid` | evaluator fail-closed 选择可工作 |
| `roi-credit-reversal.synthetic.json` | Credit/Reversal/Refund 降低净收入和毛利 | 负向事实被计入 |
| `roi-zero-denominator.synthetic.json` | 抛出明确错误 | 不输出无限/乐观 ROI |

这些 fixture 不代表客户、市场价格、实际成本、模型性能或收入。`market_evidence=false` 是不可
覆盖字段。

## 9. Decision output

Evaluator 的 `qualified_candidate` 仅表示输入算术越过合同阈值；仍需检查数据真实性、样本、
护栏、Market Gate、采购和生产资格。`no_bid` 触发 Resolve Profile 的 no-bid/重定位，不否定
Horizontal Platform。

当前没有真实输入，因此所有 ROI、毛利、CAC、转化和价格校准状态均为 `not_run`。
