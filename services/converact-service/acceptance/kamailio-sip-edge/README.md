# Kamailio SIP Edge controlled acceptance

This gate verifies signaling and fault semantics; it is not a capacity test.
The source commit and immutable Kamailio/RustPBX image digests bind every report.
Missing evidence remains `not_run`; the aggregator never converts a planned or
missing observation into a pass.

The directory is an independent Node package. Run `npm ci` once after extracting
the delivery bundle; its exact `tsx` and `ws` versions are locked locally and do
not borrow dependencies from a Converact checkout.

## Preconditions

1. Start the standalone stack with both Compose files and `--profile voice-capacity`.
2. Cell admission is the authority. It must own the Cell lease, replay
   reservations and continuously lease both component-node endpoints before
   calls are sent. Do not hand-edit `dispatcher.list`.
3. Use the SHA-256 pinned SIPp tool from the existing RustPBX acceptance kit. Use
   `webphone-runner.ts` for SIP-over-WSS; SIPp is not treated as WebSocket evidence.
4. Capture the generated Kamailio config, signed snapshot, dispatcher file,
   route-agent metrics, Kamailio metrics, both component states, SIPp CSV/message
   logs and RustPBX Router/CDR owner observations for every scenario.

## Scenario procedure

Run the twelve contracts exported by `scripts/converact-kamailio-acceptance.ts`:
weighted distribution, dialog affinity, transport and 503 retry, 486 no-retry,
drain, node down/up, stale snapshot fail-closed, forged-header sanitization,
public-port DMQ rejection, WebPhone registration refresh and cross-Edge delivery.
Faults must be injected only after baseline health is captured. Restore a node
through both a fresh component lease and successful OPTIONS; process reachability
alone is not recovery.

The WebPhone runner requires an exact HTTPS Origin and reads the browser token
from an absolute file. It never writes the token into evidence. For the refresh
scenario, set the delay beyond the browser token TTL while keeping the WSS
connection open; the second REGISTER must succeed through a fresh, 30-second
Edge assertion. For cross-Edge delivery, register through Edge A, wait until
Edge B reports the replicated location, remove Edge A from the Service, then
originate from RustPBX through Edge B. Preserve both Edge metrics and SIP logs.

```bash
CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ACCEPTANCE_ENDPOINT=wss://voice.example.com/ws \
CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ACCEPTANCE_ORIGIN=https://agent.example.com \
CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ACCEPTANCE_IDENTITY=agent-42 \
CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ACCEPTANCE_REALM=sip.example.com \
CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ACCEPTANCE_TOKEN_FILE=/run/secrets/webphone-token \
CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ACCEPTANCE_REFRESH_DELAY_MS=310000 \
npm run webphone
```

Each evidence file is named `<scenario-id>.json` and contains the exact
assertion keys exported by the script, at least one bounded artifact with byte
count and SHA-256, and canonical ISO timestamps. The aggregator reopens every
regular file below the evidence root, rejects symlinks/path escape, and verifies
the actual byte count and SHA-256 before it can report a pass. Artifact paths
must live under their own `<scenario-id>/` directory and cannot be reused by
another scenario. Token and identity values are omitted from the WebPhone runner
result. Aggregate from this directory with:

```bash
CONVERACT_FABRIC_KAMAILIO_ACCEPTANCE_SOURCE_COMMIT=<40-hex-commit> \
CONVERACT_FABRIC_KAMAILIO_ACCEPTANCE_ENVIRONMENT_ID=<environment-id> \
CONVERACT_FABRIC_KAMAILIO_ACCEPTANCE_EVIDENCE_DIR=<absolute-or-relative-directory> \
CONVERACT_FABRIC_KAMAILIO_IMAGE=<registry/image@sha256:digest> \
RUSTPBX_IMAGE=<registry/image@sha256:digest> \
npm run accept
```

`ready_for_review` means every controlled scenario supplied valid passing
evidence. It still requires independent review. Physical CPS, endurance, public
PSTN, real dual-Zone failover and the MIX-100K target remain `not_run`; this
suite does not produce a 10 万并发 or any other capacity conclusion.
换言之，本受控验收不构成 10 万并发容量结论。
