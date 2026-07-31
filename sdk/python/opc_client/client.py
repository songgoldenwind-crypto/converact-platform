"""Minimal OPC Call Center Python SDK (Sprint 10)."""

from __future__ import annotations

from typing import Any

import httpx


class OpcClient:
    def __init__(self, base_url: str, api_key: str, tenant_id: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.tenant_id = tenant_id
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=timeout,
            headers={"X-API-Key": api_key, "X-Tenant-Id": tenant_id},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "OpcClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        res = self._client.request(method, path, **kwargs)
        res.raise_for_status()
        data = res.json()
        return data.get("data", data)

    def list_campaigns(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/call-center/campaigns")

    def create_campaign(self, name: str, agent_spec_id_a: str, **extra: Any) -> dict[str, Any]:
        body = {"name": name, "agent_spec_id_a": agent_spec_id_a, **extra}
        return self._request("POST", "/api/call-center/campaigns", json=body)

    def list_inbox(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/call-center/omni/inbox")

    def get_journey(self, phone: str | None = None, email: str | None = None) -> list[dict[str, Any]]:
        params: dict[str, str] = {}
        if phone:
            params["phone"] = phone
        if email:
            params["email"] = email
        return self._request("GET", "/api/call-center/journey/unified", params=params)

    def knowledge_analytics(self, days: int = 30) -> dict[str, Any]:
        return self._request("GET", f"/api/knowledge/analytics?tenant_id={self.tenant_id}&days={days}")

    def create_webhook(self, url: str, events: list[str]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/webhooks/subscriptions",
            json={"tenant_id": self.tenant_id, "url": url, "events": events},
        )

    def batch_analyze_recordings(self, **filters: Any) -> dict[str, Any]:
        return self._request("POST", "/api/call-center/recordings/batch-analyze", json=filters)
