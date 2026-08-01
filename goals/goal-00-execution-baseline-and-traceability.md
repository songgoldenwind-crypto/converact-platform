# Goal 00 — 执行基线与全量追踪

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G00` |
| 初始状态 | `not_run` |
| 前置 Goal | 无 |
| 解锁 | G01；其执行基线被后续 G02–G17 继承 |
| 执行性质 | 只读审计、合同冻结、迁移设计；禁止功能开发 |
| 全局规则 | [PROGRAM-RULES.md](./PROGRAM-RULES.md) |
| 主要来源 | [平台 R2](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md)、[通信 R5](../docs/design/unified-communication-foundation-r5.md)、[R5 实施计划](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md)、[通信 R4](../docs/design/rvoip-converact-communication-foundation-integration-design.md) |

## 2. Binding objective

在不移动、覆盖、清理或重写用户工作的前提下，为整个新 Goal 序列建立唯一、可复现、
机器可读的执行基线。以
`/Users/songjinfeng/Projects/converact-worktrees/platform` 为唯一候选执行根，完整盘点该根、
`/Users/songjinfeng/Desktop/opc`、`/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3`，并只读
核对 `/Users/songjinfeng/Projects/opc-worktrees/legacy-production-20260730` 的冻结边界，把旧 Goal 1–11、R4、R5、
平台 R2、Resolve Profile R1、现有 G01–G07/Collaboration/通信实现及所有未提交改动映射
到新 G00–G17。

本 Goal 只决定“事实在哪里、以后在哪里执行、什么已经证明”。不得把目录整齐或编译通过
误当作架构正确，也不得启动任何产品功能开发。

## 3. Required outcomes

1. 分别固定 canonical root、两棵 legacy source 和冻结生产 worktree 的 repository identity、branch、HEAD、upstream、worktree、submodule、
   staged、unstaged、untracked、ignored、unpushed commit 和大文件事实；输出不得包含凭据。
2. 为每个既有提交和本地文件标注 `user_owned`、`prior_codex`、`generated` 或
   `unknown_provenance`；未知归属不得猜测。
3. 建立旧 Goal 1–11、R4/R5 delta、平台 R2、Resolve R1 W0–W10、Revision 3 review、rvoip 已分析能力、
   G.729、RTPengine、LiveKit 切换、HF Speech、ViLTE 和生产证据的逐项追踪。
4. 对重叠实现建立 ledger：Authority、接口、状态机、持久模型、SIP/RTP/media、AI、
   Connector、Engagement、Resolution Profile、Collaboration、测试和文档分别标注 keep、absorb、migrate、
   quarantine、delete-after-drain 或 unresolved。
5. 验证 `canonical_execution_root=/Users/songjinfeng/Projects/converact-worktrees/platform`，记录
   品牌迁移提交、来源账本、legacy source 保留角色、剩余文件级迁移顺序和回滚方式；不得
   重新选择旧 `converact`/`converact-v3` 目录或自动授权移动、删除文件。
6. 为所有能力记录 `current`、`target`、`production_eligible` 与 Evidence URI；没有原始
   Evidence 的状态保持 `not_run`。
7. 固定后续 Goal 的 branch/commit/staging 规则、源文件目录、测试目录、合同目录和 Evidence
   目录；后续计划必须使用这里记录的精确路径。
8. 建立 requirement ID 稳定命名和 supersede 关系，保证旧目标被取代但要求不丢失。

## 4. Required artifacts

全部输出到 `architecture-foundation/execution/goal-00/`：

- `execution-baseline.md`
- `workspace-inventory-v1.json` 与 `workspace-inventory-v1.schema.json`
- `requirement-traceability-v1.json` 与 `requirement-traceability-v1.schema.json`
- `overlap-and-authority-ledger.md`
- `canonical-execution-root-decision.md`
- `file-level-migration-sequence.md`
- `status-and-evidence-registry-v1.json` 与对应 schema
- `independent-review.md`
- `2026-07-31-goal-00-execution-plan.md`

JSON 必须通过其 schema；Markdown 中的本地链接必须可解析；所有输入文件记录 SHA-256。

## 5. Work order

1. 只读采集 canonical root、两棵 legacy source、冻结生产边界和所有绑定源文件。
2. 先建立 schema 和失败的 fixture validation，再生成 inventory/trace/registry。
3. 逐项比对旧 Goal 与新 Goal；任何无法归属的要求进入 unresolved，不得静默删除。
4. 验证预选 canonical root 与来源账本，形成所有 legacy source 都不受损的剩余迁移序列。
5. 对 inventory、trace、hash、链接、状态语义和 Git 安全做独立复核。
6. 只提交本 Goal 的干净文件；若无法隔离 unrelated staged hunks，则不提交并记录原因。

## 6. Acceptance gates

- canonical root、legacy source 和冻结生产 worktree 的 HEAD、dirty/untracked/unpushed 事实可由命令重放，且没有工作被改变。
- 每个旧要求恰好映射到一个或多个新 Goal，或以理由进入 `rejected`/`deferred`；计数闭合。
- 每个新 Goal 均有 Authority、依赖、输入、输出、Evidence 和 Stop Gate。
- `canonical_execution_root` 唯一且为 Converact canonical path；legacy source 的保留与迁移策略明确到文件/提交层。
- 所有 JSON schema、hash、链接和 trace 完整性检查通过。
- 独立审查没有未解决的 Authority 冲突、需求遗漏或用户工作破坏风险。
- 没有修改产品源码、服务器、容器、数据库、Feature Flag 或远程分支。

只有以上 Gate 全部通过，G00 才能标记 `completed`。任何未证明项保持 `not_run`。

## 7. Explicit non-goals

- 不合并、不 cherry-pick、不复制产品代码。
- 不修复编译、测试、媒体、AI 或 UI 问题。
- 不删除旧文档、旧 Goal、旧分支或重复实现。
- 不把设计文件存在等同于实现存在。
- 不 push，不接触生产运行时。

## 8. Completion and commit boundary

建议提交意图：`docs(program): freeze execution baseline and traceability`。

提交前必须展示精确 staged file list、通过的验证命令和 unresolved 清单；无法安全隔离时保持
未提交，不得用全量暂存绕过。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-00-execution-baseline-and-traceability.md`
using its SHA-256 from
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/manifest.json`.
Also obey PROGRAM-RULES.md. This summary exists only because create_goal has a
length limit.

Audit both existing Converact worktrees without changing user work. Freeze a
machine-readable inventory, old Goal/R4/R5/platform-R2/Resolve-R1 requirement trace, overlap and
Authority ledger, evidence/status registry, one canonical execution root, and a
file-level non-destructive migration sequence. Do not implement features, move
code, modify runtime, push, or fake evidence. Anything unproved remains not_run.
Complete only after schema/hash/link/trace validation and independent review.
```
