# LiveKit production Helm profile

This directory vendors the official `livekit/livekit-helm` server chart at the
exact commit recorded in `upstream-lock.json`. The Converact Fabric delta is intentionally
small:

- the chart and app versions identify the Converact Fabric fork;
- Redis password and TLS material are mounted from existing Secrets;
- zone spreading and a PodDisruptionBudget are available;
- the production profile pins the Converact Fabric LiveKit image by digest and applies
  the validated 100 ms PLI policy.

The application chart under `infra/k8s` continues to treat bundled LiveKit as
development-only. This chart is the production media-plane deployment.

## Required preparation

Create these Secrets through the cluster's secret manager. Do not put their
contents in a values file:

| Secret | Required keys |
| --- | --- |
| `livekit-api-keys` | `keys.yaml` |
| `livekit-valkey-auth` | `redis-password` |
| `livekit-valkey-tls` | `ca.crt`, `tls.crt`, `tls.key` |
| `livekit-turn-tls` | `tls.crt`, `tls.key` |

Resolve these environment-specific values before deployment:

1. replace `REPLACE_WITH_64_HEX_DIGEST` with the released Converact Fabric LiveKit image
   manifest digest;
2. replace `turn.media.example.com` with the TURN certificate domain;
3. set the Valkey address and TLS server name;
4. match the media node label and taint to the cluster;
5. configure the signal and TURN LoadBalancer annotations for the cloud.

The default node pool contract is eight requested CPUs and 8 GiB requested
memory per pod. There is no CPU limit: CFS throttling is not allowed on the RTC
media hot path. Host networking and host ports mean one LiveKit pod per node.
The HPA floor is two nodes across two zones and the profile can expand to 32
nodes; admission control must still reserve capacity before HPA saturation.

## Validation and rendering

Write the resolved profile outside the repository, then run:

```bash
npm run livekit:helm-profile:validate -- \
  --values /secure/runtime/livekit-values.yaml

helm lint infra/livekit/helm/livekit-server \
  -f /secure/runtime/livekit-values.yaml

helm template converact-livekit infra/livekit/helm/livekit-server \
  --namespace media \
  -f /secure/runtime/livekit-values.yaml
```

Install only the rendered and reviewed profile:

```bash
helm upgrade --install converact-livekit infra/livekit/helm/livekit-server \
  --namespace media \
  --create-namespace \
  -f /secure/runtime/livekit-values.yaml \
  --atomic \
  --wait \
  --timeout 15m
```

The validator fails closed on unresolved image digests, credentials under
`livekit`, missing Secret references, disabled Redis TLS, narrow RTC port
ranges, CPU limits, single-replica autoscaling, missing PDBs, or missing
zone/host spreading.

## Upstream updates

For an upstream chart update:

1. verify the new Git commit and the four upstream SHA-256 values;
2. replace the vendored chart from that exact commit;
3. reapply only the Secret, topology and PDB delta;
4. increment the `-converact.N` chart version;
5. run the focused test, validator, `helm lint` and `helm template`;
6. rerun browser QoE, native SFU capacity and multi-node failure campaigns.

The current result is a server-rendered deployment contract. It is not a
Kubernetes runtime, multi-node scaling, or production capacity claim.
