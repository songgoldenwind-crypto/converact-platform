# Converact Fabric LiveKit SIP Source Build

LiveKit SIP remains an optional SIP-to-LiveKit bridge. RustPBX owns primary SIP
dialogs, RTP, recording and voice interaction admission in `mix-100k-v1`; this
build does not make LiveKit SIP a second owner of the same call.

The build is pinned to the exact upstream release identity:

```text
repository: https://github.com/livekit/sip
tag: v1.7.0
commit: d5d1e09bbe826baaae9c335d8f42523192c7ce29
license: Apache-2.0
```

The script fails before building if `LIVEKIT_SIP_SOURCE_DIR` is not at that
commit. The Converact Fabric Dockerfile runs upstream package tests, builds with immutable
builder and runtime images, removes paths from the binary, runs as UID/GID
10001, records the source identity, and verifies the image label and executable
version after the build.

```bash
LIVEKIT_SIP_SOURCE_DIR=/path/to/livekit-sip-v1.7.0 \
CONVERACT_FABRIC_LIVEKIT_SIP_IMAGE=registry.example.com/converact/livekit-sip:v1.7.0-d5d1e09b \
LIVEKIT_SIP_BUILDER_IMAGE=golang:1.26@sha256:<digest> \
LIVEKIT_SIP_RUNTIME_IMAGE=debian:trixie-slim@sha256:<digest> \
bash infra/converact/livekit-sip/build.sh
```

Set `CONVERACT_FABRIC_LIVEKIT_SIP_PLATFORM=linux/amd64` when producing the deployment
architecture through a builder that can load or publish that platform. The
GitHub image workflow fetches the exact annotated tag, verifies the resolved
commit, builds the amd64 image, publishes a manifest digest, and delegates that
digest to the shared OCI release gate.

The earlier `v1.6.0` arm64 image remains historical compile evidence only. No
`v1.7.0` build, unit result, registry digest, SBOM/provenance, real SIP media,
RustPBX-to-LiveKit bridge, failover, drain, PSTN or capacity evidence exists in
the current evidence set; all remain `not_run` until the workflow and target
environment acceptance actually run.
