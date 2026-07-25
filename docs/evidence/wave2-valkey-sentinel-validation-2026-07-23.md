# Wave 2 Valkey Sentinel Controlled Validation

## Result

`passed_controlled_server`

The isolated three-data-node, three-Sentinel deployment elected a different
primary and the production ioredis connection path recovered. This is controlled
single-host evidence, not production or capacity evidence.

## Environment

- Validation server: `64.225.122.227`, Linux amd64
- Valkey image: `valkey/valkey@sha256:1da6597cc08f09748b05f7a845492581c9442ea240be8e7bbfeb5f83ad1bcec8`
- Valkey version: `9.1.0`
- Probe image: `node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`
- Actual acceptance source SHA-256: `9198d49a886dff35c8bc8c0447799f2aa7cc42665f70b91975f377260c62fb0f`
- Machine evidence: `docs/evidence/wave2-valkey-sentinel-runtime-2026-07-23.json`

The server source directory did not expose Git metadata, so `source_commit` is
`unknown`; the acceptance source SHA-256 is the execution identity.

## Topology and Security

- three persistent Valkey data nodes;
- three Sentinel voters, quorum 2;
- separate generated ACL credentials for application, replication,
  Sentinel-to-data, Sentinel client and Sentinel peer paths;
- non-root uid/gid `999:1000`, read-only root filesystems, all Linux capabilities
  dropped and `no-new-privileges` enabled;
- internal Docker network with no host ports;
- all waits, pulls, probes and cleanup operations bounded;
- credentials omitted from logs and evidence.

## Procedure

1. Verified the server identity and exact seven-container LED invariant.
2. Pulled immutable Valkey and Node image identities.
3. Started three data nodes and three Sentinel voters.
4. Waited for data PING, Sentinel PING, two healthy replicas per Sentinel, two
   peer Sentinels per Sentinel and successful `CKQUORUM` on all voters.
5. Used the production resolver and ioredis constructor mapping to write a
   TTL-bound canary and verify Pub/Sub.
6. Verified the canary on all three data nodes.
7. Paused the elected primary while retaining its stable network identity.
8. Waited for a different primary and agreement from at least two Sentinels.
9. Reconnected through Sentinel, read the old canary, wrote/read a new canary and
   verified Pub/Sub again.
10. Removed the isolated containers, volumes and network and rechecked LED.

## Measurements

- old primary: `valkey-1`
- new primary: `valkey-3`
- primary election observed: `6871 ms`
- application probe recovered: `8594 ms`
- pre-failover canary survived: yes
- post-failover write/read: yes
- Pub/Sub before and after failover: yes
- LED running containers after cleanup: exactly 7

These timings are observations from one controlled run, not SLOs or benchmark
results.

## Defects Found and Fixed

1. The official image entrypoint needed `SETUID/SETGID`, conflicting with
   `cap_drop: ALL`. Containers now start directly as the image's non-root
   `999:1000` user while retaining the capability drop.
2. Removing the primary container also removed its ephemeral Docker DNS record,
   repeatedly forcing Sentinel into TILT. The election drill now freezes the
   process with stable identity; DNS loss remains a separate target-environment
   test.
3. Fault injection originally began before Sentinel replica discovery converged.
   A fail-closed topology readiness gate now requires healthy replicas, peers and
   quorum on all three voters.
4. Failure cleanup originally erased the only diagnostics. The runner now emits
   redacted status and tail logs before guaranteed cleanup.

## Cleanup

- no acceptance containers remained;
- no acceptance volumes remained;
- no acceptance network remained;
- all seven pre-existing LED containers remained running.

## Not Proven

- target Kubernetes or multi-host deployment;
- cross-Zone partition or Zone loss;
- LiveKit real-room, Egress, Ingress or SIP continuity;
- soak, backup restore, rotation or throughput;
- Cell-10K or MIX-100K capacity.
