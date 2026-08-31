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
- `GET /api/playbook/reservations/{session_id}` reports `pending`, `attached`, `started`, legacy
  `active`, or `404`;
- a platform-owned Runner stays silent while attached and starts only after idempotent
  `POST /api/playbook/reservations/{session_id}/start`;
- the legacy request without `session_id` remains compatible.

It does not give Active Call Campaign, Agent Release, telephony, Call/Leg, billing, external Tool,
recording or outcome authority. It also does not make the in-memory reservation durable. The
platform must persist intent before mutation, use a stable session identity, query after an unknown
outcome, and reconcile process restart plus `not_found` against its own durable reservation intent.
The control header is for the trusted RustPBX-to-Active-Call placement only; it is not a public
caller assertion and the overlay does not add transport authentication. Active Call also does not
decide whether disclosure completed: Converact must observe the exact disclosure playback terminal
event before issuing `start`. A transient `404` is not proof that no call-side effect exists and
must never authorize a blind second mutation.

The overlay script checks the exact upstream commit and tree before changing five Rust source files.
It is idempotent on a previously overlaid checkout and fails closed on partial application or
anchor drift. The canonical pinned development checkout remains unmodified; apply the overlay only
to an isolated build tree.

```bash
node infra/converact/active-call/apply-overlay.mjs /path/to/isolated/active-call
```
