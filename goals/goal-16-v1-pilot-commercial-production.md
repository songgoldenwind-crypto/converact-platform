# Goal 16 — Resolve Assist V1、商业化与 Profile 生产闭环

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G16` |
| 初始状态 | `not_run` |
| 前置 Goal | G01 `resolve_market_gate_completed`；G02、G09、G10、G11 `completed`；G12 `resolve_b1_completed`；G13–G15 仅对本 Offer 纳入的能力适用；G03–G08 仅对 Native/Bridge Deployment Option 适用 |
| 解锁 | Resolve 第二流程/规模扩张；为 Horizontal Platform 提供首个 Profile 复用 Evidence |
| Authority | Resolve Assist Offer Release、商业资格与 production eligibility finalizer |
| 主要来源 | [平台 R2 §3、§10–§13](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 §15–§22](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md)、[通信 R5 mixed-cell](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md) |

## 2. Binding objective

把前三个真实付费 Pilot 的同一 `resolution` Profile 主流程收敛为可复制、可支持、可盈利的
`Converact Resolve` V1 Offer。Milestone A 和必验 B1 均必须通过；至少两个 Pilot 转年约，并以真实 ROI、复用率、
实施工作量、单位经济、可靠性、安全、长会话、故障恢复和 production evidence 决定是否
扩张。功能完成、客户验收、商业资格和 production eligibility 分开签署。

不得在当前冻结的旧服务器上升级容器。任何 Pilot/production rollout 必须使用独立目标环境，
并在用户另行明确授权后执行；Git push 同样需要明确授权。

## 3. Required outcomes

1. 三个付费 Pilot 使用一个 ICP、一个主流程、同一 scope/acceptance、一个 provider-specific
   Adapter、一个 CRM/FSM Connector 和 B1 中文↔英文翻译。
2. 每个 Pilot 固定 baseline、eligible/excluded items、sample/power、consent、region、
   VerificationPolicy、Milestone A/B1、incident/change order 与 outcome observation。
3. 完成至少两个可公开或受控审计的 ROI case；远程解决、派工避免、FCR/FTF、MTTR、
   expert leverage、installation success 与 guardrails 可重算。
4. 至少 2/3 Pilot 转年约；记录 win/loss、价格、范围、支持、安全/法务与真实 CAC。
5. 公共产品/Connector/Playbook 复用率 `>=80%`，客户专属代码/流程 `<=20%`，标准 Pilot
   实施 `<=20 person-days`。
6. 稳态订阅+用量综合毛利 `>=70%`；线路/SFU/GPU/模型/存储/支持/Credit/Reversal 按
   Resolution 可归因；founder-led CAC payback 目标 `<12 months`。
7. `>=70%` eligible items 具备 Pilot 能力；每周 `>=60%` assigned experts 有有效使用，
   客户阻塞和系统不可用分开归因。
8. 完成 production release manifest、SBOM、signing、secret/key、migration、backup/restore、
   rolling upgrade/drain、rollback、DR、on-call、SLO/alert、incident 和 support runbook。
9. 完成 short/30m/2h/8h、B1 Speech、Resolution/Action、recording、fault matrix 与成本
   Evidence；只有本 Offer 选择 Native/Bridge Deployment Option 时，才强制加入对应通信
   profile、Bridge、mixed-cell 与容量 Gate；optional B2/B3 只在自身 Gate 通过时进入。
10. 建立 current/target/production_eligible/customer_available 五态目录和销售材料审核，
    禁止将 planned/option/not_run 宣传为 available。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-16/`：

- `v1-release-and-commercialization-plan.md`
- `pilot-evidence-register-v1.json` 与 schema
- `roi-and-unit-economics-report.md`
- `reuse-customization-delivery-report.md`
- `production-release-contract-v1.json` 与 schema
- `production-fault-dr-long-session-matrix-v1.json` 与 schema
- `security-privacy-compliance-release-review.md`
- `sales-claims-and-availability-register-v1.json` 与 schema
- `rollout-rollback-support-runbook.md`
- `2026-07-31-goal-16-v1-closure-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-technical-commercial-review.md`

客户数据、合同和 PII 存在受控系统；Git 只保存脱敏指标、权限引用和 digest。

## 5. Execution order

1. 在编码前复核三 Pilot 是否仍为同一产品；定制分叉触发 change order/no-bid。
2. 为每个 Pilot 建立冻结 baseline/acceptance 与 data collection，不事后选择有利指标。
3. 在独立 staging/pilot 环境完成 release、migration、failure、DR、security 和 load rehearsal。
4. 取得用户明确 rollout 授权后，按 canary→progressive→rollback-safe 推进；旧服务器保持不变。
5. 运行 12 周 Pilot、Milestone A/B1 和 observation；保留失败/退出样本。
6. 计算 ROI、复用、实施、毛利、CAC、adoption 和 guardrail；完成客户 verification。
7. 由独立技术、安全、产品和商业审查共同签署 V1/production/commercial 状态。

## 6. Acceptance gates

- 3 个真实付费 Pilot，至少 2 个转年约；没有把 LOI、免费试用或内部演示算付费。
- 三家共用一个主流程；复用、定制、实施、adoption、毛利和 CAC 达到上述阈值。
- Milestone A 与 B1 各自通过；客户可以查询 Evidence、Outcome、Receipt、Dispute/Reversal。
- 主业务指标改善，安全、CSAT、复发、升级率、媒体质量和人工可用性非劣效。
- release/rollback/DR/key rotation/restore/long session/fault/capacity 有原始 Evidence；所选
  Deployment Option 的测试不得借用其他 Option 的结果。
- 任何单故障不会跨 Authority 扩散；AI/Knowledge/Action optional failure 不拖垮人工主链。
- 销售 claims 与机器 status 一致；未签 profile/optional 不对外宣称 available。
- 只有用户明确授权的独立环境发生 rollout；旧服务器容器未变。

任一真实客户/商业 Gate 未达时，G16 为 `blocked_external` 或 `rejected`，不能以工程完成
代替。Stop Gate 触发时暂停 Resolve 第二流程、定制和团队扩张；不否定 Horizontal Platform，
也不自动阻塞已有独立 Gate 的其他 Profile/Offer/Deployment Option。

## 7. Explicit non-goals

- 不因日历到期自动扩展第二行业、语言、Provider、CRM 或 Agent。
- 不用三个客户的三套 Fork 换取收入数字。
- 不把 B2/B3、Native Communications、OEM 或 ViLTE 强塞进 V1。
- 不把 Resolve V1 的通过或失败冒充 Converact 整个平台完成或失败。
- 不在旧服务器就地升级，不在未授权时 push/deploy。
- 不用选择性样本或厂商数据包装 ROI。

## 8. Completion and commit boundary

工程 Release、各 Pilot Evidence、商业报告与最终签署分开提交。只有技术、客户、商业和
production Gate 全部通过才为 `completed`；否则保留真实状态和 Stop decision。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-16-v1-pilot-commercial-production.md`
using its manifest SHA-256 after the Resolve market gate, G02/G09/G10/G11,
the G12 Resolve B1 gate, and only the G13-G15 or G03-G08 capabilities selected
by this Offer/Deployment Option. Obey PROGRAM-RULES.md.

Turn one shared Resolve Assist flow into V1 through three real paid pilots,
Milestone A plus mandatory B1, and at least two annual conversions. Prove
auditable ROI, >=80% reuse, <=20% customization, <=20 person-days
implementation, >=70% steady gross margin, adoption and non-regression.
Qualify signed release/SBOM, security, migration, rollback, DR, long sessions,
faults, speech/action and support; require communication/bridge/mixed-cell
capacity only for the selected Native/Bridge option.
Separate code, customer acceptance, commercial and production status. Never
change the frozen legacy server; any independent rollout or push needs explicit
user authorization. Do not hide failed samples or market gates, and do not
generalize this Profile result to the whole platform. Missing gates mean
blocked_external/rejected, and unproved claims remain not_run.
```
