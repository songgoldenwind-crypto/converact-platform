# AI outbound R1 Intent Understanding Core evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `528fa591e7ff67b9a29950dd206abe8c49a40158`.

## Proven

- A new provider-neutral Rust Core owns Release-bound hierarchical Intent catalogs rather than
  embedding business labels in Active Call or one model adapter.
- Catalogs reject duplicates, unknown parents, parent cycles, unbounded labels and invalid Slot
  allow-lists; safety-critical classification is catalog metadata, not an action permission.
- Each observation binds the exact tenant/interaction/Attempt/Call/Agent session/generation,
  Agent Release, Catalog revision, provider source/revision, turn, transcript segment evidence,
  top-k candidates, calibrated basis-point scores and permitted Slots into a canonical hash.
- Candidate lists are bounded to five, ordered and unique. Customer-derived candidate and Slot
  values are omitted from `Debug` output.
- A Release-tuned policy drives `unknown`, `provisional`, `clarification_required`, `confirmed`
  and `changed`; thresholds are validated inputs rather than uncalibrated global constants.
- Confirmed intent changes preserve the previous confirmed label as redacted state. Same/older
  turns, non-monotonic observation time, cross-generation evidence and authority drift fail closed.
- A safety-rule observation can confirm classification without returning any business action,
  telephony command, Tool authorization or DNC mutation.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-understanding-core
5 passed

cargo test --locked -p converact-voice-agent-contracts
6 passed

cargo clippy --locked -p converact-conversation-understanding-core \
  -p converact-voice-agent-contracts --lib --tests -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this narrow slice.

## Explicitly not proved

- real Rule/Fast Classifier/Contextual LLM/Active Call/Human Correction Provider: `not_run`;
- multi-provider fusion, OOS detection, calibration data and quality metrics: `not_run`;
- durable observation/Intent State Store and restart/multi-node reconciliation: `not_run`;
- Emotion fusion, Customer State and Dialogue Policy consumption: `not_run`;
- real audio/ASR, SIP/PSTN, media, server deployment, performance and production: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
