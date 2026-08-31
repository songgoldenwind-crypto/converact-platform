# Converact Active Call exact-source overlay

This build-time overlay targets only Active Call `0.3.83` commit
`6224d948cc0941ac48b4a5426477aeaf639c2e98`, tree
`9521ad341fb992ba6d491eb217983df8cf85d2cf`.

It adds a narrow Rust compatibility surface for platform-owned Playbook reservations:

- optional client-selected `session_id` on `POST /api/playbook/run`;
- same session and same Playbook replay the original identity;
- same session with different content returns `409`;
- `GET /api/playbook/reservations/{session_id}` reports `pending`, `active`, or `404`;
- the legacy request without `session_id` remains compatible.

It does not give Active Call Campaign, Agent Release, telephony, Call/Leg, billing, external Tool,
recording or outcome authority. It also does not make the in-memory reservation durable. The
platform must persist intent before mutation, use a stable session identity, query after an unknown
outcome, and reconcile process restart plus `not_found` against its own durable reservation intent.
The current upstream removes a pending Playbook before it installs the active-call guard, so this
overlay also does not claim an atomic `pending -> active` observation. A transient `404` is not
proof that no call-side effect exists and must never authorize a blind second mutation.

The overlay script checks the exact upstream commit and tree before changing two Rust source files.
It is idempotent on a previously overlaid checkout and fails closed on partial application or
anchor drift. The canonical pinned development checkout remains unmodified; apply the overlay only
to an isolated build tree.

```bash
node infra/converact/active-call/apply-overlay.mjs /path/to/isolated/active-call
```
