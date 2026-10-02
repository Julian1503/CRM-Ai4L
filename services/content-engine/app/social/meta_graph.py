"""Meta Graph API transport and error taxonomy. Ported from WRCC ``publishing/meta_graph.py``.

Change from WRCC: errors now say whether they came from a *structured* Graph error
payload (Meta told us what went wrong) or not (non-JSON body, HTTP error without a
payload). On the one call that publishes, only a structured, non-transient rejection
proves nothing went live; everything else is reported as uncertain.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.redact import redact


class MetaGraphError(RuntimeError):
    """A Graph call failed. ``structured`` is True when Graph returned an error payload."""

    def __init__(
        self, message: str, *, code: int | None = None, status: int | None = None, structured: bool = True
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.structured = structured


class MetaAuthError(MetaGraphError):
    """Token invalid/expired/insufficient — the connection must be re-authorised."""


class MetaRateLimitError(MetaGraphError):
    """Application or user rate limit hit."""


class MetaTransientError(MetaGraphError):
    """A temporary Graph failure (API Unknown / Service), or an unreadable response."""


_AUTH_CODES = frozenset({102, 190, 200, 459, 463, 464, 467})
_RATE_LIMIT_CODES = frozenset({4, 17, 32, 613})
_TRANSIENT_CODES = frozenset({1, 2})


def redact_access_token(text: str) -> str:
    """Kept for callers ported from WRCC; ``app.redact.redact`` covers more parameters."""
    return redact(text)


def raise_for_graph_error(payload: Any, *, status: int | None = None) -> None:
    if not isinstance(payload, dict):
        return
    error = payload.get("error")
    if not isinstance(error, dict):
        return
    code = error.get("code")
    code_int = int(code) if isinstance(code, int | str) and str(code).isdigit() else None
    message = redact(str(error.get("message") or "Meta Graph API error"))
    if code_int in _AUTH_CODES:
        raise MetaAuthError(message, code=code_int, status=status)
    if code_int in _RATE_LIMIT_CODES:
        raise MetaRateLimitError(message, code=code_int, status=status)
    if code_int in _TRANSIENT_CODES:
        raise MetaTransientError(message, code=code_int, status=status)
    raise MetaGraphError(message, code=code_int, status=status)


class GraphClient:
    """Thin async Graph client. ``transport`` is the test seam (httpx.MockTransport)."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float,
        access_token: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        self._access_token = access_token
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=self._timeout)

    def _with_token(self, params: dict | None) -> dict:
        merged = dict(params or {})
        if self._access_token is not None:
            merged.setdefault("access_token", self._access_token)
        return merged

    async def get(self, path: str, *, params: dict | None = None) -> dict:
        async with self._client() as client:
            response = await client.get(f"{self._base}{path}", params=self._with_token(params))
        return self._payload(response)

    async def post(self, path: str, *, data: dict | None = None) -> dict:
        async with self._client() as client:
            response = await client.post(f"{self._base}{path}", data=self._with_token(data))
        return self._payload(response)

    def _payload(self, response: httpx.Response) -> dict:
        """Map Graph error payloads before HTTP status: the payload carries the reason."""
        try:
            payload = response.json()
        except ValueError:
            raise MetaTransientError(
                f"Graph returned HTTP {response.status_code} with a non-JSON body.",
                status=response.status_code,
                structured=False,
            ) from None
        raise_for_graph_error(payload, status=response.status_code)
        if response.is_error:
            raise MetaTransientError(
                f"Graph returned HTTP {response.status_code} without an error payload.",
                status=response.status_code,
                structured=False,
            )
        if not isinstance(payload, dict):
            raise MetaTransientError("Graph returned an unexpected body.", structured=False)
        return payload
