# Transcript Understanding Source R1 implementation plan

> Date: 2026-09-01
>
> Scope: PostgreSQL append receipt → bounded typed history → understanding disposition

## Goal

Join the durable Active Call transcript append boundary to the final-transcript understanding
processor without querying history or invoking models for replayed and historical receipts.

## Frozen contract

- The four PostgreSQL receipt outcomes map exhaustively to `appended_current`,
  `replayed_current` or `historical`.
- Only `Appended(Current)` may load transcript history.
- A history query is bounded to 1–32 rows and selects only one tenant, Interaction, Attempt,
  Release and execution generation, ending at `segment_sequence <= current`.
- SQL fetches newest-first under the existing transcript-order index, then returns typed segments in
  increasing sequence order.
- System rows are excluded from classifier context.
- Every stored row is reconstructed as `TranscriptSegment`; canonical payload hash, authority,
  increasing sequence and the exact final append-receipt anchor are revalidated.
- Transcript content remains absent from `Debug` and error values.

## Minimal TDD proof

1. Reject history limits outside 1–32.
2. Accept an ordered bounded window ending at the exact current segment.
3. Reject a wrong anchor or non-increasing order.
4. Prove all four append receipts map to the closed dispositions.
5. Prove only the new-current receipt invokes the history port.
6. Run scoped Store/adapter/Worker tests and Clippy only.

## Explicit exclusions

- physical PostgreSQL execution and query-plan evidence;
- real Active Call SSE process lifecycle;
- real Fast/Contextual/Text Emotion model adapters;
- acoustic/multimodal Emotion, production, capacity or performance.
