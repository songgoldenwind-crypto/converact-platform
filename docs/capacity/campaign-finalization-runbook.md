# Converact Fabric Capacity Campaign Finalization Runbook

> Status: code complete; physical execution `not_run`
> Contract: `targets/mix-100k-efficiency-v1.json`
> Workload: `profiles/mix-100k-v1.json`

## 1. Purpose

This runbook turns immutable load-run evidence into three progressively stronger results:

1. A run result proves one exact load point.
2. A scaling campaign proves one component, Cell, or shared-data 1/2/4/8(/10) curve.
3. A platform campaign proves all required curves plus the 100,000-interaction endpoint.

No submission may contain caller-authored measurements. Finalizers reload terminal PostgreSQL rows
and bounded S3 evidence objects, verify canonical SHA-256 identities, and derive every result from
those sources. Controlled evidence exercises the verifier but always returns
`capacity_claim=none`.

## 2. Required Schema

Apply these forward-only migrations in order:

```text
077  capacity run/phase/shard/evidence authority
082  durable generator result checkpoints
091  scaling campaigns and immutable run references
092  platform campaigns, scaling references and endpoint run reference
```

The finalizer identities need `SELECT/INSERT/UPDATE/DELETE` on these capacity tables and S3 access
limited to the configured evidence prefix. They do not need Converact Platform or LED business-domain tables.

## 3. Immutable Run Context

Every curve-point manifest must include `profile_load` and `capacity_context`:

```json
{
  "profile_load": {
    "base_interactions": 100000,
    "target_interactions": 10000,
    "scale_numerator": 10000,
    "scale_denominator": 100000,
    "apportionment": "largest_remainder_v1"
  },
  "capacity_context": {
    "scope": "component",
    "component_role": "tinode_im",
    "units": 1,
    "hardware_class": "c32-64g-25gbe",
    "hardware_sha256": "<canonical-hardware-sha256>",
    "configuration_class": "tinode-v1",
    "configuration_sha256": "<canonical-configuration-sha256>",
    "failure_reserve_sha256": "<canonical-failure-reserve-sha256>"
  }
}
```

`component_role` is mandatory for `scope=component` and forbidden for `cell` or `shared_data`.
The profile compiler applies the complete MIX workload ratio with deterministic largest-remainder
apportionment; a component campaign does not silently replace the profile with one protocol.

## 4. Finalize Every Load Run

For each frontier probe, the run finalizer requires one evidence record per
`phase_id/shard_id`, generator qualification, SUT observation, and an independent observation.
The stored run evidence object embeds the immutable manifest. A run can be:

- `passed`: every SLO and production dependency gate passed;
- `failed`: the SUT or an SLO failed;
- `invalid_generator_capacity`: the generator was not qualified;
- `not_run`: a required real dependency or lane was unavailable.

Only a database record with verified `run_evidence_manifest` SHA can enter a scaling submission.

## 5. Finalize Role And Cell Curves

Create one scaling submission for each required component role:

```text
sip_edge
rustpbx_voice
livekit_sfu_turn
livekit_egress
tinode_im
ivekit_realtime_edge
rustdesk_rendezvous_relay
recording_evidence_worker
shared_data_service
```

Then create one `cell-addition-to-100k` campaign and one
`shared-data-plane-per-cell-load` campaign. A scaling submission binds:

- contract ID and canonical contract SHA-256;
- curve ID and controlled/production mode;
- exact profile, hardware, configuration, failure reserve, fork, SUT, and generator identity;
- one bound for every contract unit point;
- the complete ordered ramp/binary-search/final-repeat run reference history.

Each run reference contains only `run_id`, manifest/evidence hashes, unit, attempt, phase,
requested profile-equivalent load, and dominant resource. The finalizer reconstructs the frontier
and rejects a missing, reordered, invented, duplicated, or unused probe.

Run the CLI directly or use `kubernetes/scaling-finalizer-job.yaml`:

```bash
CONVERACT_DATABASE_URL='postgresql://...' \
CONVERACT_FABRIC_CAPACITY_SCALING_FINALIZER_ID='scaling-finalizer-role-run' \
CONVERACT_FABRIC_CAPACITY_SCALING_CONTRACT_PATH='/run/converact-capacity/scaling-contract.json' \
CONVERACT_FABRIC_CAPACITY_SCALING_SUBMISSION_PATH='/run/converact-capacity/scaling-submission.json' \
CONVERACT_FABRIC_CAPACITY_SCALING_EVIDENCE_PREFIX='capacity/scaling' \
CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET='capacity-evidence' \
CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION='ap-southeast-1' \
  npm run converact:capacity:scaling-finalizer
```

The result includes full frontier inputs, derived safe capacities, aggregate linearity, segment
marginal efficiency, reasons, and a `component_pass` or `cell_pass` claim only for production pass.

## 6. Finalize The Platform Gate

The platform submission contains exactly eleven scaling references: nine component roles, one
Cell curve, and one shared-data curve. Each reference binds `campaign_id`, `submission_sha256`, and
the finalized evidence SHA-256. It also contains one endpoint run reference:

```json
{
  "schema_version": "1.0.0",
  "platform_campaign_id": "mix-100k-production-20260717-001",
  "contract_id": "mix-100k-efficiency-v1",
  "contract_sha256": "<canonical-contract-sha256>",
  "mode": "production",
  "profile_id": "mix-100k-v1",
  "profile_sha256": "<canonical-profile-sha256>",
  "scaling_campaigns": [
    {
      "campaign_id": "curve-sip-edge-20260717-001",
      "submission_sha256": "<scaling-submission-sha256>",
      "evidence_sha256": "<scaling-evidence-sha256>"
    }
  ],
  "endpoint_run": {
    "run_id": "mix-100k-endpoint-20260717-001",
    "manifest_sha256": "<endpoint-manifest-sha256>",
    "evidence_manifest_sha256": "<endpoint-evidence-sha256>"
  }
}
```

The abbreviated array above documents one item; the submitted production document must contain all
eleven unique references or validation fails before any claim is considered.

Run the CLI directly or use `kubernetes/platform-finalizer-job.yaml`:

```bash
CONVERACT_DATABASE_URL='postgresql://...' \
CONVERACT_FABRIC_CAPACITY_PLATFORM_FINALIZER_ID='platform-finalizer-run' \
CONVERACT_FABRIC_CAPACITY_PLATFORM_CONTRACT_PATH='/run/converact-capacity/platform-contract.json' \
CONVERACT_FABRIC_CAPACITY_PLATFORM_SUBMISSION_PATH='/run/converact-capacity/platform-submission.json' \
CONVERACT_FABRIC_CAPACITY_PLATFORM_EVIDENCE_PREFIX='capacity/platform' \
CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET='capacity-evidence' \
CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION='ap-southeast-1' \
  npm run converact:capacity:platform-finalizer
```

The platform finalizer:

1. Reloads every terminal scaling record and S3 object.
2. Verifies source submission and evidence hashes.
3. Recomputes every curve from frontier repeat values and contract gates.
4. Requires each component role exactly once.
5. Requires the Cell and shared-data curves.
6. Reloads the verified endpoint run and requires exactly 100,000 profile-equivalent interactions.
7. Requires the endpoint Cell unit count and hardware/config/failure reserve to match the Cell curve.
8. Requires exact generator/SUT/fork/profile identity across all sources.
9. Requires exact generator/SUT/independent three-plane reconciliation for a passed endpoint.

Only a production result with every gate passed receives `capacity_claim=platform_pass`. A passed
endpoint cannot override a failed curve. Any required physical lane that remains unavailable keeps
the relevant run, curve, and platform result at `not_run` with no capacity claim.

## 7. Release Evidence

Archive together:

- contract and profile bytes plus canonical SHA-256;
- hardware, configuration, failure-reserve, fork, SUT, and generator identities;
- all run manifests and run evidence objects;
- all scaling submissions and finalized curve objects;
- platform submission and finalized platform object;
- immutable image digests, SBOM/provenance, Kubernetes topology, and operator timestamps.

Do not edit an existing submission or evidence object. A correction creates a new run/campaign ID.
The PostgreSQL lease epoch fences stale finalizers, while content hashes make a completed result
idempotent and independently auditable.
