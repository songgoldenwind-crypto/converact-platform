#!/bin/sh

_converact_env_resolve() {
  converact_env_scope=$1
  converact_env_current_prefix=$2
  converact_env_legacy_prefix=$3
  converact_env_suffix=$4

  case "$converact_env_suffix" in
    ''|[0-9_]*|*[!A-Z0-9_]*)
      printf 'invalid branded environment variable suffix: %s\n' "$converact_env_suffix" >&2
      return 64
      ;;
  esac

  converact_env_current_key="${converact_env_current_prefix}${converact_env_suffix}"
  converact_env_legacy_key="${converact_env_legacy_prefix}${converact_env_suffix}"
  eval "converact_env_has_current=\${${converact_env_current_key}+x}"
  eval "converact_env_has_legacy=\${${converact_env_legacy_key}+x}"
  eval "converact_env_current_value=\${${converact_env_current_key}-}"
  eval "converact_env_legacy_value=\${${converact_env_legacy_key}-}"

  if [ "$converact_env_has_current" = x ] &&
    [ "$converact_env_has_legacy" = x ] &&
    [ "$converact_env_current_value" != "$converact_env_legacy_value" ]; then
    printf '{"event":"converact.config.environment_conflict","message":"conflicting branded environment variables","scope":"%s","current_key":"%s","legacy_key":"%s"}\n' \
      "$converact_env_scope" "$converact_env_current_key" "$converact_env_legacy_key" >&2
    return 78
  fi

  if [ "$converact_env_has_current" != x ] && [ "$converact_env_has_legacy" = x ]; then
    export "$converact_env_current_key=$converact_env_legacy_value"
    printf '{"event":"converact.config.deprecated_environment_key","scope":"%s","current_key":"%s","legacy_key":"%s"}\n' \
      "$converact_env_scope" "$converact_env_current_key" "$converact_env_legacy_key" >&2
  fi
}

converact_env_resolve_brand() {
  _converact_env_resolve brand CONVERACT_ OPC_ "$1"
}

converact_env_resolve_fabric() {
  _converact_env_resolve fabric CONVERACT_FABRIC_ OPC_IVEKIT_ "$1" || return
  _converact_env_resolve fabric CONVERACT_FABRIC_ IVEKIT_ "$1"
}

converact_env_install_aliases() {
  for converact_env_key in $(env | sed 's/=.*//'); do
    case "$converact_env_key" in
      CONVERACT_FABRIC_*)
        converact_env_suffix=${converact_env_key#CONVERACT_FABRIC_}
        converact_env_resolve_fabric "$converact_env_suffix" || return
        ;;
      OPC_IVEKIT_*)
        converact_env_suffix=${converact_env_key#OPC_IVEKIT_}
        converact_env_resolve_fabric "$converact_env_suffix" || return
        ;;
      IVEKIT_*)
        converact_env_suffix=${converact_env_key#IVEKIT_}
        converact_env_resolve_fabric "$converact_env_suffix" || return
        ;;
      CONVERACT_*)
        converact_env_suffix=${converact_env_key#CONVERACT_}
        converact_env_resolve_brand "$converact_env_suffix" || return
        ;;
      OPC_*)
        converact_env_suffix=${converact_env_key#OPC_}
        converact_env_resolve_brand "$converact_env_suffix" || return
        ;;
    esac
  done
}
