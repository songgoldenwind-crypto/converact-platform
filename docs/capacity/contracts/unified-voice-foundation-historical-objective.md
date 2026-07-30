# New OPC/iveKit Goal

Call `create_goal` with the following complete objective, then begin work:

Continue the OPC/iveKit shared communication foundation from repository
`https://github.com/songgoldenwind-crypto/opc-platform.git`, branch
`codex/ivekit-v5-shared-foundation`, starting at pushed commit `eac461b`.
First read `/private/tmp/opc-ivekit-handoff-2026-07-29.md` and
`/private/tmp/opc-ivekit-runtime-access-2026-07-29.md`, then read every
canonical design, ADR, source manifest, `CLAUDE.md`, and `AGENTS.md` listed by
the handoff.

Execute Goals 4 through 11 from
`docs/design/communication-foundation-vos5000-parity-performance-plan.md` in
dependency order. Start by auditing Goal 4 and completing reproducible parser,
codec, and packet-loop benchmarks; immutable and non-forgeable evidence
identity; and the exact-source G.729 candidate manifest and acceptance gates.
Continue AMR-NB/WB, conference/mix, T.38, quality, unified recording/evidence,
carrier-grade SIP interoperability, kernel/NIC/NUMA performance, capacity
admission/routing, observability, independent load fleet, VOS-EQ, and 100K
acceptance only when their prerequisites are satisfied.

Do not redesign or reimplement completed IM, LiveKit, RustDesk, notification,
or existing IVR capabilities unless a verified dependency requires a change.
Do not use `using-superpowers` or local Docker. Never touch LED source,
configuration, data, or containers. Use server access, DNS, certificates,
test-account identity, and secret-file locations only through the restricted
runtime index, and never display or copy secret values. Keep every unexecuted
real-environment or capacity item marked `not_run`; do not claim production
capacity, VOS5000 parity, or 100K completion without signed evidence.

Preserve bounded queues, bounded retries, bounded labels and per-call state,
owner fencing, and near-linear horizontal scaling as hard acceptance
requirements. Work through implementation, focused tests, verification,
review, commit, and push for each safe slice; pause only for an unavoidable
external prerequisite.
