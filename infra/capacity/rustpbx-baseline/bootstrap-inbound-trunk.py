#!/usr/bin/env python3
import json
import os
import time
import urllib.error
import urllib.request


BASE_URL = os.environ["RUSTPBX_BASE_URL"].rstrip("/")
TOKEN = os.environ["RUSTPBX_MANAGEMENT_TOKEN"]
TRUNK_CREDENTIAL = os.environ["RUSTPBX_TRUNK_CREDENTIAL"]
UAC_IP = os.environ["RUSTPBX_ACCEPTANCE_UAC_IP"]


def request(path: str, method: str, payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json", "Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    response = urllib.request.urlopen(
        urllib.request.Request(BASE_URL + path, data=body, method=method, headers=headers),
        timeout=5,
    )
    raw = response.read()
    return json.loads(raw) if raw else {}


for attempt in range(60):
    try:
        request("/api/pending-reloads", "GET")
        break
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        if attempt == 59:
            raise
        time.sleep(0.5)

trunk = request(
    "/api/sip-trunk",
    "PUT",
    {
        "name": "ivekit-capacity-sipp",
        "display_name": "iveKit capacity SIPp",
        "status": "healthy",
        "direction": "inbound",
        "sip_transport": "udp",
        "max_concurrent": 100000,
        "auth_password": TRUNK_CREDENTIAL,
        "is_active": True,
        "sip_server": f"{UAC_IP}:5060",
        "allowed_ips": json.dumps([UAC_IP]),
        "metadata": json.dumps({"purpose": "capacity_baseline"}),
    },
)
request("/ami/v1/reload/trunks", "POST")
print(json.dumps({"status": "ready", "trunk_id": str(trunk.get("id", "created"))}))

