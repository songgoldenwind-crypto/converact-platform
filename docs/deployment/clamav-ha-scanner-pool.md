# ClamAV HA Scanner Pool

## 1. Boundary

ClamAV scans immutable staged files before they may enter attachment delivery, conversion, OCR,
ASR, AI quality review, or evidence export. It is not part of SIP, RTP, LiveKit SFU, Tinode message
fanout, or RustDesk relay paths. Scanner failure leaves a file quarantined or retryable and must not
change API readiness or interrupt active communication.

## 2. Production Topology

The bundled Helm option uses an immutable ClamAV 1.5.2 image and at least two StatefulSet replicas.
Each replica owns a separate `ReadWriteOnce` signature PVC. A shared RWO volume is forbidden because
it prevents independent scheduling and rolling replacement. The client ClusterIP sends each new
INSTREAM TCP connection only to ready Pods; the Node scanner opens a new bounded connection for each
scan, so Kubernetes can distribute work across the pool.

Required controls:

- required host anti-affinity and zone topology spread;
- PDB with at least one available scanner;
- clamd available only on private port 3310;
- NetworkPolicy ingress only from iveKit API/worker Pods;
- DNS plus TCP 80/443 egress only for signature updates;
- independent 4 GiB memory ceiling per scanner for database reloads;
- signature files retained when the StatefulSet is scaled or deleted.

## 3. Signature Freshness

`freshclam` remains managed by the official unprivileged image entrypoint. Readiness requires both a
successful clamd ping and at least one `.cvd` or `.cld` database file newer than
`clamav.signatureMaxAgeMinutes` (default 4320 minutes). Stale replicas remain running for diagnosis
but leave the client Service; liveness does not restart them continuously. Alert when any replica is
stale and page when the ready pool falls below one.

Signature rollout is eventually consistent across independent Pods. Do not copy one Pod's database
directory into another live Pod. Restore a missing or corrupt member by replacing that Pod/PVC and
letting `freshclam` bootstrap a clean signature set.

## 4. Work And Failure Semantics

PostgreSQL secure-file rows and claim leases are authoritative. A timeout, refused connection,
scanner engine error, or Pod loss is retryable. The worker releases or expires its lease and another
worker can claim the file. Infected content is terminally quarantined and logs only the normalized
threat code; raw content and provider secrets never enter logs or audit metadata.

The pool is intentionally independent from recording, media, IM and remote-control resources. Do
not add ClamAV as an API init container, readiness dependency, synchronous upload response gate, or
media sidecar.

## 5. Server Acceptance

Archive exact image digests, chart values, node names, timestamps and raw outputs for:

1. Helm lint and template with ClamAV enabled and immutable application/scanner digests;
2. two ready scanner Pods on distinct hosts, each with a different PVC;
3. signature timestamp/version inspection on every Pod;
4. a clean file and the standard EICAR test file through the public secure-file API;
5. infected result in terminal quarantine without plaintext signature content in logs or APIs;
6. deletion of one scanner Pod while a sustained scan queue runs, proving retry and continued drain;
7. signature egress outage until one Pod exceeds the freshness limit and is removed from endpoints;
8. full scanner outage, recovery, and durable retry without attachment misdelivery;
9. oversized stream, timeout, malformed clamd response and slow-consumer pressure;
10. concurrent SIP call, LiveKit room, Tinode session and RustDesk relay proving scanner failure does
    not terminate or materially degrade the realtime paths.

The repository contains controlled scanner and quarantine tests. They do not replace this target
server/cluster evidence, which remains `not_run` until executed and archived.
