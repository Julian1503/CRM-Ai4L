"""Signed HTTP client for the CRM worker endpoints (protocol v1).

POST {CRM_BASE_URL}/api/internal/content-worker/v1/{op}. Every request is signed over
the exact body bytes sent (app.signing). Response bodies are never logged: a context
response for publish_social carries a decrypted access token.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from app import signing
from app.contracts import (
    ClaimedJob,
    FailOutcome,
    JobKind,
    WorkerAckResponse,
    WorkerBeginDispatchResponse,
    WorkerClaimResponse,
    WorkerHeartbeatResponse,
    parse_job_context,
)

logger = logging.getLogger(__name__)

API_PREFIX = "/api/internal/content-worker/v1"


class CrmError(RuntimeError):
    """The CRM bridge did not give a usable answer."""

    def __init__(self, message: str, *, status: int | None = None, retryable: bool = True) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable


def encode_body(payload: dict[str, Any]) -> bytes:
    """Compact, deterministic JSON — the bytes that are both signed and sent."""
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class CrmClient:
    def __init__(
        self,
        base_url: str,
        secret: str,
        *,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._base_path = urlsplit(self._base_url).path.rstrip("/")
        self._secret = secret
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _post(self, op: str, payload: dict[str, Any]) -> dict[str, Any]:
        path = f"{self._base_path}{API_PREFIX}/{op}"
        body = encode_body(payload)
        headers = {
            "Content-Type": "application/json",
            **signing.signed_headers(self._secret, "POST", path, body),
        }
        try:
            response = await self._client.post(
                f"{self._base_url}{API_PREFIX}/{op}", content=body, headers=headers
            )
        except httpx.HTTPError as exc:
            raise CrmError(f"CRM {op} unreachable ({type(exc).__name__})") from None
        if response.status_code >= 500:
            raise CrmError(f"CRM {op} answered HTTP {response.status_code}", status=response.status_code)
        if response.is_error:
            # 4xx: authentication, validation or a refused state change. Retrying the
            # same bytes will not help; the body may be logged, it never holds a token.
            raise CrmError(
                f"CRM {op} refused the request (HTTP {response.status_code}): {_error_text(response)}",
                status=response.status_code,
                retryable=False,
            )
        try:
            data = response.json()
        except ValueError:
            raise CrmError(f"CRM {op} returned a non-JSON body") from None
        if not isinstance(data, dict):
            raise CrmError(f"CRM {op} returned an unexpected body")
        return data

    async def claim(
        self, worker_id: str, kinds: list[JobKind], limit: int, lease_seconds: int
    ) -> list[ClaimedJob]:
        data = await self._post(
            "claim",
            {"workerId": worker_id, "kinds": list(kinds), "limit": limit, "leaseSeconds": lease_seconds},
        )
        return list(WorkerClaimResponse.model_validate(data).jobs)

    async def heartbeat(self, job_id: str, claim_token: str) -> str:
        data = await self._post("heartbeat", {"jobId": job_id, "claimToken": claim_token})
        return WorkerHeartbeatResponse.model_validate(data).state

    async def context(self, job_id: str, claim_token: str):  # noqa: ANN201 - union of context models
        data = await self._post("context", {"jobId": job_id, "claimToken": claim_token})
        return parse_job_context(data)

    async def checkpoint(self, job_id: str, claim_token: str, checkpoint: dict[str, Any]) -> bool:
        data = await self._post(
            "checkpoint", {"jobId": job_id, "claimToken": claim_token, "checkpoint": checkpoint}
        )
        return WorkerAckResponse.model_validate(data).accepted

    async def begin_dispatch(self, job_id: str, claim_token: str) -> str:
        data = await self._post("begin-dispatch", {"jobId": job_id, "claimToken": claim_token})
        return WorkerBeginDispatchResponse.model_validate(data).decision

    async def complete(self, job_id: str, claim_token: str, result: dict[str, Any]) -> bool:
        data = await self._post("complete", {"jobId": job_id, "claimToken": claim_token, "result": result})
        return WorkerAckResponse.model_validate(data).accepted

    async def fail(
        self,
        job_id: str,
        claim_token: str,
        *,
        outcome: FailOutcome,
        error_code: str,
        message: str,
        provider_request_id: str | None = None,
    ) -> bool:
        payload: dict[str, Any] = {
            "jobId": job_id,
            "claimToken": claim_token,
            "outcome": outcome,
            "errorCode": error_code[:80],
            "message": message[:1000],
        }
        if provider_request_id:
            payload["providerRequestId"] = provider_request_id
        data = await self._post("fail", payload)
        return WorkerAckResponse.model_validate(data).accepted


def _error_text(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return "no detail"
    if isinstance(data, dict) and isinstance(data.get("error"), str):
        return data["error"][:300]
    return "no detail"
