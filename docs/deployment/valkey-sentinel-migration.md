# Valkey Sentinel Migration and Rollback

> Status: controlled single-host acceptance passed; production cutover not authorized
> Evidence date: 2026-07-23
> Validation server: `64.225.122.227`

## 1. Scope and Authority

This runbook migrates OPC/iveKit coordination clients and LiveKit Server, Egress,
Ingress and SIP from a frozen Redis 7 deployment to Valkey 9.1.x with Sentinel.
It does not change the public OPC or LED APIs.

PostgreSQL remains the only transactional authority. Valkey may contain bounded
cache, routing, presence, idempotency and at-most-once Pub/Sub state. A failed or
ambiguous Valkey write must be rebuilt from PostgreSQL or the originating event.
There is no dual write between Redis and Valkey.

Tinode is not a Valkey consumer in the approved architecture. It uses PostgreSQL,
S3-compatible object storage and its native three-node ring.

## 2. Current Evidence

The controlled server run proved:

- immutable `valkey/valkey:9.1.0-alpine3.23` amd64 image identity;
- three persistent data nodes and exactly three Sentinel voters with quorum 2;
- separate data, replication, Sentinel-control, Sentinel-client and peer ACLs;
- converged replica, Sentinel peer and `CKQUORUM` readiness before fault injection;
- elected-primary process pause with a stable network identity;
- a different writable primary elected in 6.871 seconds;
- the production ioredis resolver reconnected in 8.594 seconds;
- pre-failover `SET EX` data survived and post-failover write/read succeeded;
- Pub/Sub delivered before and after failover;
- isolated resources were removed and the seven LED containers were unchanged.

Machine evidence:
`docs/evidence/wave2-valkey-sentinel-runtime-2026-07-23.json`.
The evidence binds the actual acceptance source with
`acceptance_source_sha256=9198d49a886dff35c8bc8c0447799f2aa7cc42665f70b91975f377260c62fb0f`.

## 3. Required Production Topology

Use one writable primary, at least two persistent replicas and exactly three
Sentinel voters. Spread data nodes and Sentinel voters across failure domains so
one Zone loss cannot remove quorum. Do not co-locate all voters on one host.

Every data-node identity used by Sentinel must remain resolvable while that node
is down. A short-lived container DNS record is not a production identity. For
Kubernetes, validate stable StatefulSet identities and headless-service behavior,
including DNS during pod unavailability, before cutover.

The upstream Valkey Operator remains POC-only while upstream describes it as WIP.
Eligible production choices are a validated managed Valkey/Redis Sentinel service
or an owned StatefulSet/Sentinel deployment with tested backup and failover.

## 4. Client Contract

Direct mode is the rollback default:

```dotenv
REDIS_TOPOLOGY=direct
REDIS_URL=redis://redis-primary.internal:6379
REDIS_USERNAME=ivekit-data
REDIS_PASSWORD=<secret-ref>
REDIS_TLS_MODE=disabled
REDIS_CONNECT_TIMEOUT_MS=5000
REDIS_RECONNECT_WAIT_MS=1000
REDIS_MAX_RECONNECT_ATTEMPTS=-1
```

Sentinel mode must not set `REDIS_URL`:

```dotenv
REDIS_TOPOLOGY=sentinel
REDIS_URL=
REDIS_SENTINEL_MASTER_NAME=ivekit
REDIS_SENTINEL_ADDRESSES=sentinel-0.internal:26379,sentinel-1.internal:26379,sentinel-2.internal:26379
REDIS_USERNAME=ivekit-data
REDIS_PASSWORD=<data-secret-ref>
REDIS_SENTINEL_USERNAME=ivekit-sentinel-client
REDIS_SENTINEL_PASSWORD=<sentinel-secret-ref>
REDIS_TLS_MODE=required
REDIS_TLS_SERVER_NAME=valkey.internal
REDIS_TLS_CA_FILE=/run/secrets/valkey/ca.crt
REDIS_TLS_CERT_FILE=/run/secrets/valkey/tls.crt
REDIS_TLS_KEY_FILE=/run/secrets/valkey/tls.key
REDIS_CONNECT_TIMEOUT_MS=5000
REDIS_RECONNECT_WAIT_MS=1000
REDIS_MAX_RECONNECT_ATTEMPTS=-1
```

The resolver rejects mixed direct/Sentinel configuration, fewer or more than
three Sentinel endpoints, duplicate endpoints, embedded URL credentials,
incomplete ACL pairs, unverified TLS and incomplete mTLS pairs.

## 5. LiveKit Contract

`infra/k8s/values.yaml` exposes one `livekit.redis` block shared by OPC and
LiveKit Server, both Egress pools, Ingress and SIP. In Sentinel mode configure:

```yaml
livekit:
  redis:
    mode: sentinel
    address: ""
    sentinelMasterName: ivekit
    sentinelAddresses:
      - sentinel-0.internal:26379
      - sentinel-1.internal:26379
      - sentinel-2.internal:26379
    username: livekit-data
    password: <secret-value>
    sentinelUsername: livekit-sentinel-client
    sentinelPassword: <secret-value>
    tls:
      enabled: true
      secretName: livekit-redis-tls
      serverName: valkey.internal
      caKey: ca.crt
      clientCertKey: tls.crt
      clientKeyKey: tls.key
```

Do not point a worker pool at a different logical primary. Do not cut over until
real rooms, Egress, Ingress and SIP survive the same primary failure.

## 6. ACL Policy

Use separate credentials for application data, replication, Sentinel access to
data nodes, clients querying Sentinel and Sentinel peers. The acceptance package
uses generated credentials and records none of them.

Production ACLs should be narrowed to the inventory in
`docs/architecture/valkey-command-inventory-v1.json`. Sentinel's data-node user
also needs the command set documented by the official
[Valkey Sentinel guide](https://valkey.io/topics/sentinel/), including Valkey 9
`FAILOVER` and `CLIENT` permissions. Sentinel peers require a shared superuser on
each Sentinel instance. Rotate data and Sentinel credentials independently.

## 7. Migration Sequence

1. Freeze the Redis version and capture configuration, memory, key count, latency,
   eviction, replication and client-connection baselines.
2. Deploy Valkey beside Redis with isolated endpoints. Do not dual write.
3. Verify TLS, ACLs, persistent volumes, backups, replica offsets, three-voter
   discovery and quorum in the target environment.
4. Run command compatibility and the controlled failover suite.
5. Cut over one non-critical OPC/iveKit canary by Secret/config revision.
6. Verify error rate, reconnects, cache rebuild, Pub/Sub recovery and tail latency.
7. Cut over LiveKit components only after real media failover evidence passes.
8. Expand by Cell and keep Redis intact through the rollback observation window.
9. Retire Redis only after target-cluster, cross-Zone, soak and rollback gates pass.

## 8. Rollback

Rollback is a configuration revision, not a data merge:

1. stop new admission for the affected Cell while established media continues;
2. switch OPC/iveKit and all LiveKit components back to the frozen Redis endpoint;
3. roll or reload clients so no process retains the Valkey Sentinel seed list;
4. verify direct-mode health, user-visible replay and media continuity;
5. preserve Valkey volumes and logs for diagnosis; do not copy ephemeral keys back;
6. reopen admission only after the old path is healthy.

Because PostgreSQL and originating events remain authoritative, caches can be
rebuilt. Pub/Sub is at-most-once and must not be treated as a replay log.

## 9. Monitoring and Alerts

Monitor by Cell and node:

- primary role, replica count, replica link state and replication offset/lag;
- Sentinel peer count, quorum result, subjective/objective down and failover state;
- client connect/reconnect failures, command errors and pool saturation;
- command P50/P95/P99 latency, slow log, blocked clients and event-loop stalls;
- memory fragmentation, maxmemory, evictions, persistence errors and disk latency;
- failover duration, post-failover write success and cache rebuild duration;
- application Pub/Sub reconnects and PostgreSQL-backed replay recovery.

Alert before quorum is lost. A single remaining Sentinel voter is not HA even if
the current primary still accepts traffic.

## 10. Failure Drills

Run bounded drills for primary process freeze, node loss, one Sentinel loss,
minority partition, Zone loss, certificate rotation, credential rotation, disk
pressure and replica lag. Require topology convergence before injecting failure.

Do not use removal of an ephemeral DNS identity as the only primary-failure test:
it can test DNS behavior instead of Sentinel election. Validate DNS loss as a
separate scenario after stable production identities are in place.

## 11. Explicitly Not Proven

The following remain `not_run`:

- target Kubernetes deployment and rollback: `not_run`;
- cross-Zone partition and full Zone loss: `not_run`;
- LiveKit real-room, Egress, Ingress and SIP continuity under failover: `not_run`;
- long soak, backup restore and certificate/credential rotation;
- throughput, single-node frontier, Cell-10K and MIX-100K capacity.

No production availability or capacity claim may cite the controlled single-host
run as a substitute for these gates.
