# Converact Platform Scope and Engagement Domain R2 Documentation Plan

> 本计划仅记录文档迁移步骤、校验命令和完成边界，不依赖任何特定 Agent 框架或工作流插件。

**Goal:** Replace the incorrect “Resolve is the whole Converact platform” framing with one canonical horizontal AI-native communications and execution platform, while retaining Resolve Assist as the first independently gated vertical product profile.

**Architecture:** Add a platform-level R2 above the existing communication R5 and Resolve R1 documents. Introduce `Engagement` and `EngagementItem` as horizontal business concepts, keep `Interaction` as one continuous participation window, and specialize them through versioned profiles such as Resolution. Preserve one authority per fact and decouple horizontal foundation goals from the commercial success of the first vertical profile.

**Tech Stack:** Markdown, JSON, JSON Schema draft 2020-12, SHA-256, `rg`, `jq`, `shasum`.

---

### Task 1: Freeze the platform-scope decision

**Files:**
- Create: `architecture-foundation/docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md`
- Create: `architecture-foundation/docs/adr/ccaas-11-engagement-platform-and-resolution-profile.md`
- Modify: `architecture-foundation/CONTEXT.md`

- [ ] **Step 1: Record the rejected alternatives**

Record and reject both “change marketing copy only while Resolution remains the platform aggregate” and “build an independent core for every vertical”. Select one horizontal Engagement core with versioned domain profiles.

- [ ] **Step 2: Define the canonical language**

Define `Engagement`, `EngagementItem`, `Engagement Profile`, `Product Offer`, `Interaction`, `CommunicationSession`, `Resolution`, `ResolutionItem`, `Evidence`, `Action`, `Task`, and `OutcomeClaim`. State their authority and identifier boundaries without embedding runtime implementation details in the glossary.

- [ ] **Step 3: Define product and deployment layers**

Separate the horizontal platform, vertical profiles, sellable offers, and deployment options. Preserve Overlay, Native Communications, Dedicated VPC/On-prem, OEM/API, and conditional ViLTE as independently gated forms.

- [ ] **Step 4: Verify terminology in the new documents**

Run:

```bash
rg -n "Engagement|EngagementItem|Resolution Profile|Product Offer|首个垂直" \
  architecture-foundation/docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md \
  architecture-foundation/docs/adr/ccaas-11-engagement-platform-and-resolution-profile.md \
  architecture-foundation/CONTEXT.md
```

Expected: every canonical term appears with one consistent meaning; the R2 file explicitly says that Resolve Assist is not the platform boundary.

### Task 2: Reclassify existing product and communication documents

**Files:**
- Modify: `architecture-foundation/docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md`
- Modify: `architecture-foundation/docs/design/unified-communication-foundation-r5.md`
- Modify: `architecture-foundation/docs/design/README.md`
- Modify: `architecture-foundation/README.md`
- Modify: `architecture-foundation/ai-native/README.md`

- [ ] **Step 1: Retain R1 as a vertical profile**

Change its title, metadata, scope, decision list, stop conditions, and review questions so its ICP, pilot, pricing, and ROI gates apply to Resolve Assist only. Add a binding crosswalk from `Resolution`/`ResolutionItem` to `Engagement`/`EngagementItem`.

- [ ] **Step 2: Add the Engagement parent to communication R5**

Keep every R5 SIP/media/Agent decision intact. Add `EngagementId` only as an optional higher-level business correlation and define `Interaction` as the stable identity for one continuous participation window across channel switches.

- [ ] **Step 3: Update navigation and precedence**

Make R2 the product/platform authority, R5 the communication authority, and R1 the first vertical profile. Preserve all old links for auditability.

- [ ] **Step 4: Verify R1 no longer claims platform-wide authority**

Run:

```bash
rg -n "最终产品定位|唯一当前总纲|内部产品类别|平台失败|停止编码扩张" \
  architecture-foundation/docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md \
  architecture-foundation/README.md architecture-foundation/ai-native/README.md
```

Expected: matches are either profile-scoped, supersession explanations, or rejected historical wording; none define Resolve as Converact's total platform boundary.

### Task 3: Correct the Goal program semantics

**Files:**
- Modify: `architecture-foundation/goals/PROGRAM-RULES.md`
- Modify: `architecture-foundation/goals/README.md`
- Modify: `architecture-foundation/goals/goal-00-execution-baseline-and-traceability.md`
- Modify: `architecture-foundation/goals/goal-01-product-domain-commercial-gates.md`
- Modify: `architecture-foundation/goals/goal-02-platform-foundation-security-observability.md`
- Modify: `architecture-foundation/goals/goal-09-resolution-evidence-outcome-core.md`
- Modify: `architecture-foundation/goals/goal-10-human-ai-collaboration-overlay.md`
- Modify: `architecture-foundation/goals/goal-11-minimal-connector-pilot-a.md`
- Modify: `architecture-foundation/goals/goal-12-speech-runtime-hf-translation.md`
- Modify: `architecture-foundation/goals/goal-13-agent-orchestrator-cross-channel-handoff.md`
- Modify: `architecture-foundation/goals/goal-14-action-durable-workflow.md`
- Modify: `architecture-foundation/goals/goal-15-context-knowledge-studio-governance.md`
- Modify: `architecture-foundation/goals/goal-16-v1-pilot-commercial-production.md`
- Modify: `architecture-foundation/goals/goal-17-vilte-future-telecom-conditional.md`

- [ ] **Step 1: Split horizontal and profile gates**

G01 must produce a platform contract gate and a Resolve-profile market gate. A rejected or blocked Resolve market gate must not invalidate communication, Engagement, Speech Runtime, Agent Orchestrator, Action, or Governance contracts.

- [ ] **Step 2: Generalize G09–G15**

Make G09 the Engagement/Evidence/Outcome core plus the first Resolution profile. Make G10 collaboration profile-neutral. Let G12's Speech Runtime core and G13–G15 horizontal capabilities proceed without requiring a completed Resolve Pilot; retain B1/B2/B3 as Resolve-specific gates.

- [ ] **Step 3: Scope G16 and G17 correctly**

Define G16 as Resolve Assist V1 and commercial closure, not completion of the whole Converact platform. Allow G17 to start from communication/platform evidence plus its own signed operator/device demand; do not require Resolve V1 success unless Resolve integration is in scope.

- [ ] **Step 4: Verify no global stop gate is tied to one profile**

Run:

```bash
rg -n "停止.*平台|平台.*失败|G16.*G17|Resolution Core|Resolve Assist 主线" architecture-foundation/goals
```

Expected: every stop/reject statement names the affected profile, offer, capability, or deployment route; horizontal work only stops on its own evidence or safety gate.

### Task 4: Regenerate the machine manifest

**Files:**
- Modify: `architecture-foundation/goals/manifest.json`

- [ ] **Step 1: Update manifest semantics**

Set `manifest_version` to `2.0.0`, register R2 and ADR-11 as source artifacts, update Goal titles, dependency gates, unlocks, entry gates, and all hashes for modified source and Goal files.

- [ ] **Step 2: Validate JSON and schema**

Run:

```bash
jq empty architecture-foundation/goals/manifest.json
npx --yes ajv-cli validate --spec=draft2020 \
  -s architecture-foundation/goals/manifest.schema.json \
  -d architecture-foundation/goals/manifest.json
```

Expected: both commands exit zero and AJV reports the manifest as valid.

- [ ] **Step 3: Validate every registered hash**

Run a read-only shell loop from `architecture-foundation/` that compares every `global_rules`, `source_artifacts`, and `goals` SHA-256 against `shasum -a 256` output.

Expected: zero missing paths and zero hash mismatches.

### Task 5: Perform final documentation review

**Files:**
- Review only: every file listed in Tasks 1–4

- [ ] **Step 1: Check links and placeholders**

Run:

```bash
rg -n '\b(TBD|TODO|FIXME)\b|待补|待定' architecture-foundation
```

Expected: no new unresolved placeholder in the R2 migration; pre-existing historical placeholders are listed explicitly if outside this change.

- [ ] **Step 2: Check scope language**

Run targeted searches for `最终产品`, `唯一`, `首个 ICP`, `Resolve Assist`, `Resolution Core`, and `G16` and review every match manually.

Expected: platform, profile, offer, and deployment-option meanings remain distinct.

- [ ] **Step 3: Check the worktree boundary**

Run:

```bash
git status --short -- architecture-foundation
git diff -- architecture-foundation
```

Expected: only architecture documents, Goal contracts, and manifest files from this plan changed; no runtime, server, container, secret, or LED file was modified.

- [ ] **Step 4: Do not commit an unsafe partial bundle**

Because `architecture-foundation/` is currently untracked inside a heavily dirty repository, do not create a partial commit that would omit referenced bundle files. Commit only after the whole bundle has a safe, explicit staging boundary and user authorization under `PROGRAM-RULES.md`.
