# Complete Understanding Turn R1 implementation plan

> Date: 2026-09-01
>
> Scope: resolved Intent + text Emotion → Customer State + Dialogue → one durable batch

## Goal

Close one functional Rust understanding turn from independently resolved Intent and Emotion evidence
to the four authoritative projections, without allowing partial visibility or creating another
state authority.

## Frozen contract

- Intent and Emotion resolutions must have the exact recovered authority and same turn.
- Customer State ID is content-addressed by the Intent resolution, Emotion fusion and turn.
- Dialogue ID is content-addressed by the Customer State and exact Dialogue Policy revision.
- Customer State is rebuilt only from the selected Intent/Emotion states; Dialogue is evaluated only
  by the Release-bound deterministic Policy.
- Evidence order is closed: 1–3 Intent Provider observations, one Intent resolution, zero to eight
  Emotion Provider observations, then the fixed Intent/Emotion/Customer State/Dialogue heads.
- Every evidence record is record-only. Only the four existing selected checkpoint kinds can advance
  heads, using exact recovered head expectations.
- Repeated preparation from identical input is byte/identity stable.

## Minimal TDD proof

1. Prove Store accepts Intent and Emotion evidence in the exact order and rejects reversal.
2. Recover one valid all-empty graph.
3. Resolve one Safety Intent and one text Emotion turn.
4. Derive Customer State and Dialogue and freeze three raw evidence records plus four heads.
5. Prove repeated preparation is identical.
6. Run only Store turn-batch, Worker recovery/assembly and scoped Clippy.

## Explicit exclusions

- real Active Call consumer/history/model process composition;
- acoustic evidence and multimodal fusion;
- physical PostgreSQL transaction, crash/restart or two-node race;
- Tool/Handoff execution, production, fleet, capacity or performance qualification.
