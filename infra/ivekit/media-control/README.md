# iveKit Media Control Agent

This image is the Goal 1 cell-local RustPBX-to-media-node control agent.
It provides the versioned owner/reservation/epoch/command_sequence contract,
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
IVEKIT_MEDIA_CONTROL_ADMISSION_REQUIRE_MTLS=true
IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_KEY_FILE=/run/secrets/admission-client-key
IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_CERT_FILE=/run/secrets/admission-client-cert
IVEKIT_MEDIA_CONTROL_ADMISSION_TLS_CA_FILE=/run/secrets/admission-ca
OPC_IVEKIT_COMPONENT_NODE_PRODUCTION=true
OPC_IVEKIT_COMPONENT_NODE_REQUIRE_MTLS=true
OPC_IVEKIT_COMPONENT_NODE_TLS_KEY_FILE=/run/secrets/admission-server-key
OPC_IVEKIT_COMPONENT_NODE_TLS_CERT_FILE=/run/secrets/admission-server-cert
OPC_IVEKIT_COMPONENT_NODE_TLS_CA_FILE=/run/secrets/admission-ca
```

Production mode remains intentionally unavailable until Goal 2 supplies a
non-simulator transport. This is a release gate, not an undocumented fallback.

## Goal 1 Controlled Acceptance

Build with the exact source revision label, deploy the container, and save the
rendered Compose configuration. The acceptance command inspects Git, the
running healthy container, its immutable image ID, and the rendered
configuration directly; callers cannot supply those hashes:

```bash
OPC_SOURCE_COMMIT="$(git rev-parse HEAD)" \
docker compose build media-control

OPC_IVEKIT_MEDIA_GOAL1_SOURCE_DIR=<clean-git-checkout> \
OPC_IVEKIT_MEDIA_GOAL1_CONTAINER_NAME=<running-media-control-container> \
OPC_IVEKIT_MEDIA_GOAL1_RENDERED_CONFIG_FILE=<saved-compose-config> \
OPC_IVEKIT_MEDIA_GOAL1_GENERATED_AT=<ISO-8601-UTC-timestamp> \
OPC_IVEKIT_MEDIA_GOAL1_ACCEPTANCE_DIR=<new-empty-output-directory> \
npm run ivekit:voice-media-goal1:acceptance
```

The controlled output proves Goal 1 fencing, idempotency, lifecycle, uncertainty
reconciliation, agent restart recovery, and established-forwarding independence
under the deterministic transport. Its status is `controlled_passed`, not a
production deployment or capacity pass. It deliberately records
`capacity_claim: none` and marks real rtpengine forwarding, physical media
quality, physical capacity, RustPBX runtime wiring, and container restart
persistence as `not_run`.
