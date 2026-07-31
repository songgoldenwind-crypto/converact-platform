# iveKit Kamailio SIP Edge image

The image is built from the exact upstream source `kamailio/kamailio@6.0.7`.
It downloads Kamailio's static official `6.0.7_src.tar.gz` release archive,
whose SHA-256 is fixed in the Dockerfile; GitHub's dynamically generated tag
archive is deliberately not used as a reproducible build input. The build includes the
standard module group plus `dispatcher`, `dialog`, `htable`, `tls`, `websocket`
and `xhttp_prom`, plus `jwt`, `jansson`, `registrar`, `usrloc`, `path`, `dmq`
and `dmq_usrloc`, which are required by the generated iveKit edge config. The
image also includes `siptrace` for the optional, off-path HEPv3 integration.
Kamailio 6.0.7 requires libjwt 1.12 or newer and does not support libjwt 3.x.
Debian Bookworm only packages libjwt 1.10.2, so the image also verifies and
builds the official libjwt 2.1.3 release archive instead of linking the
incompatible distribution package.

The image also applies the reviewed
`patches/0001-dispatcher-retain-probe-state.patch`. New-call destinations start
inactive and probing. Only dispatcher rows carrying
`ivekit_retain_state=1` retain their OPTIONS state and consecutive-probe count
across a file reload. This prevents capacity-weight refreshes from reviving a
down RustPBX node, while a newly admitted node must pass the configured OPTIONS
success threshold before it receives a call. Removing a node from the signed
new-call pool still removes it from dispatcher regardless of retained state.

WebPhone WSS uses an exact HTTPS Origin allowlist and a file-backed HS256 key.
Kamailio binds the verified JWT subject to the connection and SIP From, then
generates a fresh 30-second internal assertion for RustPBX to verify on every
request. REGISTER is stored in Edge usrloc only after RustPBX returns 2xx.
Production replicas run as a StatefulSet and replicate only authenticated
locations through an internal UDP 5066 DMQ listener; the public SIP Service
must never expose that port. Browser tokens, connection htable values, RPC
tokens and topology keys must not enter logs or generated evidence.

HEP capture is disabled by default. When enabled, `siptrace` duplicates SIP to
a private HOMER-compatible UDP collector, never writes a local trace database,
and drops OPTIONS and KDMQ capture noise. Collector reachability is not a
readiness or call-admission dependency. Restrict the collector with the Helm
NetworkPolicy CIDR list and complete the load/failure gates in
`docs/deployment/kamailio-homer-hep.md` before enabling it in production.

The previous `kamailio/kamailio:5.8` Compose reference did not identify an
existing image. The official 5.8 store artifacts are amd64-only, so they are not
the production contract. iveKit builds amd64 and arm64 from the same source and
deploys only a registry reference pinned by digest.

```bash
IVEKIT_KAMAILIO_IMAGE=registry.example.com/ivekit/kamailio:6.0.7-ivekit.1 \
IVEKIT_KAMAILIO_PUSH=true \
bash infra/ivekit/kamailio/build.sh
```

Generate `kamailio.cfg` and `tls.cfg` with `npm run ivekit:kamailio:render`.
Then use the immutable registry image to run the parser and module check:

```bash
IVEKIT_KAMAILIO_IMAGE=registry.example.com/ivekit/kamailio@sha256:<digest> \
IVEKIT_KAMAILIO_CONFIG_DIR=/path/to/generated-config \
IVEKIT_KAMAILIO_SECRETS_DIR=/path/to/tls-secrets \
IVEKIT_KAMAILIO_STATE_DIR=/path/to/dispatcher-state \
bash scripts/verify-kamailio-config.sh
```

The verifier executes `kamailio -c` with no network, a read-only root filesystem
and all Linux capabilities removed. A source build and parser pass are required
before publishing a release digest. They are not a SIP functional or capacity
claim.
