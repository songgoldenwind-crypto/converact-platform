# iveKit Media Control Agent

This image is the cell-local RustPBX-to-media-node control agent.
It provides the versioned owner/reservation/epoch/command_sequence contract,
idempotency, unknown reconciliation, bounded state, and low-cardinality
metrics.

Two transports are compiled:

- `simulator` is limited to development and controlled Goal 1 acceptance;
- `rtpengine` executes real TCP NG commands against the pinned iveKit
  RTPengine fork and is the only transport accepted in production mode.

Development simulator configuration:

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
IVEKIT_MEDIA_CONTROL_TRANSPORT=rtpengine
IVEKIT_RTPENGINE_NG_ENDPOINT=tcp://rtpengine:22222
IVEKIT_RTPENGINE_RUNTIME_MODE=userspace
IVEKIT_MEDIA_CONTROL_WAL_DIRECTORY=/var/lib/ivekit-media-control
IVEKIT_MEDIA_CONTROL_WAL_MAX_RECORDS=1000000
IVEKIT_MEDIA_CONTROL_WAL_MAX_BYTES=268435456
IVEKIT_MEDIA_CONTROL_WAL_MAX_RECORD_BYTES=2097152
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

The process can now run with a real production transport, but the Goal 2
release remains `production_eligible=false`. Kernel, recording, transcoding,
seven failure-matrix rows, image signing, and physical capacity are still
explicit gates.

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

## Goal 2 RTPengine Runtime

RustPBX owns Call, Leg, Dialog, routing policy, and the logical media graph.
The media-control agent is the only iveKit caller of RTPengine. RTPengine owns
effective wire SDP, relay ports, packet forwarding, SRTP state, drain state,
and its native transport counters.

PostgreSQL, Redis, NATS, object storage, recording upload, OCR, ASR, translation,
and AI are not on the RTP packet path. Restarting media-control or Cell
admission must not restart RTPengine.

Deployment rules:

1. Pin RTPengine and media-control by immutable image digest.
2. Keep TCP NG private to the Cell; expose only the declared RTP/RTCP UDP range.
3. Give media-control a persistent bounded WAL volume and read-only root
   filesystem.
4. Keep RTPengine and media-control in the same Cell and failure domain.
5. Do not reuse a userspace capacity result for kernel, recording, or
   transcoding profiles.

## Drain And Rollback

Before replacing an RTPengine process:

1. remove the media node from new-call placement;
2. run `scripts/ivekit-rtpengine-drain.ts` against its private NG endpoint;
3. verify new offers are rejected and wait for the active-call count to reach
   zero;
4. retain the rendered config, image digest, WAL, and evidence before replacing
   the image.

A planned rollback follows the same drain-to-zero sequence, then selects the
previous immutable image and compatible config. Replacing RTPengine with active
calls interrupts those calls and is an emergency operation, not a transparent
rollback. Never delete or truncate the media-control WAL during rollback.

## WAL Recovery

For a media-control-only restart, keep RTPengine running and mount the same WAL
inode. Startup replays bounded command facts, queries RTPengine, resolves
unknown outcomes, and acknowledges the recovered session before readiness.
Admission must remain closed if WAL validation, replay acknowledgement, or
RTPengine reconciliation fails.

The WAL is local recovery state, not a cross-Cell migration mechanism. A new
Cell owner receives a higher owner epoch and rebuilds from authoritative call
facts; it must not copy an active RTP transport through Redis or PostgreSQL.

## Kernel Compatibility And Fallback

`IVEKIT_RTPENGINE_RUNTIME_MODE` accepts `userspace`, `kernel`, or `auto`.
`kernel` fails closed unless the loaded `nft_rtpengine` source identity matches
the identity embedded in the runtime image. `auto` may select userspace only
with an explicit fallback metric and a distinct capacity profile.

The current Goal 2 evidence covers userspace only. No kernel module identity or
kernel capacity claim exists for the validation server.

## Goal 2 Evidence Finalizer

The finalizer reads the immutable contract, supply-chain evidence, lifecycle
stages, every retained acceptance attempt, and the complete failure matrix:

```bash
IVEKIT_RTPENGINE_GOAL2_CONTRACT=<absolute-contract-path> \
IVEKIT_RTPENGINE_GOAL2_SUPPLY_CHAIN=<absolute-supply-chain-path> \
IVEKIT_RTPENGINE_GOAL2_STAGES=<absolute-stage-evidence-path> \
IVEKIT_RTPENGINE_GOAL2_ATTEMPTS=<absolute-attempt-manifest-path> \
IVEKIT_RTPENGINE_GOAL2_FAILURE_EVIDENCE=<absolute-failure-evidence-path> \
IVEKIT_RTPENGINE_GOAL2_GENERATED_AT=<ISO-8601-UTC-timestamp> \
IVEKIT_RTPENGINE_GOAL2_CAPACITY_CLAIM=none \
IVEKIT_RTPENGINE_GOAL2_OUTPUT=<new-absolute-output-path> \
npm run ivekit:voice-media-goal2:finalize
```

The output is created once with mode `0600`. Functional acceptance can promote
`real_environment` for one exact runtime artifact, but it cannot create a
capacity claim. A measured userspace or kernel claim requires at least three
valid repetitions for one runtime mode, one config identity, zero
reconciliation delta, and a qualified non-overloaded generator.
