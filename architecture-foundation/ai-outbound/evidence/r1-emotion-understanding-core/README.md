# AI outbound R1 Emotion Understanding Core evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `bca8cbf02d29a2d33b552e0b5e1880ca54e07ea5`.
- Pinned Active Call source inspected: `6224d948cc0941ac48b4a5426477aeaf639c2e98`.

## Proven

- A provider-neutral Rust Core owns Release-bound Emotion catalogs; labels are not hard-coded into
  Active Call, a speech provider or the fusion state machine.
- Catalogs reject empty, duplicate and unbounded labels. Negative labels require an explicit
  distress rank from one to four; neutral and positive labels cannot carry a distress rank.
- Acoustic observations require an audio evidence-window ID. Text classifier, contextual LLM and
  Active Call Playbook observations require transcript-segment evidence. Human correction remains
  an independently attributable source.
- Each observation binds exact tenant/interaction/Attempt/Call/Agent session/generation, Agent
  Release, Catalog revision, source/provider revision, turn/time, bounded top-k candidates,
  basis-point confidence, zero-to-four intensity and evidence IDs into a canonical hash.
- Only same-authority, same-Catalog, same-turn observations can contribute to a fused result.
  Contributor hashes are sorted and duplicate evidence is rejected.
- Only a fused result can update Emotion State. State rejects same/older turns, non-monotonic time,
  cross-generation authority and Catalog drift.
- Release-tuned thresholds distinguish `unknown`, `provisional` and `confirmed`. Only confirmed
  evidence changes the confirmed emotion, consecutive distress turns and
  `unknown/stable/improving/worsening` customer-distress trend.
- Customer-derived labels and evidence are omitted from observation, fusion and state `Debug`
  output. The Core exposes no telephony, Tool, DNC, handoff or business-action authority.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-understanding-core
10 passed

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

- real Acoustic/Text/Contextual LLM/Active Call/Human Correction Provider: `not_run`;
- actual multimodal fusion algorithm, score calibration and emotion-quality evaluation: `not_run`;
- durable observation/Fusion/Emotion State Store and restart/multi-node reconciliation: `not_run`;
- Customer State and Dialogue Policy consumption: `not_run`;
- real audio/ASR, SIP/PSTN, media, server deployment, performance and production: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
