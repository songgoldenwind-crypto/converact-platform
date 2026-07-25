# iveKit VictoriaMetrics single-node profile

This profile adds Prometheus-compatible long-term metrics storage without
changing the metrics authority. Prometheus still owns discovery, scraping,
recording rules, alert evaluation, and its local WAL. VictoriaMetrics receives
remote-write data and serves long-range PromQL/MetricsQL queries. It is never a
SIP, RTP, LiveKit, Tinode, RustDesk, API-readiness, or worker-lease dependency.

## Apply prerequisites

1. Choose a `StorageClass` for `ivekit-victoria-metrics-data` and size it from
   measured ingest, retention, and restore-time requirements. The checked-in
   request is 200 GiB with 30-day retention, not a MIX-100K capacity claim.
2. Label same-namespace Prometheus/Grafana Pods with
   `opc.ivekit.io/victoria-metrics-role=writer` or `reader`. For clients in
   another namespace, also label that namespace
   `opc.ivekit.io/victoria-metrics-access=true`.
3. Merge `prometheus-remote-write.example.yaml` into the authoritative
   Prometheus configuration. Do not deploy a second scraper or vmagent for the
   same targets.
4. Apply the base profile:

```bash
kubectl apply -k infra/platform/observability/victoria-metrics
```

The `v1.148.0` images are pinned to digests resolved on the controlled
validation server. Target-cluster signature policy, registry admission, and
platform-specific storage validation remain release gates.

## Backup

The backup CronJob is fail-closed with `suspend: true`. Create Secret
`ivekit-victoria-metrics-backup` before enabling it. Required keys are
`destination`, `accessKeyId`, and `secretAccessKey`; optional keys are
`endpoint`, `region`, and `sessionToken`. `destination` uses `s3://bucket/path`
or another vmbackup-supported URL. For a restore, add `restoreSource`.

After a manual backup and restore drill succeeds against the production object
store, set `spec.suspend=false`. The job reads the live PVC read-only and asks
VictoriaMetrics to create an immutable snapshot. It has bounded CPU, memory,
bandwidth, concurrency, duration, and retry counts.

## Restore

`restore-job.example.yaml` is deliberately excluded from Kustomize and starts
suspended. Restore into a new empty PVC whenever possible. If reusing the
existing PVC, first scale the StatefulSet to zero, verify the volume is not
mounted by any other Pod, empty only the approved target data directory, apply
the Job, set `suspend=false`, verify queries, and then scale VictoriaMetrics
back to one. Never run vmrestore against a live data directory.

## Failure behavior and scaling

During a VictoriaMetrics outage, Prometheus keeps scraping and buffers remote
write in its local WAL. WAL exhaustion may lose historical metrics but must not
block communication. Alert on pending/failed remote-write samples and disk
pressure using `prometheus-rules.example.yaml` after reviewing labels for the
target Prometheus installation.

Single-node remains the default because it minimizes server count and has a
smaller operational surface. Upgrade to two independent single nodes for
cross-Zone metrics HA, or to VictoriaMetrics cluster for storage/query scale,
only after ingest rate, active series, query P99, disk growth, or restore time
exceeds a measured budget. Single-node backups cannot be restored into the
cluster format directly.

## Remaining production gates

- Target Kubernetes API and NetworkPolicy enforcement.
- StorageClass IOPS, filesystem, expansion, snapshot, and node-loss behavior.
- Real Prometheus WAL duration and disk budget during a prolonged outage.
- Production S3 TLS, credentials, retention, immutability, backup, and restore.
- Dual-Zone query/ingest behavior and long-running capacity/cost benchmark.
