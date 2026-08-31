# Active Call exact-source pin

Active Call is the selected Rust implementation candidate for the bounded
SIP/PSTN Channel Agent role. It does not own Converact Campaign, AgentRun,
workflow, external effect, Call/Leg, route, CDR, or media-plan authority.

## Pinned upstream

- Repository: `https://github.com/miuda-ai/active-call`
- Version declared by upstream: `0.3.83`
- Commit: `6224d948cc0941ac48b4a5426477aeaf639c2e98`
- Tree: `9521ad341fb992ba6d491eb217983df8cf85d2cf`
- Commit signature: `unsigned`
- Exact-commit archive SHA-256:
  `324096251975fdb70cea3c9b574526559d3d960645e252b56721ba3c3393040c`
- Git archive SHA-256:
  `e831159885c47dbb60494105443384776f97f358bb78c302f5a2c17006d478b7`
- Tracked files: `239`

The development checkout must remain at detached HEAD on the pinned commit.
Integration must use the commit and hashes in `source-lock.json`; a branch name,
floating Git dependency, container `latest` tag, or unqualified upstream claim
is not an acceptable source identity.

## Current gates

The source has been downloaded and its identity verified. A Converact build-time
overlay has been applied twice to an isolated copy of this exact source and its
two focused Rust tests pass locally. The canonical detached development checkout
remains unchanged. The overlay adds only a stable Playbook reservation identity,
same-payload replay, payload-conflict rejection and pending/active query.

This is not runtime qualification. The reservation remains process-local and the
upstream pending-to-active handoff is not atomic, so a transient `404` is not
proof that no effect exists. Real process integration, restart reconciliation,
quality, latency, capacity and production eligibility remain `not_run`.

Upstream declares `MIT` in `Cargo.toml` and the README, but the pinned tree does
not contain the referenced `LICENSE` file. The source is available for local
engineering review, but vendoring or distribution remains gated on an explicit
license review and preservation of the authoritative license text.

The pinned tree also does not contain `Cargo.lock`. Source identity is fixed,
but the dependency closure is not fixed until Converact generates, reviews, and
commits its own lockfile during adapter integration.
