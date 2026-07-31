#!/bin/sh
set -eu

mode=''
external_id=''
target_id=''
rustdesk_id=''
reason=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode=${2-}; shift 2 ;;
    --external-id) external_id=${2-}; shift 2 ;;
    --target-id) target_id=${2-}; shift 2 ;;
    --rustdesk-id) rustdesk_id=${2-}; shift 2 ;;
    --reason) reason=${2-}; shift 2 ;;
    *) printf '%s\n' "unsupported argument: $1" >&2; exit 64 ;;
  esac
done

[ "$mode" = 'validate' ] || [ "$mode" = 'execute' ] || { printf '%s\n' 'mode must be validate or execute' >&2; exit 64; }
for pair in "external_id:$external_id" "target_id:$target_id" "rustdesk_id:$rustdesk_id"; do
  name=${pair%%:*}; value=${pair#*:}
  [ -n "$value" ] || { printf '%s\n' "$name is required" >&2; exit 64; }
  case "$value" in *[!A-Za-z0-9._:@/-]*) printf '%s\n' "$name contains unsupported characters" >&2; exit 64 ;; esac
done
case "$reason" in consent_revoked|remote_session_ended|tool_ended|gateway_ended) ;; *) printf '%s\n' 'unsupported disconnect reason' >&2; exit 64 ;; esac

label=${OPC_RUSTDESK_LAUNCHD_LABEL-com.carriez.RustDesk_service}
case "$label" in ''|*[!A-Za-z0-9._-]*) printf '%s\n' 'invalid RustDesk launchd label' >&2; exit 64 ;; esac
available=false
if command -v launchctl >/dev/null 2>&1 && launchctl print "system/$label" >/dev/null 2>&1; then available=true; fi

if [ "$mode" = 'validate' ]; then
  printf '{"adapter":"macos-service-restart","mode":"validate","available":%s,"targeted":false,"collateral_sessions_may_disconnect":true}\n' "$available"
  exit 0
fi
[ "$available" = true ] || { printf '%s\n' 'RustDesk launchd service is unavailable' >&2; exit 21; }
launchctl kickstart -k "system/$label"
launchctl print "system/$label" >/dev/null
printf '{"adapter":"macos-service-restart","mode":"execute","status":"succeeded","targeted":false,"collateral_sessions_may_disconnect":true}\n'
