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

validate_value() {
  name=$1
  value=$2
  [ -n "$value" ] || { printf '%s\n' "$name is required" >&2; exit 64; }
  case "$value" in *[!A-Za-z0-9._:@/-]*) printf '%s\n' "$name contains unsupported characters" >&2; exit 64 ;; esac
}

[ "$mode" = 'validate' ] || [ "$mode" = 'execute' ] || { printf '%s\n' 'mode must be validate or execute' >&2; exit 64; }
validate_value external_id "$external_id"
validate_value target_id "$target_id"
validate_value rustdesk_id "$rustdesk_id"
case "$reason" in consent_revoked|remote_session_ended|tool_ended|gateway_ended) ;; *) printf '%s\n' 'unsupported disconnect reason' >&2; exit 64 ;; esac

hook=${OPC_RUSTDESK_SESSION_DISCONNECT_HOOK-}
available=false
if [ -n "$hook" ] && [ "${hook#/}" != "$hook" ] && [ -x "$hook" ]; then available=true; fi

if [ "$mode" = 'validate' ]; then
  printf '{"adapter":"macos-session-hook","mode":"validate","available":%s,"targeted":true}\n' "$available"
  exit 0
fi

[ "$available" = true ] || { printf '%s\n' 'session-specific disconnect hook is not configured' >&2; exit 20; }
exec "$hook" --external-id "$external_id" --target-id "$target_id" --rustdesk-id "$rustdesk_id" --reason "$reason"
