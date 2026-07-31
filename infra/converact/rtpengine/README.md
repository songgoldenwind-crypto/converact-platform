# iveKit RTPengine Fork

This directory turns the locked RTPengine source archive and the ordered
iveKit patch set into three separate artifacts:

- an unprivileged userspace relay image;
- an unprivileged recording-daemon image;
- a host-kernel-specific `nft_rtpengine.ko` artifact image.

The final artifact builds run with `--network=none`. Only the toolchain image
build and the locked source fetch may access the network.

## Toolchain

The toolchain starts from the digest-pinned Debian Trixie slim image and uses
the `20260725T000000Z` Debian and Debian Security snapshots. Build it on the
target architecture:

```bash
infra/converact/rtpengine/build.sh toolchain
```

Record the printed image ID in `toolchain-lock.json` before building runtime
artifacts. The image ID is content-addressed and `build.sh` also verifies its
architecture and snapshot label.

On a clean native builder, either rebuild the pinned snapshot toolchain and
pass its printed content ID as `IVEKIT_RTPENGINE_TOOLCHAIN_IMAGE`, or provide
an immutable `repository@sha256` reference. Mutable tags are rejected. The
actual toolchain image ID is copied into every runtime artifact label as
`io.ivekit.toolchain.image-id`; a local Docker image ID is not represented as
a published registry digest.

## Userspace And Recording

Use the locked archive already present on disk when builds must avoid a source
download:

```bash
IVEKIT_RTPENGINE_ARCHIVE_FILE=/path/to/rtpengine.tar.gz \
  infra/converact/rtpengine/build.sh all
```

With a local locked archive, source preparation and all final artifact builds
run with networking disabled. Without that variable, source fetch and release
tag verification are the only networked source steps.

`amd64` and `arm64` are supported only on native builders. A request for a
different `TARGETARCH` is rejected rather than silently emulated.

The userspace image runs as UID/GID `10001`, contains no compiler or package
manager, and expects writable mounts or tmpfs paths at:

- `/run/ivekit-rtpengine`
- `/var/lib/ivekit-rtpengine`
- `/rec`

The rest of the root filesystem may be read-only.

## Runtime Mode

`IVEKIT_RTPENGINE_RUNTIME_MODE` accepts:

- `userspace`: never use the kernel forwarding table;
- `kernel`: fail startup unless `/sys/module/nft_rtpengine/srcversion`
  matches the module identity embedded in the kernel runtime image;
- `auto`: use the matching kernel module or explicitly fall back to userspace.

The identity cannot be supplied or overridden through an environment
variable. A userspace image contains no kernel identity, so forced kernel mode
is refused and auto mode falls back. `build.sh kernel` creates a separate
host-kernel-specific artifact plus a kernel runtime image with the generated
module identity embedded at build time.

Auto fallback is visible in the daemon metric
`ivekit_userspace_fallback{reason="kernel_identity_unavailable"}` and in
`/run/ivekit-rtpengine/runtime.prom`.

The production runtime enables `IVEKIT_RTPENGINE_OWNER_GUARD` by default so
stable-command replay, owner fencing, draining, and capacity admission remain
active. Set it explicitly to `false` only for isolated compatibility
diagnostics.

The NG control listener must remain on the private service network. Only the
declared RTP/RTCP UDP range belongs on media-node ingress.

## Kernel Artifact

Kernel modules are tied to the target host kernel. Supply the exact prepared
headers:

```bash
IVEKIT_RTPENGINE_KERNEL_HEADERS_DIR=/lib/modules/$(uname -r)/build \
IVEKIT_RTPENGINE_KERNEL_RELEASE=$(uname -r) \
  infra/converact/rtpengine/build.sh kernel
```

Without headers, an `all` build records kernel verification as `not_run`.
The kernel-only command fails instead of claiming an artifact was built.
