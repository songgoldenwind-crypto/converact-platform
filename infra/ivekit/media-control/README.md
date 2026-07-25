# iveKit Media Control Agent

This image is the Goal 1 cell-local RustPBX-to-media-node control agent.
It provides the versioned owner/reservation/epoch/sequence contract,
idempotency, unknown reconciliation, bounded state, and low-cardinality
metrics.

The only transport currently compiled into this image is the deterministic
Goal 1 simulator. The entrypoint refuses to run it with
`IVEKIT_MEDIA_CONTROL_PRODUCTION=true`. Goal 2 replaces that transport port
with the pinned iveKit rtpengine fork before the service becomes production
eligible.

Required development/acceptance configuration:

```text
IVEKIT_MEDIA_CONTROL_PRODUCTION=false
IVEKIT_MEDIA_CONTROL_TRANSPORT=simulator
IVEKIT_MEDIA_CONTROL_TOKEN_FILE=/run/secrets/media-control-token
IVEKIT_MEDIA_CONTROL_ADMISSION_ENDPOINT=http://rustpbx:3210
IVEKIT_MEDIA_CONTROL_ADMISSION_TOKEN_FILE=/run/secrets/component-node-token
```

Production additionally requires:

```text
IVEKIT_MEDIA_CONTROL_PRODUCTION=true
IVEKIT_MEDIA_CONTROL_TLS_KEY_FILE=/run/secrets/media-control-tls-key
IVEKIT_MEDIA_CONTROL_TLS_CERT_FILE=/run/secrets/media-control-tls-cert
IVEKIT_MEDIA_CONTROL_TLS_CA_FILE=/run/secrets/media-control-tls-ca
```

Production mode remains intentionally unavailable until Goal 2 supplies a
non-simulator transport. This is a release gate, not an undocumented fallback.

## Goal 1 Controlled Acceptance

Run the acceptance command from the exact deployed source commit. Supply the
locally inspected image ID and a SHA-256 hash of the rendered deployment
configuration:

```bash
OPC_IVEKIT_MEDIA_GOAL1_SOURCE_COMMIT=<40-character-commit> \
OPC_IVEKIT_MEDIA_GOAL1_IMAGE_DIGEST=sha256:<64-hex-image-id> \
OPC_IVEKIT_MEDIA_GOAL1_CONFIG_HASH=sha256:<64-hex-config-hash> \
OPC_IVEKIT_MEDIA_GOAL1_GENERATED_AT=<ISO-8601-UTC-timestamp> \
OPC_IVEKIT_MEDIA_GOAL1_ACCEPTANCE_DIR=<new-empty-output-directory> \
npm run ivekit:voice-media-goal1:acceptance
```

The output proves Goal 1 fencing, idempotency, lifecycle, uncertainty
reconciliation, agent restart recovery, and established-forwarding independence
under the deterministic transport. It deliberately records
`capacity_claim: none` and marks real rtpengine forwarding, physical media
quality, and physical capacity as `not_run`.
