#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/converact-env-compat.sh"
converact_env_install_aliases

BASE_URL="${CONVERACT_BASE_URL:-http://localhost:3000}"
API_KEY="${CONVERACT_API_KEY:-}"

headers=(-H "Content-Type: application/json")
if [[ -n "$API_KEY" ]]; then
  headers+=(-H "X-API-Key: $API_KEY")
fi

echo "==> IVR route (digit 1 -> sales queue)"
curl -sS "${headers[@]}" -X POST "$BASE_URL/api/call-center/ivr/route" \
  -d '{"menu_id":"default","digit":"1"}' | jq .

echo "==> Call router inbound smoke"
curl -sS "${headers[@]}" -X POST "$BASE_URL/api/call-router" \
  -d '{
    "direction":"inbound",
    "from":"+8613800138000",
    "to":"+862112345678",
    "call_id":"smoke-inbound-1"
  }' | jq .

echo "==> Call router outbound smoke"
curl -sS "${headers[@]}" -X POST "$BASE_URL/api/call-router" \
  -d '{
    "direction":"outbound",
    "from":"+862112345678",
    "to":"+8613800138000",
    "call_id":"smoke-outbound-1"
  }' | jq .

echo "Smoke requests sent."
