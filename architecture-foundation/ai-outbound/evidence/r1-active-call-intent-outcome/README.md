# AI outbound R1 Active Call intent → Outcome evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the bounded intent-to-result contract at Converact commit
`f3a56b854751c1fbf0ac1c3df598087ca31e3923`. Its upstream candidate shape comes from
pinned Active Call `0.3.83` commit `6224d948cc0941ac48b4a5426477aeaf639c2e98`.

## Observed scope

- a terminal Active Call intent candidate is accepted only when its event Agent Release and exact
  `OutcomeSchema` closed value match;
- absent intent remains absent, while unknown values and cross-Release evidence fail closed;
- accepted evidence binds Agent Release, Outcome Schema revision and a canonical payload hash, and
  its `Debug` representation does not disclose the intent value;
- result-generation evidence binds the exact authority context, terminal transcript digest,
  Outcome Schema revision, accepted intent evidence or its explicit absence, and expected result
  revision into the durable result-command digest;
- execute forwards accepted evidence to the Provider, while execute, query and replay all reject a
  Provider result that drifts from the accepted schema or intent;
- finalization rejects a result command with the wrong digest, another transcript snapshot or
  another result revision before invoking the Provider;
- the existing no-evidence projection entry point remains available; no second classifier, VAD,
  ASR, LLM prompt, turn detector or Active Call business authority was added.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- Conversation Result Core model and evidence behavior: 5 passed, 0 failed;
- Active Call adapter mapping compatibility: 8 passed, 0 failed;
- terminal candidate-to-schema projection: 2 passed, 0 failed;
- result generation, query/replay and finalization binding: 12 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed.

## Explicitly not run

- real Active Call process, Playbook, model call or intent-quality evaluation;
- real Speech Runtime, RustPBX, SIP/PSTN, RTP/SRTP, audio or Campaign outcome;
- physical PostgreSQL and durable result Provider integration;
- deployed runtime, performance, capacity, long-run and fault campaign;
- independent code review and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
