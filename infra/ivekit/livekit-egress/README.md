# iveKit LiveKit Egress overlay

This overlay targets only LiveKit Egress `v1.13.0` at commit
`7d3572a0bf1959cbbc452f5ba390b6a90b7dc249`.

It adds process-local request-type, concurrency and drain fences before upstream CPU and memory
admission. Set:

```text
IVEKIT_EGRESS_POOL_NAME=track
IVEKIT_EGRESS_ALLOWED_REQUEST_TYPES=track
IVEKIT_EGRESS_MAX_CONCURRENT_REQUESTS=64
IVEKIT_EGRESS_DRAIN_FILE=/var/run/ivekit-egress/draining
```

or:

```text
IVEKIT_EGRESS_POOL_NAME=composite
IVEKIT_EGRESS_ALLOWED_REQUEST_TYPES=room_composite,track_composite
IVEKIT_EGRESS_MAX_CONCURRENT_REQUESTS=4
IVEKIT_EGRESS_DRAIN_FILE=/var/run/ivekit-egress/draining
```

An empty allow-list and concurrency setting preserve upstream behavior. A configured policy with no
pool name, an unknown request type, an invalid concurrency value, or a relative drain-file path fails
process startup. A present drain file rejects new work while active requests finish during the pod's
termination grace period. These checks execute only on Egress request admission, not in media packet
processing.

The Track/Composite Kubernetes pools must run the image produced by `build.sh`. The deployment
requires the `ivekit/livekit-egress` repository path, an immutable `media.egress.image.digest`, and
an image registry listed in `media.egress.image.allowedRegistries`. The default allow-list contains
only `docker.io`; a release using a private registry must add that reviewed host explicitly. Fully
qualified upstream aliases, unapproved registries, and arbitrary repository paths fail closed. The
build stamps the matching `ivekit-egress-pool-v1` image contract. The chart also requires
`livekit.redis.address` when LiveKit is external, because LiveKit Server and Egress must use the same
Redis request bus. Registry approval and digest pinning do not replace admission-time image
signature or provenance verification.

The delivery bundle preserves a runnable component source layout under
`components/livekit-egress/`: the overlay, local Go policy module, build script and curated Helm
chart files retain their repository-relative paths. A release operator supplies the built image
repository/digest, external LiveKit URL/API credentials, shared Redis credentials and object-store
credentials at render time. The chart fails closed when either the custom digest or shared Redis
address is absent.

## Build

`build.sh` accepts only the exact upstream commit and materializes Go 1.26.2
through the `golang.org/toolchain` module. Both supported target architectures
are SumDB bound:

- `linux/arm64`: `h1:825B2ojAZW7usy4LtVvkxKs89EwlM1mqV0OvDbIA5Ak=`
- `linux/amd64`: `h1:mCBp0gCL9gQVqXpC60jQ7R46JDxL73qeF8hv6SnV2ss=`

The build replaces upstream's container-internal `go.dev` download with that
verified toolchain, vendors all Go dependencies and runs the final image build
with `--network=none`. Three digest-bound inputs define the complete build:
Egress templates, the GStreamer development builder and the official matching
Egress runtime. Reusing the official runtime preserves its Chrome, GStreamer
and Tini contract without apt or remote downloads in the iveKit Dockerfile.
The script validates architecture, non-root user, source revision, component
and pool-contract labels, Egress version and iveKit binary markers.

```bash
LIVEKIT_EGRESS_SOURCE_DIR=/path/to/livekit-egress-v1.13.0 \
IVEKIT_LIVEKIT_EGRESS_IMAGE=ivekit/livekit-egress:v1.13.0-ivekit.1-7d3572a0 \
IVEKIT_LIVEKIT_EGRESS_TEMPLATE_IMAGE=docker.io/livekit/egress-templates:sha-594b3b1@sha256:<digest> \
IVEKIT_LIVEKIT_EGRESS_BUILDER_IMAGE=docker.io/livekit/gstreamer:1.24.12-dev@sha256:<digest> \
IVEKIT_LIVEKIT_EGRESS_RUNTIME_IMAGE=docker.io/livekit/egress:v1.13.0@sha256:<digest> \
IVEKIT_LIVEKIT_EGRESS_TARGETARCH=amd64 \
bash infra/ivekit/livekit-egress/build.sh
```

On 2026-07-22 the overlay applied repeatedly to the exact `v1.13.0` source on
the isolated Linux amd64 validation server. The offline full CGO build produced
`ivekit/livekit-egress:v1.13.0-ivekit.1-7d3572a0-amd64`, image ID
`sha256:e266932c428610111a417d6b38cbec7096680816eae09b23495575035456d3fe`,
size `1,413,726,105` bytes. Runtime user, source revision, pool-contract labels,
version and iveKit binary markers passed inspection. This is a controlled
source-built candidate, not an immutable registry digest or production
artifact. The earlier local arm64 build remains historical evidence; execution
of the new multi-architecture GHCR workflow remains `not_run`.

## Storage failure isolation

LiveKit Server does not depend on Egress or object storage. Egress runs in
separate bounded Track and Composite pools and may fail, drain or accumulate
bounded local spool without terminating a room, publisher, subscriber or
screen-share track. The Cell-10K and MIX-100K profiles require
`recording.failure_isolation`: storage is downstream-only, established media
continues fail-open, media hot-path backpressure is forbidden, queues are
bounded and non-blocking, and overload may only drop or fail the recording
copy. A real object-storage outage/resume drill, deployed pool isolation, real
media continuity, target Kubernetes and capacity evidence remain `not_run`.
