# iveKit OpenTelemetry Collector Gateway

This profile owns trace transport only. Prometheus remains the metrics authority,
and application logs remain on the existing log path. The Collector is never a
call, media, IM, or remote-control dependency.

## Prerequisites

1. Create Secret `ivekit-otel-backend` with key `endpoint`. The value is the
   external OTLP/HTTP base endpoint consumed by the Collector exporter; do not
   put credentials in this repository.
2. Apply the profile in the same namespace as the iveKit workloads, or narrow
   the NetworkPolicy selectors for a dedicated observability namespace.
3. Point the Chart at
   `http://ivekit-otel-collector:4318/v1/traces` and enable telemetry only in
   the explicit observability profile.

```bash
kubectl apply -k infra/platform/observability/otel-collector
```

The fixed `0.153.0` image digest was resolved on the controlled validation
server. Registry signature verification and target-cluster admission remain
release gates.

## Failure behavior

The Node SDK uses a bounded batch queue and short export timeout. A full queue
drops spans. The Collector exporter also has a bounded queue and a 30-second
retry horizon. Neither layer retries indefinitely or back-pressures a business
request. Collector/backend outage must alert through Collector self-metrics but
must not change iveKit readiness or terminate active communication.

## Remaining target-environment gates

- Apply/rollout on the target Kubernetes version.
- Dual-Zone scheduling and one-Pod/node-loss exercise.
- Backend authentication and TLS policy.
- Collector outage during real voice, video, IM, and remote-control sessions.
- Trace volume, sampling, cardinality, queue-drop, CPU, and memory budget.
