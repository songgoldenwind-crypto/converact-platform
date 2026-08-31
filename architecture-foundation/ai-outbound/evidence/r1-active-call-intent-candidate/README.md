# AI outbound R1 Active Call intent-candidate evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract`
>
> Production eligibility: `false`

This record proves the bounded intent-candidate mapping at Converact commit
`a18678f4d7a136af7c6e79a2efa2dd0af0df9c01`. Its wire shape comes from pinned Active Call
`0.3.83` commit `6224d948cc0941ac48b4a5426477aeaf639c2e98`.

## Observed scope

- terminal `hangup.extra.intent` becomes one `IntentCandidate` on the normalized terminal event;
- the candidate is accessible only through an explicit accessor and redacted from `Debug`;
- unrelated `extra` fields, including a customer note and provider token fixture, do not enter the
  normalized event or its diagnostics;
- absent intent remains absent; present non-string, control-bearing or greater-than-256-byte values
  fail closed with one stable code;
- no second VAD, classifier, LLM call or business intent authority was added;
- existing `ConversationResult::try_new` remains the release-bound `OutcomeSchema` enforcement
  point; mapping a candidate into that projection is not claimed by this evidence.

## Fresh verification

- Active Call event mapping: 8 passed, 0 failed;
- Active Call command compatibility: 4 passed, 0 failed;
- Active Call client compatibility: 4 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed.

## Explicitly not run

- candidate-to-`OutcomeSchema` projection wiring;
- real Active Call process, Playbook execution or intent-quality evaluation;
- real model, Speech Runtime, RustPBX, SIP/PSTN, audio or Campaign outcome;
- physical PostgreSQL, deployed runtime, performance, capacity, long-run, independent review and
  production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
