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

On 2026-07-18 the overlay applied repeatedly to the exact `v1.13.0` source and
the local pool-policy Go module passed its tests. The custom image build remains
`not_run`: the first attempt was stopped while Docker Hub was downloading the
upstream 840.69 MB and 522.39 MB GStreamer layers at about 0.2 MB/s. No image or
digest is claimed. Deployed pool isolation, object-storage outage injection and
real media continuity also remain `not_run`.
