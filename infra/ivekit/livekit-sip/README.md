# iveKit LiveKit SIP Source Build

LiveKit SIP remains an optional SIP-to-LiveKit bridge. RustPBX owns primary SIP
dialogs, RTP, recording and voice interaction admission in `mix-100k-v1`; this
build does not make LiveKit SIP a second owner of the same call.

The build is pinned to the exact upstream release identity:

```text
repository: https://github.com/livekit/sip
tag: v1.6.0
commit: 02179d2eebe1493ad8c6a7961ceee84c34f8aca3
license: Apache-2.0
```

The script fails before building if `LIVEKIT_SIP_SOURCE_DIR` is not at that
commit. It uses the upstream `build/sip/Dockerfile`, records the full source
commit in the OCI image, and verifies both the image label and executable
version after the build.

```bash
LIVEKIT_SIP_SOURCE_DIR=/path/to/livekit-sip-v1.6.0 \
IVEKIT_LIVEKIT_SIP_IMAGE=registry.example.com/ivekit/livekit-sip:v1.6.0-02179d2e \
bash infra/ivekit/livekit-sip/build.sh
```

Set `IVEKIT_LIVEKIT_SIP_PLATFORM=linux/amd64` when producing the deployment
architecture through a builder that can load or publish that platform. The
local exact-source Linux arm64 candidate is
`ivekit/livekit-sip:v1.6.0-02179d2e`, image
`sha256:54e9acaa0313728305c995bc6d5384f65b6e7366b278e20517b0ffe8fd03ade3`.
It reports `SIP version v1.6.0` and carries source revision
`02179d2eebe1493ad8c6a7961ceee84c34f8aca3`.

This is compile evidence only. A registry digest, SBOM/provenance, Linux amd64
artifact, real SIP media, RustPBX-to-LiveKit bridging, failover, drain behavior,
PSTN and capacity measurements remain `not_run`.
