# Project Instructions

These instructions were migrated from Cursor project rules (`karpathy-guidelines.mdc` and `phase-d-continuous.mdc`).

---

## Karpathy behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 当前产品方向（2026.06）

**企业级 AI 通信平台**（对标 Genesys + Avaya + Zoom + AI Agent）。技术底座：RustPBX 软交换（SIP/PSTN）+ LiveKit（视频 SFU）+ LiveKit Agents（AI 对话）。活跃文档：

1. `docs/design/architecture-v3.md` — 完整架构 v3（执行级规格，对标 Genesys/Avaya/Zoom）
2. `docs/design/revised-master-plan.md` — 修订版总体规划（12 Sprint 路线）
3. `docs/design/product-design.md` — 产品设计（User Personas + 功能优先级 + MVP 边界）
4. `docs/design/gap-analysis.md` — 存量代码 vs 修订计划 Gap 分析
5. `docs/architecture-video-voice-callcenter.md` — 视频+语音呼叫中心底座架构
6. `docs/product-direction-2026-06.md` — 产品方向总纲
7. `docs/phase0-detailed-design.md` ~ `docs/phase4-detailed-design.md` — Phase 0-4 详细设计
8. `docs/new-feature-application-checklist.md` — 新增功能准入清单（call-center/voice-agent 域）
9. `docs/voice-agent-spec-v1.md` — VoiceAgentSpec v1 契约
10. `docs/design/metrics-design.md` — 指标与可观测性设计
11. `docs/design/security-design.md` — 安全与合规设计

历史获客 Agent / Phase D 重构 / 小红书方向文档已归档（移出本仓库，存于 `~/Desktop/converact-archive/`），**不要**按归档文档继续开发，**不要**从归档代码引入依赖。

### 验证

- `npm run typecheck` — TypeScript 类型检查（0 错误）
- `npm run test:call-center-s12` — Sprint 12 差异化测试（11/11）
- `npm run test:phase3-platform` — Phase 3 坐席面板测试（3/3）
- `npm run test:callcenter` — call-center 全量测试（typecheck + phase1 + ai-agent）

---

## Agent skills

### Issue tracker

Issues and PRDs live as local markdown files under `.scratch/<feature>/`. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles map 1:1 to `Status:` values in issue files: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (no `CONTEXT-MAP.md`). See `docs/agents/domain.md`.
