# Copilot instructions for this repository

## Current product (2026.06)

Build a **vertical AI video + voice call center platform** (RustPBX soft switch + LiveKit video).

Core loop:

1. AI outbound video/voice call to qualify intent
2. High-intent leads transfer to human video agents
3. Deliver billable outcomes (appointments / qualified leads)
4. Record, review, and feed results back into CRM/tasks

## Mandatory docs to read first

Before product or code work, read these active docs:

1. `docs/architecture-video-voice-callcenter.md`
2. `docs/product-direction-2026-06.md`
3. `docs/new-feature-application-checklist.md` (when touching existing lead-acquisition code)

Do **not** read archived docs by default:

- `archive/legacy-lead-acquisition-direction/` — old lead-acquisition / Phase D refactor direction
- `archive/old-xhs-direction/` — Xiaohongshu scraping direction
- `docs-archive/legacy-broad-platform/` — early broad-platform PRDs

Only read archives when explicitly asked for historical context.

## Product priority

Default P0 direction:

**Call center mainline** — outbound dialer, LiveKit rooms, AI agent session, agent desk, CDR/recording, transfer orchestration.

Existing `lead-acquisition/` code is a **reusable foundation** (tenant, approval, memory, scripts) but not the active product doc north star.

## Do not default to these

Unless explicitly requested, do not prioritize:

1. prospect-outreach public-source scraping expansion,
2. Phase D/E materialize refactor batches,
3. broad admin/platform consoles,
4. generic marketing automation,
5. restoring root-level `OPC*.md` planning docs.

## One decision filter

Every feature must answer:

> Does it move us closer to a working AI video/voice outbound + human handoff loop?

If not, it is support/future/archive by default.
