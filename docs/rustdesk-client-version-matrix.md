# RustDesk OSS Client/Server Version Matrix

> Contract freeze: 2026-07-22. This matrix is the iveKit real-terminal V1
> integration baseline. Version changes require a matrix update and a new
> acceptance run; floating tags are not supported.

## Pinned Combination

| Component | Pinned version | Supported architecture | Source |
| --- | --- | --- | --- |
| RustDesk OSS server source | `1.1.16@73523b31cfd25d77dee862e6fc9f5e1fb5e485ef` | `linux/amd64`, `linux/arm64` | [RustDesk Server 1.1.16 release](https://github.com/rustdesk/rustdesk-server/releases/tag/1.1.16) |
| RustDesk OSS client source | `1.4.9@6c578292e8ebbbec708b76986ba8c4bc7c509747` | See platform table | [RustDesk 1.4.9 release](https://github.com/rustdesk/rustdesk/releases/tag/1.4.9) |

Only the exact `1.1.16` server and `1.4.9` client combination is in the V1
support window. Nightly builds, floating server tags, Pro-only features, mobile
clients, and web clients are outside this matrix.

Client `1.4.9` is the V1 target because its stable release includes relevant
controller attribution, audit, reconnect, Wayland clipboard, authentication,
permission and file/clipboard fixes over the previous baseline. Server `1.1.16`
also contains the upstream unauthenticated UDP punch-hole reflection/amplification
fix and therefore replaces 1.1.15 as the only eligible source base.

The exact server overlay applies idempotently and its locked Rust tests pass.
The exact client overlay also applies idempotently. The 1.1.16 OCI workflow,
Windows compilation, signed client artifact and immutable registry identities
remain `not_run`; this matrix does not promote a source check into an artifact result.

The matrix freezes an eligible deployment combination; it does not fabricate a
real-terminal result. Real screen, keyboard/mouse, display, file, clipboard,
recording, reconnect, and physical-disconnect acceptance remains `not_run` until
the pinned native clients are operated against the pinned server and evidence is
reviewed.

## Terminal Platforms

| Platform | iveKit V1 architecture | Package expectation | Platform-specific limitation |
| --- | --- | --- | --- |
| Windows | `x86_64` | `rustdesk-1.4.9-x86_64.exe` (EXE) | Windows `x86` is an upstream legacy build and is not in the iveKit V1 support window. Windows ARM64 has no pinned V1 artifact. Service/UAC and login-screen behavior require real-machine acceptance. |
| macOS | `x86_64`, `aarch64` | `rustdesk-1.4.9-x86_64.dmg`, `rustdesk-1.4.9-aarch64.dmg` (DMG) | Screen capture and control require macOS Screen Recording and Accessibility permissions; Input Monitoring can also be required. A configured permission is not proof that capture or input worked. See the [official macOS guide](https://rustdesk.com/docs/en/client/mac/). |
| Linux | `x86_64`, `aarch64` | `rustdesk-1.4.9-x86_64.deb`, `rustdesk-1.4.9-aarch64.deb` (DEB) | Wayland support is experimental and a Wayland login screen is not supported; login-screen access after logout/reboot requires X11. `armv7` is outside the iveKit V1 support window. See the [official Linux guide](https://rustdesk.com/docs/en/client/linux/). |

Package checksums must be taken from the selected official release asset and
recorded in the distribution manifest. This document does not authorize a
client profile pack to download or execute an installer.

## Capability Truth Model

The SDK contract uses four independent states. They must not be collapsed into
one `supported` or `ready` boolean:

| State | Meaning | Does not prove |
| --- | --- | --- |
| `configured` | Required ID/relay/API/public-key fields were supplied and the server key fingerprint is known. | The terminal can connect or perform an operation. |
| `available` | A terminal heartbeat, native observer, operator report, or explicit unknown state describes runtime capability availability. | Consent, permission, ownership, or successful execution. |
| `granted` | Requested scopes were bounded by active consent and iveKit policy. | The native client exposed or successfully used the capability. |
| `observed` | A native adapter, edge adapter, operator, or QA observation records `observed_succeeded` or `observed_failed` with evidence references. | Any operation lacking its own observation. |

Missing terminal telemetry is `unknown`; missing operation telemetry is
`not_observed`. Configuration, a successful HTTP response, a launch URL, a
command exit code, or a granted scope must never be promoted to `observed`.
`not_observed` always has `observer=none`, a null timestamp, and no evidence
references. An observed success or failure requires a non-none observer, a
timestamp, and at least one evidence reference.

## Data And Secret Boundary

RustDesk native clients own screen pixels, keyboard/mouse input, multi-display,
file bytes, clipboard contents, and client-side recording bytes. iveKit receives
only tenant/business binding, state, scopes, ownership, disconnect state, audit
metadata, checksums, and evidence references.

Terminal profiles and operation evidence must not include iveKit API keys,
private keys, edge signing secrets, unattended passwords, signed launch tokens,
raw service credentials, clipboard contents, file contents, keystrokes, screen
pixels, or recording bytes. Browser callers use short-lived bearer tokens; a
trusted backend may use an API key without forwarding it to the browser.
Operation evidence metadata is an allowlist of non-content IDs, direction,
display ID, byte count, checksum, duration, reason, and status detail; it has no
arbitrary extension keys. Static client configuration packs retain blank URL
fields for compatibility and expose generation-time availability booleans only.
A fresh runtime launch plan is required to obtain a signed or protocol URL.

## Change Control

1. Pin the candidate server image and desktop client release.
2. Verify official asset checksums and platform/architecture availability.
3. Run controlled contract tests and real terminal acceptance separately.
4. Record platform limitations and every `not_run` or failed observation.
5. Update this matrix only after evidence review; do not silently widen a semver range.
