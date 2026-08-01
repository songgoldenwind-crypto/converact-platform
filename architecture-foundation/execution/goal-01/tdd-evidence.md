# G01 TDD Execution Evidence

> Evidence class：development-process evidence
> Market Evidence：false
> Runtime/production Evidence：false
> Date：2026-08-01

本文记录本任务内实际执行过的 RED/GREEN 检查摘要。它不包含客户、合同、运行时或容量事实，
也不能升级 Resolve Market Gate 或 production_eligible。原始输出存在于本任务终端记录；本文
只保留可复查命令、失败条件和修复后的聚焦结果，不伪造未保存的原始日志文件。

## 1. 初始合同 RED

    node --test architecture-foundation/execution/goal-01/goal-01-contract.test.mjs

- RED：11 tests，0 pass，11 fail；机器合同、schema、Evaluator、fixtures、Pilot/Market/ROI/
  competition/trace/review 产物尚不存在；
- 中间态：7/11、8/11、9/11 pass，失败持续暴露 strict schema 与缺失 review；
- 该序列证明测试并非在实现后一次性补写为常绿。

## 2. 逐缺陷 RED→GREEN

| Check | RED 事实 | 最小修复 | 聚焦 GREEN |
| --- | --- | --- | --- |
| 附加价值池保守去重 | expected USD 70,000，actual USD 100,000，0/1 pass | 同 dedupe key 取较小值 | ROI focused 1/1 |
| 唯一 product family/flow | product_family_id undefined，0/1 pass | 固定 led-display-system-v1 与 remote-installation-commissioning-v1@1.0.0 | Profile focused 1/1 |
| Recording Authority | 预期 RustPBX intent/Recording Plane manifest 域不存在，0/1 pass | intent、capture、root manifest 三段拆分 | Profile focused 1/1 |
| 主价值跨池去重 | primary_value_dedupe_key undefined，0/1 pass | 主价值与附加池共用 key，重叠附加项排除 | ROI focused 1/1 |
| Market evaluator | ERR_MODULE_NOT_FOUND evaluate-market-gate.mjs，0/1 pass | 新增确定性 evaluator 与 future-safe schema | Market focused 1/1 |
| 付款口径 | 错误 [0,0,0] schedule 仍 satisfied，0/1 pass | 强制 USD20k、50/25/25、A+B1、签署/书面条件 | Market/schema focused 2/2 |
| Active Call identity | G01 草案错误标为 unpinned；旧 R5 与官方仓库反证 | 固定官方 repo/commit/version/license metadata 与独立 not_run Gate | Competitive focused 1/1 |
| 重复受访者 | 同一 `interviewee_pseudonym` 换 Evidence ID 后 actual 20、expected 19，0/1 pass | schema 强制不可逆 person pseudonym；evaluator 每人最多计一次 | Market/schema focused 3/3 |
| 未来/非法日期 | `interviewed_at/written_at > asOf` 可提前计数，`2026-02-30` 会被 `Date.parse` 归一化 | 严格 UTC RFC 3339 日历校验；拒绝未来值并强制 `written_at < expires_at` | Market/schema focused 4/4 |
| Market 最终批准 | 仅凭 Git metadata 可返回 `qualified` | evaluator 最多返回 `candidate_qualified/satisfied=false`；受控 hash 核验及三方 approval envelope 是外部最终 Gate | Market/schema focused 4/4 |

## 3. 独立审查 RED

首轮独立 AI 审查结论为 NOT READY，记录 4 个 Critical 与 4 个 Important 类别：提前 verified、
Market/Pilot 循环、未固定 flow、Evidence schema 不可演进、Recording Authority、ROI 跨池重复、
负例不具针对性、trace 自证。它是审查 RED，不是人工审计。修复后必须进行第二轮审查；只有
Critical/Important 均归零才写 independent-review.md 的最终 disposition。

## 4. 最终 GREEN

最终独立审查为 Critical 0、Important 0、Minor 0；审查文件落盘后执行：

    node --test architecture-foundation/execution/goal-01/goal-01-contract.test.mjs

fresh 结果：14 tests、14 pass、0 fail、退出码 0。它证明 G01 离线合同 suite 通过，不证明
Market Gate、Runtime 或 production eligibility；这些状态分别保持 `not_run`、`not_run` 和
`false`。
