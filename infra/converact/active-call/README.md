# Converact Active Call exact-source overlay

This build-time overlay targets only Active Call `0.3.83` commit
`6224d948cc0941ac48b4a5426477aeaf639c2e98`, tree
`9521ad341fb992ba6d491eb217983df8cf85d2cf`.

It adds a narrow Rust compatibility surface for platform-owned Playbook reservations and an
explicit disclosure-before-conversation gate:

- optional client-selected `session_id` on `POST /api/playbook/run`;
- same session and same Playbook replay the original identity;
- same session with different content returns `409`;
- an inbound SIP leg may carry `X-Converact-Agent-Session`; the value is bounded, matched only to
  an existing reservation, removed from Playbook/LLM extras, and used instead of the SIP Dialog ID;
- the first matching SIP leg atomically claims the reserved Playbook; another leg cannot reuse it;
- `GET /api/playbook/reservations/{session_id}` reports `pending`, `attached`, `media_ready`,
  `disclosure_completed`, `started`, legacy `active`, `terminal`, or `404`;
- a platform-owned Runner stays silent after SIP attachment and media readiness;
- the overlay advances to `disclosure_completed` only for a positive-duration `TrackEnd` whose
  `playId` exactly equals the platform session ID;
- the idempotent `POST /api/playbook/reservations/{session_id}/start` succeeds only after that
  exact disclosure playback terminal event;
- a platform worker opts into a separate semantic stream by sending numeric `Last-Event-ID` to
  `GET /events/{session_id}`; every returned `event` frame then carries a contiguous numeric SSE
  `id` and can be resumed after a transport disconnect;
- the process-local journal retains at most 1,024 semantic events and 4 MiB per platform session,
  rejects a semantic event above 64 KiB, and covers only `mediaReady`, `asrFinal`, `interruption`,
  `hold`, `inactivity`, `functionCall` and terminal `hangup` events;
- a cursor older than retained coverage, ahead of the journal, or affected by recorder lag returns
  `410 Gone`; the overlay never silently skips that gap;
- requests without `Last-Event-ID` retain the original unnumbered event/command stream;
- the legacy request without `session_id` remains compatible.

It does not give Active Call Campaign, Agent Release, telephony, Call/Leg, billing, external Tool,
recording or outcome authority. It also does not make the in-memory reservation durable. The
platform must persist intent before mutation, use a stable session identity, query after an unknown
outcome, and reconcile process restart plus `not_found` against its own durable reservation intent.
The semantic event journal is also process memory only: terminal journals become eligible for
cleanup after a five-minute reconciliation window, while an Active Call process crash loses them.
A Worker must persist every accepted cursor and event before advancing its durable projection; HTTP `410`, a
missing journal after restart, or a terminal session without complete coverage requires explicit
reconciliation and must not be treated as a complete transcript.
The control header is for the trusted RustPBX-to-Active-Call placement only; it is not a public
caller assertion and the overlay does not add transport authentication. Converact owns disclosure
policy, text and command issuance; the overlay only records its local exact-playback terminal event.
That event does not prove that a callee heard the audio, that recording captured it, or that policy
content is sufficient. A transient `404` is not proof that no call-side effect exists and must never
authorize a blind second mutation.

The overlay script checks the exact upstream commit and tree before changing six Rust source files
and installing one owned Rust module.
It is idempotent on a previously overlaid checkout and fails closed on partial application or
anchor drift. The canonical pinned development checkout remains unmodified; apply the overlay only
to an isolated build tree.

```bash
node infra/converact/active-call/apply-overlay.mjs /path/to/isolated/active-call
```
