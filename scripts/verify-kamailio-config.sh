#!/usr/bin/env bash
set -euo pipefail

image="${CONVERACT_FABRIC_KAMAILIO_IMAGE:?CONVERACT_FABRIC_KAMAILIO_IMAGE is required}"
config_dir="${CONVERACT_FABRIC_KAMAILIO_CONFIG_DIR:?CONVERACT_FABRIC_KAMAILIO_CONFIG_DIR is required}"
secrets_dir="${CONVERACT_FABRIC_KAMAILIO_SECRETS_DIR:?CONVERACT_FABRIC_KAMAILIO_SECRETS_DIR is required}"
state_dir="${CONVERACT_FABRIC_KAMAILIO_STATE_DIR:?CONVERACT_FABRIC_KAMAILIO_STATE_DIR is required}"

if [[ ! "${image}" =~ @sha256:[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'CONVERACT_FABRIC_KAMAILIO_IMAGE must be pinned by @sha256:<64 lowercase hex>' >&2
  exit 1
fi

for file in \
  "${config_dir}/kamailio.cfg" \
  "${config_dir}/tls.cfg" \
  "${state_dir}/dispatcher.list"; do
  if [[ ! -f "${file}" ]]; then
    printf 'required Kamailio validation file is missing: %s\n' "${file}" >&2
    exit 1
  fi
done

# Executes: kamailio -c -f /etc/kamailio/kamailio.cfg
docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --volume "${config_dir}:/etc/kamailio:ro" \
  --volume "${secrets_dir}:/run/secrets:ro" \
  --volume "${state_dir}:/var/lib/kamailio:ro" \
  --entrypoint /opt/kamailio/sbin/kamailio \
  "${image}" -c -f /etc/kamailio/kamailio.cfg
