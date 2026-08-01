# Resolve Commercial Stop, No-bid and Partner Gates

> Scope：`converact-resolve-v1` / `resolve-assist-pilot-a-b1-v1`
> Horizontal Platform impact：none unless separately reviewed
> Current：所有真实市场/Pilot/转化 Gate `not_run`

## 1. 原则

Stop Gate 是保护产品、客户和资源的合同，不是失败后删掉 Evidence。任何 Gate 触发：

- 停止相应 pursuit、capability、Option 或 Resolve Profile 扩张；
- 保留原因、输入版本、Evidence、owner、日期和恢复条件；
- 不降低阈值、不换指标、不删失败样本、不借未来功能继续销售；
- 不自动否定 Horizontal Platform；
- 不自动授权第二 Profile。

## 2. Pre-pursuit no-bid

以下任一成立即 no-bid/partner：

| Trigger | Decision | 可恢复条件 |
| --- | --- | --- |
| 客户只要低价视频链接/会议/AR | Visual vendor partner 或 no-bid | 出现可测跨语言/Evidence/Outcome 增量价值 |
| 客户只要完整 ACD/WFM/QM/传统 CCaaS | CCaaS partner | 接受 Overlay 且有 Resolve flow |
| 客户只要 Case/WorkOrder/dispatch | CRM/FSM/实施伙伴 | 需要实时现场 Resolution 补强 |
| 客户只按分钟买低价 Bot/deflection | Agent provider/no-bid | 高价值复杂问题和人工/视觉验证成立 |
| 不提供 baseline/value/budget/data | no-bid | 在有效期内提供可审计来源并签口径 |
| 不接受现有 PBX/CRM/FSM Authority 边界 | no-bid/change Offer | 通过独立 Native/Authority review |
| 要第二行业/多个 flow/provider/CRM 作为标准 Pilot | change order/no-bid | 回到唯一 v1 flow 或新 Profile Market Gate |
| 区域/合规/安全需要未资格化交付 | delay/no-bid | Option Gate 真实通过 |

## 3. Market Gate stop

Market Gate 需要 ≥20 合格访谈和 3 个不同组织的同一 flow 付费 Evidence（1 签署 USD 20k Pilot
+ 2 有期限付费承诺）。以下触发停止 Resolve 扩张并复盘：

- 20 次合格访谈后仍没有三个同一 flow 组织；
- 没有 Budget Owner、预算路径或 USD 20k 支付意愿；
- 三个客户形成三套定制 flow、Connector、媒体协议或 Outcome；
- value/budget/data 只存在于内部假设或供应商案例；
- 三家都主要购买其他类别（CCaaS、CRM/FSM、视频、低价 Bot）；
- `annual_addressable_value < 3 × annual_first_year_cost` 的合格客户占主导；
- 客户要求的安全/Region/Retention 不能在标准产品内满足。

触发后允许的只有：分析 disconfirming Evidence、缩窄/重定位 Resolve v1、partner/no-bid 或启动
一个**新的、独立批准** Profile discovery。不得直接开发第二 Profile。

## 4. Scope/change-order stop

Pilot 任一请求超过：1 团队、1 产品族、1 flow、20 experts、300 eligible items、20 person-days、
1 phone Adapter、1 CRM/FSM Connector、中文↔英文 A+B1，即停止纳入标准范围。

选择：

1. 删除新增请求并保持 v1；
2. 书面 change order，重算 price/time/sample/ROI/margin/Gate；
3. 作为可复用 paid integration；
4. no-bid。

不能用“Pilot 灵活”吞掉范围，也不能让销售口头承诺成为 roadmap Authority。

## 5. Capability/Option stop

| Capability/Option | Stop condition | Effect |
| --- | --- | --- |
| B1 translation | quality/latency/cost/coverage/critical-number/long-session/fallback Gate 任一失败 | Pilot 不完成；保持人工/原文；不注入 TTS |
| AI/Copilot/OCR | 不改善主指标或安全/CSAT/升级/复发非劣效失败 | 只停该 capability；Milestone A 可继续 |
| Recording/Evidence | Consent/coverage/integrity/retention 不满足 | 停需 Evidence 的步骤或按合同降级；通话不被拖垮 |
| Connector | duplicate/unknown/reconcile/Authority 不可控 | 停 Connector effect；外部系统保持 Authority |
| Native PBX | 少于 2 家签约需求或 VOS-EQ/100K/security/economics 未通过 | 保持 Overlay；不建客户专属 Fork |
| Dedicated/On-prem | 升级/回滚/支持/安全/毛利未通过 | 不销售该 Option |
| ViLTE | 无 Carrier/device 合同、Release/Profile、实验网或合规 Evidence | G17 Option 不启动 |
| Remote control/high-risk Action | 授权、审计、安全、compensation 不通过 | 不进入 Pilot/Offer |

一个 Capability 失败不能将另一个未资格 backend 静默启用，也不能停止已建立 Human
Communication。

## 6. Pilot outcome stop

不得转正式合同或扩大范围，如果：

- A 或必验 B1 未完成；
- 主指标没有使用预签分母/baseline/observation window；
- `benefit / total_cost < 3.0` 或回收期目标 >6 个月；
- 任一 mandatory 安全、CSAT、Repeat Incident、升级/派工、Consent/Region/Retention 护栏失败；
- unknown external effects、disputes、reversals 或 missing data 被忽略；
- 样本不足且仍宣称 superiority；
- Pilot 实施 >20 person-days 且不是客户可归因 change order；
- 第二客户不能复用核心 flow/Connector/Playbook。

Pilot 可以得出“方向性、需更多样本”或“该客户 no-bid”，不能为了付款把 OutcomeClaim 自动
Finalize。

## 7. Profile expansion stop

扩张到第二 flow/团队/区域前必须同时有：

- 3 个同范围付费 Pilot；
- 至少 2/3 完成 Pilot 转年约；
- ≥80% 核心产品/Connector/Playbook 复用；
- ≤20% 客户专属代码/流程工作；
- 标准 Pilot ≤20 person-days；
- 稳态订阅+用量综合毛利 ≥70%；
- fully loaded CAC payback <12 months；
- ≥70% eligible items 获得 agreed flow 能力、每周 ≥60% assigned experts 有效使用；
- 主指标改善且安全、CSAT、复发、升级率非劣效。

任一不满足：停止扩张，修复产品/交付/定位或退出 Resolve v1。新增收入不能掩盖低复用、低毛利
或安全/客户体验下降。

## 8. Win Gate

只有同时满足才 pursue/扩大：

- 买家属于唯一 ICP，Budget Owner/Champion 可审计；
- 一个 agreed flow 频繁、昂贵且视觉/语言/专家协作改变结果；
- 客户愿保留现有 PBX/CRM/FSM Authority 并提供数据/用户；
- 价值池 ≥3×首年总成本；
- A+B1 固定范围可在 12 周/20 person-days 内交付；
- 相对 status quo/竞品的选择理由可由买家陈述，不是内部功能表；
- 安全、DPA、Region、Consent、Retention 和 human accountability 可签署；
- 后续复用/毛利/支持路径成立。

Win Gate 通过也只表示可进行下一阶段，不表示 production eligible。

## 9. Decision ledger

每个 Gate 决策记录：

```text
decision_id
profile/offer/version
gate_id and trigger
input evidence IDs + hashes
decision: pursue | change_order | partner | no_bid | stop | resume
scope and authority impact
owner + independent reviewer
effective_at + expiry/review_at
recovery conditions
supersedes (optional)
```

`resume` 必须引用触发条件已被新 Evidence 解除；不能编辑原 stop。客户身份和合同正文留在受控
存储，Git 只保存 pseudonymous metadata。

## 10. 当前判定

Platform/Resolve 合同可离线审查，但真实 Market、Pilot、ROI、conversion、margin、CAC 和 reuse
均没有 Evidence，保持 `not_run`。因此当前不能：

- 宣称 Resolve market-qualified 或 available；
- 启动依赖 Resolve Market Gate 的 G11/G16；
- 以首发合同为由开发第二 Profile；
- 把 synthetic fixture、供应商公开案例或内部观点当 Win Gate。
