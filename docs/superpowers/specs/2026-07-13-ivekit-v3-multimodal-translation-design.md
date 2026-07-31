# iveKit V3 Multimodal Intelligence and Translation Design

Date: 2026-07-13

Status: approved for implementation under the active iveKit V3 Goal

Branch: `codex/ivekit-v3-multimodal-translation`

Baseline: `830400254bbc9b3bfaa4fa32f43a6d0500383d94`

## 1. Objective

iveKit V3 productizes reusable OCR, ASR, AI anti-circumvention review, human review, and translation inside the V2 standalone service boundary. OPC, LED, and future hosts consume the same PostgreSQL-backed `/api/ivekit/*` and `@opc/ivekit-sdk` contracts without importing call-center code or receiving provider credentials.

V3 must support both self-hosted and third-party providers without selecting a mandatory vendor. A deployment may configure either or both modes. Tenant policy selects an allowed provider profile and controls automatic processing; credentials remain deployment-owned environment secrets.

## 2. Scope

### 2.1 Required

1. Image OCR for message attachments.
2. ASR for audio, video, screen recordings, LiveKit recordings, and remote-assistance recording evidence.
3. AI-assisted anti-circumvention review over bounded message/OCR/ASR content.
4. Tenant-wide human review queue plus the existing finding detail and immutable review audit.
5. Manual and policy-driven translation of message text and extracted attachment text.
6. Self-hosted and third-party provider profiles for OCR, ASR, quality review, and translation.
7. Tenant policy, provider health, secret-safe preflight, durable jobs, retry, idempotency, RLS, audit, events, SDK, reference UI, deployment, and delivery artifacts.
8. Controlled provider, real PostgreSQL, browser, standalone build, and isolated server acceptance.

### 2.2 Not Included

1. Selecting or certifying a specific OCR, ASR, AI, or translation vendor.
2. Training models or maintaining GPU inference runtimes in this repository.
3. Real-time streaming ASR, live screen-frame OCR, or in-call blocking. V3 processes durable objects asynchronously.
4. SIP/VoLTE, RTMP/HLS, or digital humans.
5. OPC call-center QM, CRM disposition, agent scheduling, or outbound campaign policy.

## 3. Baseline Audit

### 3.1 Existing Capabilities to Preserve

| Area | Existing implementation |
| --- | --- |
| OCR/ASR provider | Generic multipart HTTP adapters with self-hosted/third-party mode, timeout, token, normalized output |
| Attachment jobs | PostgreSQL job table, tenant RLS, lease, retry, terminal failure, object read, extraction fields, policy rescan |
| Quality review | Durable per-message job, input hash, retry/lease, generic HTTP provider, safe finding output |
| Human review | Unified text/OCR/ASR/AI findings, transition validation, immutable review audit, session UI |
| Translation | `collaboration_message_translations` table and low-level `addTranslation()` store method |
| Deployment | OCR/ASR/quality environment variables, workers, Compose/Kubernetes surfaces, static preflight |
| Client | Attachment states, findings projection, per-session finding review panel |

### 3.2 Gaps V3 Must Close

1. Provider configuration is global and single-profile; there is no tenant policy or profile routing.
2. Provider health is not callable through a secret-safe iveKit operations contract.
3. `screen_recording` is not mapped to ASR, and existing media/remote recording objects cannot be imported into the attachment pipeline by stable ID.
4. Translation has no provider, durable job, list/retry API, SDK, event, or UI.
5. Human review is session-local; there is no tenant review queue for repeated operational work.
6. Provider metadata and source references need one shared sanitizer and bounded schema.
7. The attachment provider currently receives the raw `storage_url`; V3 must send bytes plus an opaque iveKit source reference instead.
8. Capabilities report environment configuration only and does not combine deployment readiness with tenant policy.

## 4. Considered Approaches

### 4.1 Extend the Existing Durable Pipelines (Selected)

Keep attachment processing, quality review, policy findings, and V2 tenant events as the execution foundation. Add tenant policy and provider routing in front, recording-source materialization beside attachment ingestion, and a translation service using the same lease/retry conventions.

Advantages: smallest data migration risk, reuses proven RLS and recovery behavior, preserves API compatibility, and keeps one authority for findings and evidence.

Trade-off: the attachment and quality services remain separate state machines rather than one generic workflow engine. This is intentional because their inputs, terminal outputs, and retry semantics differ.

### 4.2 Replace Everything with a Generic Intelligence Workflow Engine

A generic source/job/stage DAG would make future capabilities uniform, but it would duplicate or replace three proven V2 state machines and increase migration risk. V3 does not need arbitrary workflow composition, so this approach is rejected.

### 4.3 Move Intelligence to a Separate External Service

An external orchestrator could own provider calls, but it would need duplicate tenant policy, RLS, message visibility, evidence, and review state. Provider runtimes may remain external; orchestration and business authority stay in iveKit. This approach is rejected for V3.

## 5. Target Architecture

```text
OPC / LED / other host
        |
        | @opc/ivekit-sdk + /api/ivekit/*
        v
iveKit standalone
  |-- IntelligencePolicyStore (tenant policy, no credentials)
  |-- ProviderRegistry (deployment profiles + secret refs)
  |     |-- OCR provider(s): self_hosted / third_party
  |     |-- ASR provider(s): self_hosted / third_party
  |     |-- Quality provider(s): self_hosted / third_party
  |     `-- Translation provider(s): self_hosted / third_party
  |-- AttachmentProcessingService (existing, policy-aware)
  |-- RecordingSourceService (known recording -> system message attachment)
  |-- QualityReviewService (existing, policy-aware)
  |-- TranslationService + TranslationWorker (new durable state machine)
  |-- PolicyFindingStore + tenant ReviewQueue (existing authority, new query)
  `-- PostgreSQL/RLS + durable tenant events
```

Provider runtimes receive bounded bytes/text and opaque source references. They never receive PostgreSQL credentials, object-store credentials, Tinode root credentials, LiveKit secrets, or RustDesk control tokens.

## 6. Provider Registry and Tenant Policy

### 6.1 Deployment Profiles

`OPC_IVEKIT_PROVIDER_PROFILES_JSON` defines non-secret profile metadata:

```json
[
  {
    "id": "ocr-internal",
    "capability": "ocr",
    "mode": "self_hosted",
    "base_url": "http://ocr-worker:8080",
    "endpoint": "/v1/ocr",
    "health_endpoint": "/health",
    "token_env": "OCR_INTERNAL_TOKEN"
  },
  {
    "id": "translate-cloud",
    "capability": "translation",
    "mode": "third_party",
    "base_url": "https://translation.example.com",
    "endpoint": "/v1/translate",
    "health_endpoint": "/health",
    "token_env": "TRANSLATION_CLOUD_TOKEN"
  }
]
```

Rules:

1. Profile IDs are stable, lowercase identifiers.
2. `token_env` names an environment variable; the JSON never contains token values.
3. Base URLs cannot contain credentials, fragments, or secret query parameters.
4. Production self-hosted URLs may use HTTP only for loopback/private/container hosts. Third-party profiles require HTTPS.
5. Legacy `OPC_OCR_*`, `OPC_ASR_*`, and `OPC_QUALITY_REVIEW_*` variables become compatible default profiles. Translation has matching `OPC_TRANSLATION_*` variables.
6. The registry returns profile metadata and callable adapters but never serializes tokens.

### 6.2 Tenant Policy

`collaboration_intelligence_policies` contains one row per tenant:

- enabled flags for OCR, ASR, quality review, and translation;
- selected profile ID per capability;
- `allow_third_party` fail-closed gate;
- automatic OCR, ASR, quality, and translation flags;
- bounded default translation target languages;
- minimum OCR/ASR confidence used to mark output `needs_review`;
- policy version, actor, timestamps.

Missing policy uses conservative defaults: attachment OCR/ASR and AI quality keep existing deployment behavior, automatic translation is disabled, and third-party profiles are not selected implicitly. A tenant policy can disable work but cannot provide URLs or secrets.

Only system, owner, or admin identities can update policy. Participants may read a public capability projection but not profile internals.

## 7. Data Model

Migration `043_ivekit_intelligence_translation.sql` is additive and belongs to both root and standalone manifests.

### 7.1 New Tables

#### `collaboration_intelligence_policies`

Tenant policy described above. Primary key and tenant key are `tenant_id`. RLS is enabled and forced.

#### `collaboration_intelligence_source_links`

Idempotently maps a known durable recording/evidence object into the existing message attachment pipeline:

- `id`, `tenant_id`, `session_id`;
- `source_type`: `media_recording` or `remote_recording`;
- `source_ref_id`;
- generated `message_id`, `attachment_id`;
- safe content type, checksum, status, actor, timestamps;
- unique `(tenant_id, source_type, source_ref_id, session_id)`.

The client cannot submit an arbitrary `storage_url`. iveKit loads the recording/evidence record, verifies tenant and business reference, then creates a local system message and attachment inside one transaction.

#### `collaboration_translation_jobs`

- source identity: tenant/session/message, `source_type` (`message` or `attachment`), `source_ref_id`;
- source and target language, source hash;
- `pending/processing/retry_wait/succeeded/failed/cancelled`;
- attempt/max attempts, next attempt, lease, worker ID;
- provider profile/mode/name;
- safe error code/message and bounded output metadata;
- idempotency key and payload hash;
- timestamps;
- unique current request identity and claim indexes.

### 7.2 Translation Result Extension

`collaboration_message_translations` gains:

- `source_type`, `source_ref_id`, `source_hash`, `source_language`;
- `provider_profile_id`, `provider_mode`, `provider_request_id`;
- safe metadata and `updated_at`.

Historical rows are retained as `source_type=message` with a per-row legacy source hash. New result uniqueness is `(tenant_id, source_type, source_ref_id, target_language, source_hash)`.

### 7.3 RLS and Runtime Rights

All new tenant tables use `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, the existing tenant policy helper, explicit indexes, and standalone runtime grants. Runtime can perform required DML but cannot alter schema, read the migration ledger, or bypass RLS.

## 8. Processing Flows

### 8.1 Image OCR

1. Message attachment is committed and object bytes are durable.
2. Tenant policy selects OCR profile or records `provider_unavailable` without pretending success.
3. Existing attachment job claims with a bounded lease.
4. Provider receives multipart bytes, content type, filename, and `ivekit://attachment/<id>`; raw storage URL is not sent.
5. Normalized text/confidence/language/request ID are bounded and stored.
6. Policy scan creates OCR findings with attachment/checksum evidence.
7. Quality review and configured translations are enqueued from the new source hash.

### 8.2 Audio, Video, and Recording ASR

Message attachments of `audio`, `video`, and `screen_recording` select ASR. For a LiveKit or remote recording, `RecordingSourceService` verifies the source and materializes an idempotent local system message attachment before using the same ASR path.

No caller-supplied URL or filesystem path is accepted. Missing, forbidden, oversized, or deleted objects produce explicit retryable/terminal errors.

### 8.3 AI Quality Review

Quality review keeps the existing input-hash state machine. V3 adds tenant policy and provider profile resolution, tenant-wide review queue filtering, and stricter provider output bounds.

Only the current bounded message body, extracted OCR/ASR text, rule finding summaries, and safe evidence references are sent. Provider findings remain advisory. Only the existing human review transition can mark a finding confirmed, dismissed, escalated, or resolved.

### 8.4 Translation

1. A participant manually requests a supported target language, or tenant policy auto-enqueues targets.
2. Service verifies current message visibility and selects message body or current attachment extracted text.
3. Stable source hash and idempotency payload prevent duplicate provider calls.
4. Worker claims the job and invokes the selected profile.
5. Result is stored immutably for that source hash and event `collaboration.translation.completed` is appended.
6. Edited messages or changed extraction create a new source hash; old results remain audit history but are not returned as current.
7. Deleted messages cancel unfinished jobs and hide translation results from normal readers.

Automatic attachment translation begins only after OCR/ASR succeeds. Empty source text returns no job.

## 9. Provider Contracts

### 9.1 OCR/ASR

Multipart request fields: `file`, `source_ref`, `tenant_id`, `session_id`, `message_id`, `attachment_id`. Response:

```json
{
  "text": "bounded extracted text",
  "confidence": 0.98,
  "language": "zh-CN",
  "provider_request_id": "req-safe-id",
  "metadata": { "model": "safe-model-name" }
}
```

### 9.2 Quality Review

JSON request uses the existing normalized input with bounded content and evidence. Response findings are capped by count, field length, severity enum, confidence range, and metadata sanitizer.

### 9.3 Translation

Request:

```json
{
  "source_ref": "ivekit://message/cmsg_123",
  "text": "source text",
  "source_language": "auto",
  "target_language": "ja-JP"
}
```

Response:

```json
{
  "translated_text": "translated text",
  "detected_language": "zh-CN",
  "confidence": 0.97,
  "provider_request_id": "req-safe-id",
  "metadata": { "model": "safe-model-name" }
}
```

### 9.4 Health

The operations probe performs a bounded authenticated GET to the profile health endpoint. The response returned to iveKit callers contains only profile ID, capability, mode, `configured/healthy/degraded/unavailable`, HTTP class, latency, and checked time. Response bodies, URLs with query strings, headers, and tokens are never returned or persisted.

## 10. HTTP API

### 10.1 Intelligence Operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ivekit/intelligence/capabilities` | Tenant-safe effective capabilities and policy summary |
| `GET` | `/api/ivekit/intelligence/policy` | Full policy for system/owner/admin |
| `PUT` | `/api/ivekit/intelligence/policy` | Versioned policy update with audit |
| `GET` | `/api/ivekit/intelligence/providers` | Secret-safe configured profile summaries |
| `POST` | `/api/ivekit/intelligence/providers/health` | On-demand bounded health probe |
| `POST` | `/api/ivekit/intelligence/sessions/:session_id/sources` | Import known media/remote recording by stable ID |
| `GET` | `/api/ivekit/intelligence/sessions/:session_id/sources/:source_id` | Source, attachment, job, and finding state |
| `POST` | `/api/ivekit/intelligence/sessions/:session_id/sources/:source_id/retry` | Retry a terminal processing job |
| `GET` | `/api/ivekit/intelligence/findings` | Tenant review queue with cursor and filters |

All writes use `Idempotency-Key` where repetition can create provider work.

### 10.2 Translation Facade

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/ivekit/chat/sessions/:session_id/messages/:message_id/translations` | List current/history or request message translation |
| `GET/POST` | `/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/translations` | List or request extracted-text translation |
| `POST` | `/api/ivekit/chat/sessions/:session_id/translations/:job_id/retry` | Retry a terminal translation job |
| `POST` | `/api/ivekit/chat/translation/run` | System-only bounded worker trigger |

Existing V1/V2 paths and DTOs remain additive-compatible.

## 11. SDK and Reference Client

`@opc/ivekit-sdk` adds an `intelligence` domain and translation methods under `chat`:

- capabilities, policy get/update, profiles, health probe;
- recording source import/get/retry;
- tenant finding queue;
- message/attachment translation list/request/retry;
- typed policy, profile, source, job, result, and health DTOs.

The browser never receives API keys or provider tokens. Policy/profile administration is intended for trusted backend or an admin JWT.

Reference client changes:

1. Message actions add a language menu and translate command.
2. Translation status and current result render inline without replacing original text.
3. Attachment extraction exposes translate/retry after OCR/ASR completion.
4. Existing finding drawer gains a tenant review queue, source filter, severity/status filter, and next cursor.
5. Recording source status appears in the quality workspace, not as an unexplained chat upload.
6. Unknown provider or policy-disabled states are explicit and retry is offered only for retryable terminal jobs.

## 12. Events

New durable tenant events:

- `collaboration.intelligence.policy_updated`;
- `collaboration.intelligence.source_created`;
- `collaboration.intelligence.source_processed`;
- `collaboration.translation.queued`;
- `collaboration.translation.completed`;
- `collaboration.translation.failed`.

Events contain IDs, status, languages, capability, and safe references only. They do not contain extracted source text, translated text, provider body, token, URL, or credentials. Clients fetch current authorized resources after invalidation.

## 13. Security and Privacy

1. PostgreSQL remains the only business database; no SQLite runtime is introduced.
2. Tenant policy is not a credential store.
3. Third-party processing requires explicit tenant allowance and profile selection.
4. Provider tokens are resolved only from environment variables named by trusted deployment configuration.
5. Provider calls use bounded payload bytes/text, timeout, output size, and metadata allowlists.
6. Raw storage URLs are replaced by opaque iveKit source references.
7. Recording import verifies tenant, business reference, source status, and object ownership.
8. Findings store matched-text hashes and safe rationale; immutable review audit stores sanitized notes.
9. Translation results follow message visibility and deletion rules.
10. Provider health and preflight output are recursively scanned for secrets.

## 14. Deployment and Operations

1. Add provider profile configuration and translation worker settings to `.env.example`, `infra/env.example`, local/production Compose, iveKit Compose, and Kubernetes values/templates.
2. Add `ivekit:intelligence-preflight` to validate PostgreSQL, object storage, profiles, token refs, tenant-safe defaults, worker lease/timeout budgets, and secret-safe output.
3. Add `ivekit:controlled-provider` for a deterministic local/server acceptance provider covering OCR, ASR, quality, translation, transient failures, invalid responses, and health.
4. Standalone source policy must include new intelligence modules and migration 043 while continuing to reject call-center/IVR/frontend imports.
5. Delivery bundle adds V3 SDK/client, provider contract examples, migration manifest, SBOM/checksum, runbook, and acceptance status.

## 15. Upgrade and Rollback

1. Apply migration 043 before deploying V3 code.
2. Existing OCR/ASR/quality environment variables remain valid as default profiles.
3. Translation and recording import start disabled unless policy enables them.
4. Each worker has an independent enable flag.
5. Disabling a worker preserves pending/retry jobs and does not delete results.
6. Rolling back service code leaves additive tables/columns intact.
7. A profile change affects new claims only; processing claims retain their selected profile ID for audit.
8. Existing `/api/ivekit/chat/*` clients continue to work without sending new fields.

## 16. Verification Strategy

### 16.1 Local and Real PostgreSQL

- migration checksum, fresh schema, existing OPC upgrade, RLS, runtime grants;
- tenant policy authorization/isolation/version conflict;
- durable job claim/retry/lease expiry/idempotency/input drift;
- recording source idempotency and cross-business-ref rejection;
- translation source hash and deletion behavior;
- tenant finding queue cursor and visibility.

### 16.2 Controlled Provider

- self-hosted and third-party profile routing;
- OCR, ASR, quality, translation success;
- timeout, 429, 5xx, invalid JSON, oversized output, and non-retryable 4xx;
- health status and secret-safe reports;
- no raw storage URL or token in provider evidence.

### 16.3 Browser

- message and attachment translation states;
- disconnect/replay invalidation convergence;
- tenant review queue and human transition;
- recording source status;
- 320/390/mobile and desktop layout without overflow;
- no provider credentials in DOM, storage, bundle, network URL, or test artifacts.

### 16.4 Server

- standalone build and fresh PostgreSQL;
- controlled provider container plus iveKit workers;
- service restart during processing and retry convergence;
- Playwright against the isolated server/client;
- final delivery checksum, image digest, SBOM, secret scan, and forbidden-source scan.

Real vendor accuracy, compliance, quota, and production latency remain `not_run` until a vendor is selected.

## 17. Milestones

1. **M7.1 Policy and provider registry:** migration, profile parser, tenant policy, capabilities, health, preflight.
2. **M7.2 OCR/ASR productization:** policy routing, opaque references, screen recording, recording-source import.
3. **M7.3 Quality and human review:** policy routing, bounded provider output, tenant review queue.
4. **M7.4 Translation:** provider, durable service/worker, result history, API/events.
5. **M7.5 SDK and reference client:** typed API, translation UI, review queue, recording state.
6. **M7.6 Deployment and delivery:** standalone, Compose/Kubernetes, runbook, delivery bundle.
7. **M7.7 Completion audit:** full local, PostgreSQL, controlled provider, browser, recovery, and server evidence.

## 18. Definition of Done

V3 is complete only when all of the following are proven:

1. Each capability can route to an allowed self-hosted or third-party profile without exposing credentials.
2. Tenant policy controls automatic work and third-party permission under forced RLS.
3. Image, audio, video, and screen/media/remote recording objects converge through durable processing.
4. AI findings remain advisory until a human review transition, with a usable tenant queue.
5. Message and attachment translations are durable, idempotent, source-hash aware, visible through API/SDK/UI, and safely invalidated.
6. Provider health and preflight are bounded and secret-safe.
7. Existing `/api/ivekit/*`, SDK, V2 event replay, and LED integration contracts do not regress.
8. Standalone build, migration, Compose/Kubernetes, delivery package, and upgrade/rollback docs include V3.
9. Full repository, real PostgreSQL, controlled provider, browser, restart recovery, and isolated server gates pass.
10. Unselected real vendor acceptance remains accurately marked `not_run`.
