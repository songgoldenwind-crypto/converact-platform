# Wave 1 HOMER retention and compaction server validation

> Beijing report date: 2026-07-25
> Campaign UTC completion: 2026-07-24T18:09:12Z
> Result: `controlled_pass`
> Capacity claim: `none`

## 1. Decision

The isolated server campaign closes the controlled HOMER retention,
expiration, compaction and idempotency gate for the PostgreSQL-backed DuckLake
fork.

- The fixture ingested 200 HEPv3 packets timestamped 40 days in the past and
  200 current packets.
- A forced maintenance run with a 30-day retention policy removed all 200 old
  rows and preserved all 200 current rows.
- A second identical maintenance run preserved the same result, proving that
  the operation is idempotent for this fixture.
- Snapshot count changed from 30 to 1 and remained 1. Catalog data and Parquet
  file counts changed from 2 to 1 and remained 1.
- The isolated containers, network, volume, data directory and generated
  credential files were removed after evidence capture.

This is functional maintenance evidence on a shared four-vCPU server. It is
not a production retention throughput, storage capacity or long-soak claim.

## 2. Defect found and fixed

The first exploratory run exposed a fork defect: the HOMER maintenance CLI did
not propagate DuckLake tuning fields from modular configuration. Its fallback
spill-directory logic then treated a PostgreSQL catalog DSN as a filesystem
path and included that path in a warning.

That exploratory output was rejected and deleted. No artifact from that run is
part of this evidence.

The `11.0.297-ivekit.2` overlay fixes both causes:

1. `duckLakeConfigFromModular` propagates thread count, memory limit and the
   configured temporary directory into the maintenance command.
2. `DefaultSpillDirectory` rejects PostgreSQL URI and libpq DSN forms instead
   of deriving a local path from catalog credentials.
3. The maintenance harness redacts generated secrets before artifact hashing,
   scans the resulting artifacts and fails if a credential pattern remains.

The fixed image was rebuilt from exact upstream commit
`ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b`. DuckLake and CLI Go tests passed
inside the immutable build, and the final image runs as `10001:10001`.

## 3. Fixed inputs

| Input | Value |
| --- | --- |
| Server | `64.225.122.227`, shared four-vCPU Linux boot domain |
| HOMER image | `ivekit/homer:11.0.297-ivekit.2-ac4e1ae7` |
| HOMER image ID | `sha256:d062461067849bbec3d4b84473f309d7e3b216bb29284d4124fc9960f361e389` |
| HOMER upstream | `11.0.297@ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b` |
| PostgreSQL image | `postgres:16.10-alpine3.22` |
| PostgreSQL image ID | `sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297` |
| Retention | 30 days |
| Old timestamp | current time minus 3,456,000 seconds |
| Expiration threshold | 1 second |
| Old / current packets | 200 / 200 |
| Runner SHA-256 | `6861111c159784bf489197f2364cac874a5961fc329034bf7ac7e371d1fc4fd8` |
| HEP sender SHA-256 | `f8c3dbb0d736e3438b11a43492bb4f084feea1f1deb8078db7e096807fe2154c` |
| Overlay SHA-256 | `4110dee014b20b96d7680fbfbfaf5d48f0ec7de933af8454dfe3ee52eeb4b66e` |
| Build script SHA-256 | `4798b40251514d1e45c30533502836396dcfd054644f58aa87266ff9d0c9ffa3` |
| Fork Go test SHA-256 | `cc4d87dfa8c3ea2db7c5f2cd1d6fa16efc4d99aa5a3ede6f4546a9d3488c8e50` |

The campaign used a dedicated Docker network, PostgreSQL instance, HOMER
instance and data volume. It did not connect to or restart the running
LiveKit, RustPBX, Kamailio or HOMER baseline containers.

## 4. Results

### Row retention

| Measurement | Before | After first run | After idempotent run |
| --- | ---: | ---: | ---: |
| Old rows | 200 | 0 | 0 |
| Current rows | 200 | 200 | 200 |

### Physical maintenance

| Measurement | Before | After first run | After idempotent run |
| --- | ---: | ---: | ---: |
| DuckLake snapshots | 30 | 1 | 1 |
| Catalog data files | 2 | 1 | 1 |
| Parquet files | 2 | 1 | 1 |

Both maintenance commands reported completion. The sanitized logs contain no
PostgreSQL URI, no invalid spill-directory warning and no error or warning
record.

## 5. Security and cleanup

The harness generates random PostgreSQL, node and JWT credentials for the
isolated run. Before hashing artifacts it:

- removes the generated environment files;
- replaces exact generated values with a redaction marker;
- rejects PostgreSQL URI or libpq password patterns in retained artifacts;
- records a `secret-scan.txt` pass marker;
- removes all test containers, the network, volume and host data directory.

The final machine evidence reports:

| Check | Result |
| --- | --- |
| Sensitive input files removed | pass |
| Artifact secret scan | pass |
| Remaining isolated resources | 0 |
| Container restart / OOM dependency | none |

## 6. Evidence

| Artifact | SHA-256 |
| --- | --- |
| `wave1-homer-retention-compaction-server-validation-2026-07-25.json` | `ff7bbe7e8c965b494504ce6884bc28dfccc5845655cba1c5ba424e8929dc6da5` |

The sanitized server artifacts remain at:

```text
/opt/opc-wave123-validation-20260722/runtime/
  homer-maintenance-20260725/
```

## 7. Remaining gates

This campaign does not close:

- retention and compaction throughput at production data volume;
- long soak, concurrent query/write/maintenance behavior and disk-pressure
  recovery;
- PostgreSQL HA failover during writer and maintenance activity;
- HEP high-water shedding, deliberate packet loss and live trace transition;
- target Kubernetes, persistent storage, dual Zone and node-loss behavior;
- independent generator/SUT hosts, Cell-10K and MIX-100K capacity;
- multi-architecture Registry publication, SBOM, vulnerability policy,
  signature and provenance.
