#!/usr/bin/env bash
set -euo pipefail
umask 077

campaign_id='converact-g03-pg-restart-a18229cd-02'
source_commit='a18229cde752e2fbd4a3ffa3b8d8a8cc7cef7beb'
source_archive='/tmp/converact-g03-a18229cd-source-run04.tar.xz'
source_archive_sha256='88d23273225b472ec3fc7775af43ea301c5c82c6b350122a3173d39da2e1511c'
source_tree_sha256='e29e5898768938779ff723c4acc0d68e1463510f301ea808f56054bde76c17e5'
probe_source_sha256='5300dc08d72403c534f0a032f2c943f125966bcb9cd6a402e9278bf7ddcf1137'
run_id='g03-restart-a18229cd-02'
database_name='converact_g03_g03_restart_a18229cd_02'
confirmation_sha256='63a8b0b26b532c8d582f45f53f6ef317ca364e10ca83154a3bb69e5ea1e29d4f'
node_image='node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'
postgres_image='postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb'
network_name="${campaign_id}-network"
volume_name="${campaign_id}-pgdata"
database_container="${campaign_id}-db"
result_archive="/tmp/${campaign_id}-results.tar.xz"
campaign_root="$(mktemp -d "/tmp/${campaign_id}.XXXXXX")"
results="${campaign_root}/results"
source_root="${campaign_root}/source"
resources_cleaned=0
archive_written=0

mkdir -p "${results}"

cleanup_resources() {
  if [[ "${resources_cleaned}" == '1' ]]; then
    return
  fi
  mapfile -t campaign_containers < <(
    docker ps -aq --filter "label=converact.campaign=${campaign_id}"
  )
  for container_id in "${campaign_containers[@]}"; do
    if [[ -n "${container_id}" ]]; then
      docker rm -f -- "${container_id}" >/dev/null 2>&1 || true
    fi
  done
  docker network rm -- "${network_name}" >/dev/null 2>&1 || true
  docker volume rm -- "${volume_name}" >/dev/null 2>&1 || true
  resources_cleaned=1
}

write_archive() {
  if [[ "${archive_written}" == '1' || ! -d "${results}" ]]; then
    return
  fi
  (
    cd "${results}"
    find . -type f ! -name raw-output.sha256 -print0 |
      sort -z |
      xargs -0 sha256sum > raw-output.sha256
  )
  tar -C "${campaign_root}" -cJf "${result_archive}" results
  archive_written=1
}

finish() {
  rc=$?
  set +e
  cleanup_resources
  if [[ "${rc}" != '0' ]]; then
    printf '%s\n' "${rc}" > "${results}/campaign-exit-code.txt"
  fi
  write_archive
  case "${campaign_root}" in
    /tmp/converact-g03-pg-restart-a18229cd-02.*)
      rm -rf -- "${campaign_root}"
      ;;
  esac
  exit "${rc}"
}
trap finish EXIT

if [[ "$(docker ps -q | wc -l | tr -d ' ')" != '0' ]]; then
  printf '%s\n' 'preexisting_running_containers_detected' > "${results}/preflight-error.txt"
  exit 20
fi

mapfile -t preexisting_ids < <(docker ps -aq | sort)
if [[ "${#preexisting_ids[@]}" != '9' ]]; then
  printf '%s\n' "unexpected_preexisting_container_count:${#preexisting_ids[@]}" \
    > "${results}/preflight-error.txt"
  exit 21
fi
printf '%s\n' "${preexisting_ids[@]}" > "${results}/preexisting-container-ids-before.txt"
docker inspect "${preexisting_ids[@]}" > "${results}/preexisting-containers-before.json"
jq -S \
  'map(.Mounts |= sort_by(.Destination, .Source) |
       .HostConfig.Binds = ((.HostConfig.Binds // []) | sort))' \
  "${results}/preexisting-containers-before.json" \
  > "${results}/preexisting-containers-before.normalized.json"

if docker ps -aq --filter "label=converact.campaign=${campaign_id}" | grep -q .; then
  printf '%s\n' 'campaign_container_already_exists' > "${results}/preflight-error.txt"
  exit 22
fi
if docker network inspect "${network_name}" >/dev/null 2>&1; then
  printf '%s\n' 'campaign_network_already_exists' > "${results}/preflight-error.txt"
  exit 23
fi
if docker volume inspect "${volume_name}" >/dev/null 2>&1; then
  printf '%s\n' 'campaign_volume_already_exists' > "${results}/preflight-error.txt"
  exit 24
fi

actual_archive_sha256="$(sha256sum "${source_archive}" | awk '{print $1}')"
if [[ "${actual_archive_sha256}" != "${source_archive_sha256}" ]]; then
  printf '%s\n' 'source_archive_sha256_mismatch' > "${results}/preflight-error.txt"
  exit 25
fi
cp /tmp/converact-g03-a18229cd-source-run04.tree.txt "${results}/source-tree.txt"
if [[ "$(sha256sum "${results}/source-tree.txt" | awk '{print $1}')" != \
      "${source_tree_sha256}" ]]; then
  printf '%s\n' 'source_tree_sha256_mismatch' > "${results}/preflight-error.txt"
  exit 26
fi
tar -C "${campaign_root}" -xJf "${source_archive}"
if [[ "$(sha256sum "${source_root}/services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts" | awk '{print $1}')" != \
      "${probe_source_sha256}" ]]; then
  printf '%s\n' 'probe_source_sha256_mismatch' > "${results}/preflight-error.txt"
  exit 27
fi
printf '%s  %s\n' "${source_archive_sha256}" \
  'converact-g03-a18229cd-source-run04.tar.xz' > "${results}/source-archive.sha256"
printf '%s  %s\n' "${probe_source_sha256}" \
  'postgres-effect-restart-probe.ts' > "${results}/probe-source.sha256"

host_uid="$(id -u)"
host_gid="$(id -g)"
docker run --rm \
  --label "converact.campaign=${campaign_id}" \
  --user "${host_uid}:${host_gid}" \
  --volume "${source_root}:/workspace" \
  --workdir /workspace \
  --env HOME=/tmp \
  --env npm_config_cache=/tmp/npm-cache \
  "${node_image}" \
  npm ci --ignore-scripts --no-audit --no-fund \
  > "${results}/npm-ci.log" 2>&1

admin_password="$(openssl rand -hex 32)"
runtime_password="$(openssl rand -hex 32)"

docker network create \
  --label "converact.campaign=${campaign_id}" \
  "${network_name}" > "${results}/network-create.log"
docker volume create \
  --label "converact.campaign=${campaign_id}" \
  "${volume_name}" > "${results}/volume-create.log"
docker run -d \
  --name "${database_container}" \
  --label "converact.campaign=${campaign_id}" \
  --network "${network_name}" \
  --volume "${volume_name}:/var/lib/postgresql/data" \
  --env "POSTGRES_USER=opc_admin" \
  --env "POSTGRES_PASSWORD=${admin_password}" \
  --env "POSTGRES_DB=${database_name}" \
  "${postgres_image}" > "${results}/postgres-container-id.txt"

wait_for_postgres() {
  for attempt in $(seq 1 40); do
    if docker exec "${database_container}" \
      pg_isready -U opc_admin -d "${database_name}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_postgres
docker inspect -f '{{.State.StartedAt}}' "${database_container}" \
  > "${results}/postgres-container-start-before.txt"
docker inspect -f '{{.Id}}' "${database_container}" \
  > "${results}/postgres-container-before.txt"

run_node() {
  phase_name="$1"
  output_name="$2"
  shift 2
  docker run --rm \
    --cidfile "${results}/${phase_name}-node-container-id.txt" \
    --label "converact.campaign=${campaign_id}" \
    --network "${network_name}" \
    --user "${host_uid}:${host_gid}" \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=134217728 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --env "PGHOST=${database_container}" \
    --env PGPORT=5432 \
    --env "PGDATABASE=${database_name}" \
    --env PGUSER=opc_admin \
    --env "PGPASSWORD=${admin_password}" \
    --env "CONVERACT_RUNTIME_DB_PASSWORD=${runtime_password}" \
    --env "CONVERACT_G03_RESTART_RUN_ID=${run_id}" \
    --env "CONVERACT_G03_SOURCE_COMMIT=${source_commit}" \
    --env "CONVERACT_G03_RESTART_CONFIRMATION_SHA256=${confirmation_sha256}" \
    --env CONVERACT_G03_PREPARE_EVIDENCE=/results/prepare.json \
    --env CONVERACT_G03_RECOVER_EVIDENCE=/results/recover.json \
    --env "CONVERACT_FABRIC_STANDALONE_TEST_DATABASE_URL=postgresql://opc_admin:${admin_password}@${database_container}:5432/${database_name}" \
    --env "CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_DATABASE_URL=postgresql://opc_runtime:${runtime_password}@${database_container}:5432/${database_name}" \
    --env "CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_PASSWORD=${runtime_password}" \
    --env "CONVERACT_G03_RESTART_OUTPUT=/results/${output_name}" \
    --env HOME=/tmp \
    --volume "${source_root}:/workspace:ro" \
    --volume "${results}:/results" \
    --workdir /workspace \
    "${node_image}" "$@"
}

run_node migrations migrations-unused.json \
  node --import tsx scripts/run-postgres-migrations.ts \
  > "${results}/migrations.log" 2>&1

run_node physical-boundary physical-boundary-unused.json \
  node --import tsx --test --test-concurrency=1 \
  test/converact-sip-effect-postgres.test.ts \
  > "${results}/physical-boundary.log" 2>&1

run_node prepare prepare.json \
  node --import tsx \
  services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts \
  prepare > "${results}/prepare-probe.log" 2>&1

docker stop --time 20 "${database_container}" > "${results}/postgres-stop.log"
set +e
docker run --rm \
  --label "converact.campaign=${campaign_id}" \
  --network "${network_name}" \
  --env "PGHOST=${database_container}" \
  --env PGPORT=5432 \
  --env "PGDATABASE=${database_name}" \
  --env PGUSER=opc_admin \
  --env "PGPASSWORD=${admin_password}" \
  "${postgres_image}" \
  psql -v ON_ERROR_STOP=1 -c 'SELECT 1' \
  > "${results}/outage-query.log" 2>&1
outage_rc=$?
set -e
printf '%s\n' "${outage_rc}" > "${results}/outage-query-exit-code.txt"
if [[ "${outage_rc}" == '0' ]]; then
  printf '%s\n' 'outage_query_unexpectedly_succeeded' > "${results}/campaign-error.txt"
  exit 41
fi

docker start "${database_container}" > "${results}/postgres-start.log"
wait_for_postgres
docker inspect -f '{{.State.StartedAt}}' "${database_container}" \
  > "${results}/postgres-container-start-after.txt"
docker inspect -f '{{.Id}}' "${database_container}" \
  > "${results}/postgres-container-after.txt"
cmp "${results}/postgres-container-before.txt" \
  "${results}/postgres-container-after.txt"

run_node recover recover.json \
  node --import tsx \
  services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts \
  recover > "${results}/recover-probe.log" 2>&1

run_node verify verify.json \
  node --import tsx \
  services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts \
  verify > "${results}/verify-probe.log" 2>&1

run_node cleanup cleanup.json \
  node --import tsx \
  services/converact-service/acceptance/g03-sip-foundation/postgres-effect-restart-probe.ts \
  cleanup > "${results}/cleanup-probe.log" 2>&1

docker exec \
  --env "PGPASSWORD=${admin_password}" \
  "${database_container}" \
  psql -U opc_admin -d "${database_name}" -At -v ON_ERROR_STOP=1 \
  -c "SELECT
        (SELECT COUNT(*) FROM tenants WHERE id = '${run_id}'),
        (SELECT COUNT(*) FROM ivekit_sip_protocol_effects WHERE tenant_id = '${run_id}'),
        (SELECT COUNT(*) FROM ivekit_sip_effect_receipts WHERE tenant_id = '${run_id}'),
        (SELECT enabled::text || ':' || COALESCE(activation_receipt_id, 'null')
         FROM ivekit_sip_effect_writer_registry
         WHERE writer_identity = 'unified-rustpbx.sip-foundation'),
        (SELECT enabled::text || ':' || COALESCE(activation_receipt_id, 'null')
         FROM ivekit_sip_effect_schema_registry
         WHERE schema_id = 'ivekit.sip-effect-oracle' AND schema_version = 1);" \
  > "${results}/post-cleanup-state.txt"

if grep -R -q -F -- "${admin_password}" "${results}" ||
   grep -R -q -F -- "${runtime_password}" "${results}"; then
  printf '%s\n' 'failed' > "${results}/secret-scan-status.txt"
  exit 42
fi
printf '%s\n' 'passed' > "${results}/secret-scan-status.txt"
unset admin_password runtime_password

node_version="$(docker run --rm "${node_image}" node --version)"
kernel="$(uname -srm)"
cpu_count="$(getconf _NPROCESSORS_ONLN)"
memory_kib="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
host_name="$(hostname)"
printf '%s\n' \
  "{\"campaign_id\":\"${campaign_id}\",\"source_commit\":\"${source_commit}\",\"source_archive_sha256\":\"${source_archive_sha256}\",\"source_tree_sha256\":\"${source_tree_sha256}\",\"probe_source_sha256\":\"${probe_source_sha256}\",\"node_version\":\"${node_version}\",\"node_image\":\"${node_image}\",\"postgres_image\":\"${postgres_image}\",\"host\":\"${host_name}\",\"kernel\":\"${kernel}\",\"cpu_count\":${cpu_count},\"memory_kib\":${memory_kib},\"production_eligible\":false}" \
  > "${results}/execution-identity.json"

cleanup_resources
mapfile -t final_ids < <(docker ps -aq | sort)
printf '%s\n' "${final_ids[@]}" > "${results}/preexisting-container-ids-after.txt"
if [[ "${#final_ids[@]}" != '9' ]]; then
  printf '%s\n' "unexpected_final_container_count:${#final_ids[@]}" \
    > "${results}/campaign-error.txt"
  exit 43
fi
docker inspect "${final_ids[@]}" > "${results}/preexisting-containers-after.json"
jq -S \
  'map(.Mounts |= sort_by(.Destination, .Source) |
       .HostConfig.Binds = ((.HostConfig.Binds // []) | sort))' \
  "${results}/preexisting-containers-after.json" \
  > "${results}/preexisting-containers-after.normalized.json"
cmp "${results}/preexisting-container-ids-before.txt" \
  "${results}/preexisting-container-ids-after.txt"
cmp "${results}/preexisting-containers-before.normalized.json" \
  "${results}/preexisting-containers-after.normalized.json"
if [[ "$(docker ps -q | wc -l | tr -d ' ')" != '0' ]]; then
  printf '%s\n' 'final_running_containers_nonzero' > "${results}/campaign-error.txt"
  exit 44
fi
printf '%s\n' 'passed' > "${results}/campaign-status.txt"
write_archive
