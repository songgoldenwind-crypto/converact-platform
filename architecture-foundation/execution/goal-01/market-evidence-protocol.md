# Resolve Market Evidence Protocol

> Evidence register：`interview-and-demand-evidence-register.json`
> 当前真实计数：0 合格访谈、0 签署 Pilot、0 有期限付费承诺
> Market Gate：`not_run`
> Synthetic fixture、内部意见、演示和供应商材料一律不是市场 Evidence

## 1. Gate 目的

本协议只回答：同一 Resolve ICP 是否存在真实、可采购、可重复的付费需求。它不评估运行时
性能，也不把 Platform Contract 当市场需求。

Market Gate 必须同时满足：

- 至少 20 次可审计 Budget Owner/Champion 访谈；
- 至少 3 个不同组织验证同一个 agreed flow；
- 其中至少 1 个组织已签署 USD 20,000、A+B1 同范围 Pilot；
- 另外 2 个组织有明确金额/范围/审批路径/到期日的书面付费承诺；
- 三个组织均有可审计价值池、预算来源和数据可得性；
- 不是三个定制项目，也不是无预算“愿意试用”。

首份合同允许是 `signed_conditional`：它只能在 Platform/Resolve Contract、唯一 ICP/product
family/flow、价值/预算/数据、固定 A+B1 Order Form、采购路径和有效期均完成预资格后签署。
签署必须形成 USD 20,000 与 50%/25%/25% 的真实付款义务，不能是免费试用或零金额 LOI。
签署本身可满足 Market Gate 的“1 份签约”席位，但不激活交付、不证明 Capability 或 Runtime，
也不把 Offer 公开状态升级为 `pilot`。激活条件见 Pilot 合同，因而不存在自循环 Gate。

## 2. 招募与样本纪律

合格组织必须符合首发 ICP：向美国/英语市场提供 LED 显示系统、由中国专家支持美国现场首次
安装调试的中国出口企业，保留现有电话和 CRM/FSM，并有可测的派工、停机、返工或专家等待
成本。所有 Evidence 必须绑定 `led-display-system-v1` 与
`remote-installation-commissioning-v1@1.0.0`。

合格访谈者必须是：

- `budget_owner`：拥有售后/服务运营或数字化预算；或
- `champion`：能实际推动电话、CRM/FSM、工程师和现场流程，并能引荐 Budget Owner。

同一人重复访谈只算一次 qualifying interview；同一组织可以有多个角色访谈，但 Market Gate
报告必须同时给出访谈数和 distinct organization 数。供应商、顾问、内部员工、无采购影响者、
匿名问卷、展会扫码和演示参与者不算合格访谈。

招募应记录来源渠道和拒访/不合格原因，防止只选择已有关系的乐观样本。不得用第二行业或第二
flow 凑足数字。

## 3. 访谈提纲与必须取得的事实

访谈不以介绍产品开场；先复盘最近发生的真实案例。至少取得：

1. 最近一次同类 LED 显示系统首次安装/调试未通过事件的触发、参与人、渠道、系统和时间线；
2. 问题是否需要看到现场、跨语言、专家、派工、返工或停机；
3. 当前电话/视频/消息/CRM/FSM 的正式 Authority 与失败点；
4. 每年 eligible volume、baseline avoidable rate、每次价值和客户变更成本的来源；
5. 预算归属、预算周期、采购/InfoSec/DPA/Region/集成门槛；
6. 对一个团队/产品族/flow、12 周、USD 20k、A+B1 的明确反应；
7. 会替代或比较的产品/现状，以及 Win/No-bid 原因；
8. 数据、用户、Provider、CRM/FSM 沙箱和 human verifier 能否按期提供；
9. 决策人、下一步、日期和什么事实会导致拒绝。

只记录可核查原话摘要和证据引用，不把销售人员解释当客户事实。访谈记录需要 interviewer 与
second reviewer，分歧标 `disputed`。

## 4. Evidence 等级

| 等级 | 允许证明 | 不允许证明 |
| --- | --- | --- |
| Interview fact | 某角色陈述的真实流程、成本、预算/数据条件 | 市场规模、签约或产品效果 |
| Buyer-confirmed baseline | 来源查询、口径和负责人确认的 volume/rate/value | Pilot 改善或年化结果 |
| Time-bound paid commitment | 有组织、flow、金额/价格接受、审批步骤和到期日的书面承诺 | 已签合同或已收款 |
| Signed Pilot contract | 双方签署 USD 20k A+B1 scope、付款、DPA/责任 | Pilot 成功、转年约或生产资格 |
| Paid invoice/receipt | 实际付款事实 | Outcome 或 ROI |
| Pilot outcome evidence | 预签口径下的真实运行结果 | 其他行业/Profile 或平台整体结果 |

“有兴趣”“愿意免费试用”“给我发材料”“老板可能支持”、LOI 无价格/到期日、供应商合作意向、
内部测试账号和概念演示均不算 paid commitment。

## 5. Git 与受控存储

Git 只保存：

- `evidence_id`；
- `organization_pseudonym`（如 `ORG-7F2A`）与不可逆的 `interviewee_pseudonym`
  （如 `SUBJ-8C2D`）；映射表和生成密钥都不进 Git，只进入受控存储；
- `product_family_id`、`flow_id`、`flow_version`、`role_class`、日期和
  same-flow/价值池/预算/数据布尔事实；
- 至少两个不重复的 reviewer pseudonym；Commitment 还需关联本组织已合格 Interview ID、
  Offer、USD 金额、A+B1 scope、书面/签署状态与有效期；
- `controlled://...` 引用、SHA-256、review status 和版本；
- 聚合计数与缺失项。

姓名、邮箱、电话、公司映射、合同正文、商业机密、录音、凭据、签名和原始价值数据只进入经
批准的受控存储，按 Tenant/Region/Retention/least privilege 管理。受控对象每次修改生成新
immutable revision/hash；Git 不保存可逆 pseudonym key。

在收集前说明目的、记录方式、保留、访问、跨境和撤回；适用的录音/转写/翻译 Consent 分开。
客户 DPA/法律审批决定处理合法性，本协议不替代法律意见。

## 6. Register 更新流程

```text
capture in controlled store
→ assign pseudonymous evidence_id
→ hash immutable revision
→ primary reviewer classifies
→ second reviewer verifies role/scope/value/budget/data
→ append metadata to Git register
→ `evaluate-market-gate.mjs` 从 qualified、非未来、unexpired、exact-flow、distinct person/evidence 重算汇总
```

更新必须使用窄提交，说明新增/拒绝/过期/争议的 evidence IDs，不能覆盖旧结论。承诺到期、撤回、
合同取消或发现角色不合格时保留记录并降为 `expired/rejected/disputed`；聚合计数相应减少。

一个组织不能同时充当“签署 Pilot”和“另外两份承诺”中的多个席位。Commitment 必须关联至少
一条合格访谈和同一 `offer_id/flow_version`。

`summary` 与 evaluator 的 `candidate_satisfied` 是派生投影，不是 Market Gate Authority。每次
更新必须由 evaluator 重算；即使数量、范围与商业事实全部满足，evaluator 也只能输出
`candidate_qualified`，并保持 `satisfied=false`。受控存储中的原始对象逐项 hash 校验成功，且
产品、商业和独立 reviewer 对同一 immutable approval envelope 签署后，外部 Gate Authority
才能生成最终 `qualified` Receipt；该 Receipt 合同与 verifier 不在 G01 内实现。

手写计数、把 `satisfied=true` 填入 JSON、同一受访者重复计数、未来日期、无效承诺时间窗、
零金额/未签 Pilot、错 flow、过期承诺、缺 Interview 链接或同组织重复占位均 fail closed，不能
通过 schema/evaluator Gate。

## 7. 判定算法

Market Gate 仅计入：

- `review_status=qualified`；
- evidence hash 可读取并匹配；
- 访谈/承诺时间不晚于 evaluator `asOf`，承诺 `written_at < expires_at`，且未过期/未撤回；
- 每个不可逆 `interviewee_pseudonym` 最多计一次；
- role、organization、flow、value/budget/data 条件完整；
- 不含 synthetic、内部或供应商 Evidence；
- 一份签署 Pilot 的 amount/scope/payment 与 v1 合同匹配；
- 另两份承诺来自不同组织并有未来到期日。

任一事实 `unknown` 时 fail closed，不计入阈值。所有时间必须是严格、日历有效的 UTC RFC 3339
值；不接受自动归一化日期或本地时区。Market Gate 更新需要产品、商业和独立 reviewer 对同一
受控 approval envelope 三方签署；销售负责人不能单独升级。

## 8. 访谈与承诺分析

每 5 次访谈预注册一次 checkpoint，报告：

- ICP 合格/不合格、角色和渠道分布；
- 同一 flow 的发生频率与重要性；
- 价值池可得性、预算来源、数据/集成门槛；
- status quo 与竞品；
- 对 Pilot scope/price 的接受、拒绝和条件；
- 新定制需求进入公共产品层的比例；
- disconfirming evidence 和 no-bid 触发。

不得因早期反馈不断改变 flow 后仍把全部 20 次相加。若 ICP、flow、价格或 Outcome 发生实质
变化，创建新 Evidence cohort/version，并重新达到阈值。

## 9. Stop 与 no-bid 输入

以下市场事实触发停止/重定位：

- 客户只要便宜视频、传统 CCaaS、工单系统或按分钟低价 Bot；
- 不提供 baseline/value/budget/data；
- 三个组织要求三个不共享的 flow/Connector/媒体 Fork；
- 标准 Pilot 无法在 20 person-days/一个 Provider/一个 CRM/FSM 内交付；
- 价值/首年成本低于 3×；
- 采购/合规/区域要求只有大规模定制才能满足；
- 安全、CSAT、复发或升级护栏不可接受。

该结论只停止 Resolve v1。它不证明 Horizontal Platform 失败，也不自动授权另一个 Profile。

## 10. 当前精确外部阻塞

截至本合同 revision，仓库没有任何合格真实 Evidence。缺失：20 次访谈、1 份签署 USD 20k
Pilot、2 份有期限付费承诺，以及真实 value/budget/data evidence。因此：

- Resolve Market Gate 保持 `not_run`；
- G11/G16 的 Resolve 路线不解锁；
- 不声称 Resolve market-qualified、paid design partner 或 product-market fit；
- 可以继续的只有招募、受控 Evidence 收集和合同更新；
- synthetic ROI fixtures 只证明工具计算，不进入本 Register。
