# IPPBX 行业研究审查与未来 Goal 增补计划

**Goal:** 把《IPPBX 呼叫中心 AI 机器人部署技术研究（2026）》中可验证的趋势转化为
Converact 的向前兼容架构决策和 G10–G16 绑定增补，同时保持当前 G03 的 manifest、Goal
文件、授权链和 Evidence 不变。

**Architecture:** 现有 `goals/manifest.json` 已被 G02→G03 amendment 以精确字节冻结，不能
改写。新增一份非权威研究审查、一份具有优先级的 additive ADR，以及一份经过 schema 和
resolver 验证的 future-goal amendment overlay。未来启动 G10–G16 时同时绑定原 Goal 与
overlay；G03–G08 的 Authority、依赖、状态和执行顺序不变。

**Tech Stack:** Markdown、JSON Schema 2020-12、Node.js、Ajv、`node:test`、SHA-256。

---

### Task 1：冻结研究来源与采用裁决

**Files:**

- Create: `docs/architecture/2026-08-09-ippbx-contact-center-ai-industry-analysis-adoption-review.md`
- Create: `docs/adr/ccaas-12-policy-driven-speech-and-tool-adapter-boundaries.md`
- Modify: `docs/architecture/ai-native-platform-index.md`

- [x] 固定 PDF 文件名与 SHA-256，记录文章缺少可复现实验方法和完整引用清单。
- [x] 固定补充分析 SHA-256，区分可采纳设计、厂商信号、行业预测和产品定位。
- [x] 按 `verified_primary/vendor_reported/unverified/rejected` 分类关键主张。
- [x] 按 `adopt/qualify/reject/defer` 固定 Converact 处理方式。
- [x] 冻结 `SpeechModePolicy`、HF overlap-only、Disclosure/Consent 分离、主动 Handoff、
      MCP Tool Adapter 与 Action Authority 边界。
- [x] 增补 `InteractionExecutionPolicy`、ConversationPerception observation、Human/AI
      collaboration roles、Context epistemic state 和跨层 Evaluation；不新增 Authority。
- [x] 明确所有外部延迟、准确率、成本、并发、转码 CPU 和 containment 数字保持 `not_run`。
- [x] 在 AI-native 索引中标明研究文档非权威、ADR 为 additive precedence。

### Task 2：先写 future-goal overlay 的失败测试

**Files:**

- Create: `goals/future-goal-amendment.test.mjs`

- [x] 测试 base manifest 精确 SHA-256 仍为
      `11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912`。
- [x] 测试 G10、G12–G16 原文件 SHA-256 与 base manifest 一致。
- [x] 测试 schema、amendment 和 resolver 文件缺失时失败，记录预期红灯。
- [x] 测试 drifted manifest、goal、target、requirement ID 和 Authority 提升被拒绝。
- [x] 测试 schema 自身拒绝 scope、target order、clause ownership 和 clause text 的 hostile drift。
- [x] 测试 resolver 只增加 binding clauses，不修改原 Goal 的依赖、状态、哈希或 Authority。

### Task 3：实现 binding future-goal amendment overlay

**Files:**

- Create: `goals/amendments/future-goal-amendment-v1.schema.json`
- Create: `goals/amendments/2026-08-09-ai-speech-action-program-amendment-v1.json`
- Create: `goals/amendments/2026-08-09-ai-speech-action-program-amendment-v1.md`
- Create: `goals/amendments/README.md`
- Create: `goals/resolve-future-goal.mjs`
- Modify: `goals/README.md`

- [x] 绑定 base manifest、G10/G12/G13/G14/G15/G16 的精确路径和 SHA-256。
- [x] G10 增补 Disclosure Receipt、Consent 分离与主动 Handoff 基础合同。
- [x] G10 增补 Human/AI collaboration role、lease、permission 和 receipt。
- [x] G12 增补五模式 SpeechModePolicy、HF exact-source overlap-only、同源端到端 A/B、
      codec/language/dialect/noise/VAD/provider-exit 独立资格。
- [x] G12 增补 ConversationPerception observation/provenance 和高风险信号独立资格。
- [x] G13 增补 InteractionExecutionPolicy、带 fence 的阶段/turn 换路、政策驱动主动 Handoff、
      上下文完整性和恢复指标；Unknown 不阻塞人工通信。
- [x] G14 增补 MCP version/capability/digest/auth/security/Unknown reconcile 合同。
- [x] G15 增补 RAG/source/index poisoning、伪引用、tool-description injection、复杂多步指令
      与带 provenance 的语言/方言 cohort。
- [x] G15 增补 Context 事实可信度和 Perception/Agent/Action/Outcome 跨层 Evaluation。
- [x] G16 增补 provider exit、数据可携带、全成本、地区披露政策、协作连续性和
      cost-per-verified-resolution 商业 Gate。
- [x] resolver 验证 amendment 后返回 additive clauses；禁止 target G03、改依赖、改状态或
      宣称 upstream benchmark 为 Evidence。

### Task 4：验证与独立审查

**Files:**

- Test: `goals/future-goal-amendment.test.mjs`
- Test: `goals/goal-gate-amendment.test.mjs`

- [x] 运行 `node --test goals/future-goal-amendment.test.mjs`，预期全部通过。
- [x] 运行 `node --test goals/goal-gate-amendment.test.mjs`，证明 G03 授权链未漂移。
- [x] 运行 manifest/schema 哈希检查、链接检查、placeholder scan 和 `git diff --check`。
- [x] 独立审查 Authority、目标覆盖、Evidence 状态和 create_goal 启动规则。
- [x] 精确暂存本计划相关文件并创建单一文档/合同提交；不暂存历史 dirty README。

### Task 5：恢复 G03 下一窄切片

**Files:**

- Read: `architecture-foundation/execution/goal-03/2026-07-31-goal-03-sip-call-tdd-plan.md`
- Read: `/private/tmp/converact-g03-rustpbx56.DiyIYt/rsipstack` 当前临时实验状态
- Read: `/private/tmp/converact-g03-rustpbx56.DiyIYt/rustpbx` 当前临时实验状态

- [ ] 重新核对 G03 当前 trace、下一项和 canonical/temporary 差异。
- [ ] 保留临时实验为候选，不将未验证实现直接复制到 canonical。
- [ ] 先运行失败测试，再完成最小实现、focused verification 和独立 review。
- [ ] 只在证据成立时精确暂存并提交；未证明项继续 `not_run`。
