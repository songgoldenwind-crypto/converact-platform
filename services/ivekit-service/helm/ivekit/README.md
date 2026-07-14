# iveKit Standalone Helm Chart

This Chart deploys the standalone iveKit API and optional RustPBX workload. PostgreSQL and communication providers are external dependencies so the same application image can be embedded in OPC, LED, or another product without importing the OPC monolith.

Both `image.repository` and `image.digest` are required. The migration hook runs `ivekit-init-runtime-role` and the advisory-locked forward migration before each install or upgrade. The application Deployment is not changed when that hook fails.

Create `secrets.existingSecret` outside Helm. It contains only the configured admin database URL, runtime database URL, runtime database password, and optional RustPBX bootstrap keys; the API reads only the runtime URL from it. Put API/provider runtime variables in a separate Secret and set `secrets.runtimeEnvironmentSecret` when needed. This prevents the long-running API from importing the admin DSN through `envFrom`. Keep non-secret worker settings under `config.env`.

Voice is disabled by default. Enabling it additionally requires an immutable RustPBX digest, a profile ID, and the configured RustPBX database URL/password, RWI token, and webhook token keys in the existing Secret. The RustPBX database and role must be provisioned before deployment. SIP and RTP exposure must be adapted to the target cluster load balancer and firewall.

Application rollback may select an earlier immutable image only when it is compatible with the expanded schema. There are no automatic down migrations; database recovery uses a verified pre-upgrade backup.
