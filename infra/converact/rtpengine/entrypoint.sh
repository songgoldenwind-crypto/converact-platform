#!/bin/sh
set -eu

entrypoint_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
compat_helper=/usr/local/lib/converact-env-compat.sh
if [ ! -r "$compat_helper" ]; then
  compat_helper="$entrypoint_dir/converact-env-compat.sh"
fi
if [ ! -r "$compat_helper" ]; then
  compat_helper="$entrypoint_dir/../../../scripts/converact-env-compat.sh"
fi
if [ ! -r "$compat_helper" ]; then
  echo "Converact environment compatibility helper is required" >&2
  exit 66
fi
# shellcheck disable=SC1090
. "$compat_helper"
for suffix in \
  RTPENGINE_RUNTIME_DIR \
  RTPENGINE_CONFIG_TEMPLATE \
  RTPENGINE_CONFIG_PATH \
  RTPENGINE_RUNTIME_MODE \
  RTPENGINE_OWNER_GUARD \
  RTPENGINE_INTERFACE \
  RTPENGINE_LISTEN_NG \
  RTPENGINE_LISTEN_TCP_NG \
  RTPENGINE_LISTEN_HTTP \
  RTPENGINE_PORT_MIN \
  RTPENGINE_PORT_MAX \
  RTPENGINE_RECORDING_DIR \
  RTPENGINE_KERNEL_TABLE; do
  converact_env_resolve_fabric "$suffix"
done

runtime_dir="${CONVERACT_FABRIC_RTPENGINE_RUNTIME_DIR:-/run/converact-rtpengine}"
config_template="${CONVERACT_FABRIC_RTPENGINE_CONFIG_TEMPLATE:-/etc/converact/rtpengine.conf.template}"
config_path="${CONVERACT_FABRIC_RTPENGINE_CONFIG_PATH:-${runtime_dir}/rtpengine.conf}"
requested_mode="${CONVERACT_FABRIC_RTPENGINE_RUNTIME_MODE:-auto}"
IVEKIT_RTPENGINE_OWNER_GUARD="${CONVERACT_FABRIC_RTPENGINE_OWNER_GUARD:-true}"
kernel_srcversion_path="/sys/module/nft_rtpengine/srcversion"
expected_kernel_srcversion_path="/usr/share/converact-rtpengine/kernel/module-srcversion"
expected_kernel_srcversion=""
if [ -r "${expected_kernel_srcversion_path}" ]; then
  expected_kernel_srcversion="$(
    tr -d '\r\n' < "${expected_kernel_srcversion_path}"
  )"
  case "${expected_kernel_srcversion}" in
    *[!A-Fa-f0-9]*|'')
      echo "invalid kernel identity embedded in runtime image" >&2
      exit 78
      ;;
  esac
fi

case "${requested_mode}" in
  userspace|kernel|auto) ;;
  *)
    echo "invalid CONVERACT_FABRIC_RTPENGINE_RUNTIME_MODE: expected userspace, kernel, or auto" >&2
    exit 64
    ;;
esac

kernel_identity_matches=false
if [ -n "${expected_kernel_srcversion}" ] \
    && [ -r "${kernel_srcversion_path}" ]; then
  loaded_kernel_srcversion="$(tr -d '\r\n' < "${kernel_srcversion_path}")"
  if [ "${loaded_kernel_srcversion}" = "${expected_kernel_srcversion}" ]; then
    kernel_identity_matches=true
  fi
fi

IVEKIT_RTPENGINE_USERSPACE_FALLBACK=false
case "${requested_mode}" in
  userspace)
    resolved_mode=userspace
    ;;
  kernel)
    if [ "${kernel_identity_matches}" != true ]; then
      echo "kernel mode refused: loaded nft_rtpengine identity does not match image metadata" >&2
      exit 78
    fi
    resolved_mode=kernel
    ;;
  auto)
    if [ "${kernel_identity_matches}" = true ]; then
      resolved_mode=kernel
    else
      resolved_mode=userspace
      IVEKIT_RTPENGINE_USERSPACE_FALLBACK=true
      echo "nft_rtpengine identity unavailable or mismatched; using userspace relay" >&2
    fi
    ;;
esac

IVEKIT_RTPENGINE_RUNTIME_MODE="${resolved_mode}"
export IVEKIT_RTPENGINE_RUNTIME_MODE
export IVEKIT_RTPENGINE_OWNER_GUARD
export IVEKIT_RTPENGINE_USERSPACE_FALLBACK

if [ ! -d "${runtime_dir}" ] || [ ! -w "${runtime_dir}" ]; then
  echo "RTPengine runtime directory must be a writable tmpfs or volume: ${runtime_dir}" >&2
  exit 73
fi
if [ ! -r "${config_template}" ]; then
  echo "RTPengine config template is not readable: ${config_template}" >&2
  exit 66
fi

interface="${CONVERACT_FABRIC_RTPENGINE_INTERFACE:-public/127.0.0.1}"
listen_ng="${CONVERACT_FABRIC_RTPENGINE_LISTEN_NG:-0.0.0.0:22222}"
listen_tcp_ng="${CONVERACT_FABRIC_RTPENGINE_LISTEN_TCP_NG:-0.0.0.0:22222}"
listen_http="${CONVERACT_FABRIC_RTPENGINE_LISTEN_HTTP:-0.0.0.0:8080}"
port_min="${CONVERACT_FABRIC_RTPENGINE_PORT_MIN:-23000}"
port_max="${CONVERACT_FABRIC_RTPENGINE_PORT_MAX:-32768}"
recording_dir="${CONVERACT_FABRIC_RTPENGINE_RECORDING_DIR:-/rec}"
table=-1
if [ "${resolved_mode}" = kernel ]; then
  table="${CONVERACT_FABRIC_RTPENGINE_KERNEL_TABLE:-0}"
fi

safe_config_value() {
  case "$2" in
    *[!A-Za-z0-9_.,:/!-]*|'')
      echo "invalid RTPengine config value for $1" >&2
      exit 65
      ;;
  esac
}

safe_config_value interface "${interface}"
safe_config_value listen_ng "${listen_ng}"
safe_config_value listen_tcp_ng "${listen_tcp_ng}"
safe_config_value listen_http "${listen_http}"
safe_config_value port_min "${port_min}"
safe_config_value port_max "${port_max}"
safe_config_value recording_dir "${recording_dir}"
safe_config_value table "${table}"

umask 077
config_tmp="${config_path}.tmp.$$"
trap 'rm -f "${config_tmp}"' EXIT HUP INT TERM
sed \
  -e "s|__INTERFACE__|${interface}|g" \
  -e "s|__LISTEN_NG__|${listen_ng}|g" \
  -e "s|__LISTEN_TCP_NG__|${listen_tcp_ng}|g" \
  -e "s|__LISTEN_HTTP__|${listen_http}|g" \
  -e "s|__PORT_MIN__|${port_min}|g" \
  -e "s|__PORT_MAX__|${port_max}|g" \
  -e "s|__RECORDING_DIR__|${recording_dir}|g" \
  -e "s|__TABLE__|${table}|g" \
  "${config_template}" > "${config_tmp}"
mv "${config_tmp}" "${config_path}"
trap - EXIT HUP INT TERM

cat > "${runtime_dir}/runtime.prom" <<EOF
converact_rtpengine_userspace_fallback{reason="kernel_identity_unavailable"} $(
  [ "${IVEKIT_RTPENGINE_USERSPACE_FALLBACK}" = true ] && printf 1 || printf 0
)
converact_rtpengine_runtime_identity{runtime_mode="${resolved_mode}"} 1
EOF
printf '%s\n' \
  "runtime_mode=${resolved_mode}" \
  "userspace_fallback=${IVEKIT_RTPENGINE_USERSPACE_FALLBACK}" \
  > "${runtime_dir}/runtime.identity"

exec /usr/local/bin/rtpengine --config-file "${config_path}" "$@"
