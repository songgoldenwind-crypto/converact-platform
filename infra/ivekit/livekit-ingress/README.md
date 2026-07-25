# iveKit LiveKit Ingress exact-source image

This build contract targets only `livekit/ingress` `v1.5.0` at commit
`363f6090d572db8eef5b60c273c0970826fb7ca6`.

The overlay replaces upstream's mutable toolchain download and floating
GStreamer stages with two digest-bound image inputs. `build.sh` verifies the
tag and commit, vendors dependencies, materializes the SumDB-verified Go
1.25.0 toolchain for the selected architecture, and runs the final image build
with `--network=none`. The resulting process runs as `10001:10001`; image
architecture, source revision, component label and Ingress version are checked
before the script succeeds.

This overlay changes only the image construction contract. It does not fork
LiveKit Ingress scheduling, media processing or protocol behavior. iveKit owns
tenant authorization, idempotency and URL pull policy in its HTTP facade, while
LiveKit Ingress remains the runtime authority for RTMP, WHIP and URL input jobs.

## Build

```bash
LIVEKIT_INGRESS_SOURCE_DIR=/path/to/livekit-ingress-v1.5.0 \
IVEKIT_LIVEKIT_INGRESS_IMAGE=ivekit/livekit-ingress:v1.5.0-ivekit.1-363f6090-amd64 \
IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE=docker.io/livekit/gstreamer:1.26.7-dev@sha256:<digest> \
IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE=docker.io/livekit/gstreamer:1.26.7-prod@sha256:<digest> \
IVEKIT_LIVEKIT_INGRESS_TARGETARCH=amd64 \
bash infra/ivekit/livekit-ingress/build.sh
```

Supported targets are `linux/amd64` and `linux/arm64`. The matching Go module
checksums are embedded in `build.sh`; a different toolchain archive, source
commit, base-image format, runtime identity or version fails closed.

## Deployment

`infra/k8s/templates/livekit-ingress-deployment.yaml` deploys a stateless
worker `Deployment`, two Services, a disruption budget and a NetworkPolicy.
The worker uses the same LiveKit API credentials and Redis request bus as
LiveKit Server. RTMP (`1935/TCP`), WHIP control (`8080/TCP`) and WHIP media
(`7885/UDP`) are exposed separately from health and Prometheus ports.

The default two replicas use required hostname anti-affinity, zone spreading,
`maxSurge: 0`, readiness on `/availability`, a read-only root filesystem and a
bounded writable `/tmp`. When `hostNetwork` is enabled, schedule at most one
Ingress pod per node because the public ports are node-local. Production must
pin `media.ingress.image.digest` to the manifest accepted by the OCI release
gate.

URL input is denied unless the API is given an explicit
`OPC_LIVEKIT_INGRESS_PULL_HOST_ALLOWLIST`. HTTPS is mandatory by default,
credentials in URLs and local/private IP literals are rejected, and Kubernetes
outbound access must be restricted to trusted pull destinations by the target
cluster's egress policy. Host allowlisting alone does not prove DNS-rebinding
resistance; deployments with untrusted or tenant-controlled source hosts must
use an egress proxy or equivalent destination enforcement.

## Controlled evidence

On 2026-07-23 the isolated Linux amd64 validation server applied the overlay
twice, built the final image offline and verified runtime identity. The
candidate image is
`ivekit/livekit-ingress:v1.5.0-ivekit.1-363f6090-amd64`, image ID
`sha256:639b1689dfae305b6495467c71ed7e2ce42f2c43161a512d91bfb38310ec3bf9`,
size `260,631,118` bytes. This is controlled server evidence, not a published,
signed production artifact or real-media capacity result. See
`docs/evidence/wave2-livekit-ingress-v1.5.0-validation-2026-07-23.md`.
