#!/usr/bin/env bash
# End-to-end dev smoke: requires OPC HTTP on :3000 and optional RustPBX on :8080
set -euo pipefail

BASE_URL="${OPC_BASE_URL:-http://localhost:3000}"
RWI_URL="${RUSTPBX_RWI_URL:-ws://localhost:8080/rwi}"
API_KEY="${OPC_API_KEY:-}"
WEBHOOK_KEY="${RUSTPBX_WEBHOOK_KEY:-}"

headers=(-H "Content-Type: application/json")
if [[ -n "$API_KEY" ]]; then headers+=(-H "X-API-Key: $API_KEY"); fi
if [[ -n "$WEBHOOK_KEY" ]]; then headers+=(-H "X-RustPBX-Webhook-Key: $WEBHOOK_KEY"); fi

echo "==> Health: call-router inbound"
curl -sS "${headers[@]}" -X POST "$BASE_URL/api/call-router" \
  -d '{"direction":"inbound","from":"+8613800138000","to":"+862112345678","call_id":"e2e-in-1"}' | jq .

echo "==> IVR digit 1"
curl -sS "${headers[@]}" -X POST "$BASE_URL/api/call-center/ivr/route" \
  -d '{"menu_id":"default","digit":"1"}' | jq .

echo "==> Voicemail webhook ingest"
curl -sS "${headers[@]}" -X POST "$BASE_URL/api/webhooks/voicemail-recording" \
  -d '{
    "tenant_id":"default",
    "from_number":"+8613800138000",
    "mailbox":"default",
    "recording_url":"https://example.com/vm.ogg",
    "duration_sec": 12
  }' | jq .

if command -v websocat >/dev/null 2>&1; then
  echo "==> RWI websocket probe (1s)"
  timeout 1 websocat -n1 "$RWI_URL" <<< '{"request_id":"probe","command":"hold","params":{"call_id":"probe"}}' || true
else
  echo "(skip RWI probe: install websocat for WS check)"
fi

echo "E2E smoke finished."
