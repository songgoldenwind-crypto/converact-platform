# Wave 1 ClamAV Server Validation - 2026-07-22

## Environment

| Field | Evidence |
| --- | --- |
| Server | `pmt-web-test-sfo2` (`64.225.122.227`) |
| Architecture | `x86_64` |
| Capacity | 4 vCPU, 7.8 GiB RAM |
| Isolation | `/opt/opc-wave123-validation-20260722`; no LED volume, database, network, or port reused |
| Test container limits | Node: 2 CPU / 4 GiB; ClamAV: 1 CPU / 3 GiB |
| ClamAV image | `clamav/clamav:1.5.2_base@sha256:3aa0c6d6a966dc062899e070fb13f87485acf0cbb710fccaae9a848cd5f5b09a` |

## Results

1. Wave 1 NATS/capacity/supply-chain/release focused tests: `44/44` passed in a Node 24 server container.
2. Root TypeScript and capacity-runtime TypeScript compilation passed on the server.
3. ClamAV Helm `v3.18.4` lint and the repository HA verifier passed. The rendered output contains a
   two-replica StatefulSet, headless and client Services, per-Pod RWO claim templates, PDB,
   NetworkPolicy, host anti-affinity, topology spread, and signature freshness readiness. A
   single-replica override is rejected.
4. The exact ClamAV image downloaded and tested signature databases successfully. Runtime reported
   `ClamAV 1.5.2/28068/Wed Jul 22 06:24:50 2026` and `clamdscan --ping 1` returned `PONG`.
5. A real TCP INSTREAM acceptance returned `clean` for the clean fixture and
   `eicar-test-signature` for the standard EICAR fixture. The acceptance output contained no file
   bytes.
6. Secure-file, MIME, scan, quarantine, derivative, multipart, cleanup, HTTP and SDK regression:
   `59/59` passed on the server.
7. The scanner published no host port. Point-in-time steady resource observation was approximately
   `0.01% CPU` and `960.6 MiB` memory after signatures loaded.
8. The validation scanner and its temporary Docker network were stopped and removed after the run;
   the signature directory remains under the isolated validation directory.

## Evidence Boundary

This server is one physical Docker host and has no Kubernetes cluster. The run proves the current
image, clamd TCP path, clean/EICAR behavior, server-side regressions, and Helm rendering. It does not
prove cross-node scheduling, PDB behavior, PVC replacement, stale-signature endpoint removal, node
loss, rolling upgrade, long-duration queue drain, or concurrent media isolation. Those target
Kubernetes tests remain `not_run`.
