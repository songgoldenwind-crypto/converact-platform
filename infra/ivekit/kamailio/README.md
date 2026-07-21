# iveKit Kamailio SIP Edge image

The image is built from the exact upstream source `kamailio/kamailio@6.0.7`.
The source archive SHA-256 is fixed in the Dockerfile. The build includes the
standard module group plus `dispatcher`, `dialog`, `htable`, `tls`, `websocket`
and `xhttp_prom`, which are required by the generated iveKit edge config.

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
